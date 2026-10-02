import { constants as fsConstants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { runCapturedCommand } from "../processes/run-command.js";
import type {
  GeminiBinaryProbeResult,
  GeminiCliFeatures,
} from "./types.js";

const PROBE_CACHE_TTL_MS = 5 * 60_000;
const PROBE_CACHE_MAX = 24;
const probeCache = new Map<string, { expiresAt: number; result: GeminiBinaryProbeResult }>();

export interface GeminiBinaryProbeInput {
  readonly candidate?: string;
  readonly force?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly platform?: NodeJS.Platform;
}

export async function probeGeminiBinary(
  input: GeminiBinaryProbeInput = {},
): Promise<GeminiBinaryProbeResult> {
  const candidate = input.candidate?.trim() || "gemini";
  const environment = input.environment ?? process.env;
  const platform = input.platform ?? process.platform;

  let binaryPath: string;
  try {
    binaryPath = await resolveExecutable(candidate, environment, platform);
  } catch (error) {
    return {
      ok: false,
      candidate,
      code: "binary_not_found",
      message: error instanceof Error ? error.message : "Gemini CLI was not found",
    };
  }

  try {
    const launch = await resolveGeminiLaunch(binaryPath, environment, platform);
    const cacheKey = await getCacheKey(binaryPath, launch, platform);
    const cached = probeCache.get(cacheKey);
    if (!input.force && cached && cached.expiresAt > Date.now()) {
      probeCache.delete(cacheKey);
      probeCache.set(cacheKey, cached);
      return cached.result;
    }

    const [versionResult, helpResult] = await Promise.all([
      runCapturedCommand({
        binaryPath: launch.executablePath,
        args: [...launch.executableArgs, "--version"],
        environment,
        timeoutMs: input.timeoutMs,
      }),
      runCapturedCommand({
        binaryPath: launch.executablePath,
        args: [...launch.executableArgs, "--help"],
        environment,
        timeoutMs: input.timeoutMs,
      }),
    ]);
    if (versionResult.timedOut || versionResult.exitCode !== 0) {
      return failedProbe(
        candidate,
        `gemini --version failed${formatExit(versionResult.exitCode, versionResult.timedOut)}`,
      );
    }

    const rawVersion = `${versionResult.stdout}\n${versionResult.stderr}`.trim();
    const version = parseGeminiVersion(rawVersion);
    if (!version) {
      return failedProbe(candidate, `Could not parse Gemini CLI version from: ${rawVersion}`);
    }

    if (helpResult.timedOut || helpResult.exitCode !== 0) {
      return failedProbe(
        candidate,
        `gemini --help failed${formatExit(helpResult.exitCode, helpResult.timedOut)}`,
      );
    }

    const help = `${helpResult.stdout}\n${helpResult.stderr}`;
    const features = detectGeminiCliFeatures(help);
    if (!features.acp || !features.skipTrust) {
      return {
        ok: false,
        candidate,
        code: "acp_unsupported",
        message: !features.acp
          ? `Gemini CLI ${version} does not advertise the required ACP flag`
          : `Gemini CLI ${version} does not advertise the required --skip-trust flag`,
      };
    }

    const result: GeminiBinaryProbeResult = {
      ok: true,
      binaryPath,
      executablePath: launch.executablePath,
      executableArgs: launch.executableArgs,
      version,
      rawVersion,
      features,
    };
    cacheProbe(cacheKey, result);
    return result;
  } catch (error) {
    return failedProbe(
      candidate,
      error instanceof Error ? error.message : "Gemini CLI probe failed",
    );
  }
}

export function parseGeminiVersion(value: string): string | undefined {
  return value.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1];
}

export function detectGeminiCliFeatures(help: string): GeminiCliFeatures {
  const hasFlag = (flag: string): boolean =>
    new RegExp(`(^|[\\s,])${escapeRegExp(flag)}(?=[=\\s,]|$)`, "m").test(help);

  const acpFlag = hasFlag("--acp")
    ? "--acp"
    : hasFlag("--experimental-acp")
      ? "--experimental-acp"
      : null;
  return {
    acp: acpFlag !== null,
    acpFlag,
    skipTrust: hasFlag("--skip-trust"),
    includeDirectories: hasFlag("--include-directories"),
    resume: hasFlag("--resume"),
    listSessions: hasFlag("--list-sessions"),
    deleteSession: hasFlag("--delete-session"),
    approvalMode: hasFlag("--approval-mode"),
  };
}

function cacheProbe(key: string, result: GeminiBinaryProbeResult): void {
  probeCache.delete(key);
  probeCache.set(key, { result, expiresAt: Date.now() + PROBE_CACHE_TTL_MS });
  while (probeCache.size > PROBE_CACHE_MAX) {
    const oldest = probeCache.keys().next().value as string | undefined;
    if (!oldest) break;
    probeCache.delete(oldest);
  }
}

async function getCacheKey(
  binaryPath: string,
  launch: GeminiLaunchCommand,
  platform: NodeJS.Platform,
): Promise<string> {
  const paths = [binaryPath, launch.executablePath, ...launch.executableArgs];
  const facts = await Promise.all(paths.map(async (file) => {
    try {
      const resolved = await realpath(file);
      const details = await stat(resolved);
      return `${resolved}:${details.size}:${details.mtimeMs}`;
    } catch {
      return file;
    }
  }));
  return `${platform}|${facts.join("|")}`;
}

export async function resolveExecutable(
  candidate: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (candidate.includes("/") || candidate.includes("\\") || path.isAbsolute(candidate)) {
    return verifyExecutable(path.resolve(candidate), platform);
  }

  const pathValue = environment.PATH ?? environment.Path ?? environment.path ?? "";
  const extensions =
    platform === "win32"
      ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];

  const pathSeparator = platform === "win32" ? ";" : path.delimiter;
  const directories = [
    ...pathValue.split(pathSeparator),
    ...defaultExecutableDirectories(environment, platform),
  ];
  for (const directory of new Set(directories)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const suffix =
        platform === "win32" && !candidate.toLowerCase().endsWith(extension.toLowerCase())
          ? extension
          : "";
      try {
        return await verifyExecutable(path.join(directory, `${candidate}${suffix}`), platform);
      } catch {
        // Continue searching PATH.
      }
    }
  }

  throw new Error(`Could not find ${candidate} on PATH`);
}

export interface GeminiLaunchCommand {
  readonly executablePath: string;
  readonly executableArgs: readonly string[];
  readonly acpFlag?: "--acp" | "--experimental-acp";
}

/**
 * Resolve npm's Windows `gemini.cmd` without invoking cmd.exe or a shell.
 * The shim itself is never parsed or executed: only the declared bin entry of
 * the adjacent, verified @google/gemini-cli package is passed to node.exe.
 */
export async function resolveGeminiLaunch(
  binaryPath: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<GeminiLaunchCommand> {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(binaryPath)) {
    // npm's POSIX launcher is a symlink to a JavaScript file. Finder-launched
    // apps do not inherit Homebrew's PATH, so relying on `#!/usr/bin/env node`
    // would still fail after we found Gemini in /opt/homebrew/bin. Windows has
    // no shebang support at all: spawning a .js/.mjs/.cjs entry point directly
    // fails with EFTYPE, so every JavaScript entry point is launched via node.
    if (/\.(?:c|m)?js$/i.test(binaryPath)) {
      return {
        executablePath: await resolveExecutable("node", environment, platform),
        executableArgs: [binaryPath],
      };
    }
    return { executablePath: binaryPath, executableArgs: [] };
  }

  const packageRoot = path.join(
    path.dirname(binaryPath),
    "node_modules",
    "@google",
    "gemini-cli",
  );
  const packageRealPath = await realpath(packageRoot).catch(() => undefined);
  if (!packageRealPath) {
    throw new Error(
      "The selected Gemini .cmd shim has no adjacent @google/gemini-cli installation",
    );
  }

  const manifest = JSON.parse(
    await readFile(path.join(packageRealPath, "package.json"), "utf8"),
  ) as { name?: unknown; bin?: unknown };
  const binEntry =
    typeof manifest.bin === "string"
      ? manifest.bin
      : manifest.bin && typeof manifest.bin === "object"
        ? (manifest.bin as Record<string, unknown>).gemini
        : undefined;
  if (manifest.name !== "@google/gemini-cli" || typeof binEntry !== "string") {
    throw new Error("The selected .cmd shim is not a valid Gemini CLI npm installation");
  }

  const entryPath = await realpath(path.resolve(packageRealPath, binEntry));
  const relativeEntry = path.relative(packageRealPath, entryPath);
  if (
    relativeEntry.startsWith(`..${path.sep}`) ||
    relativeEntry === ".." ||
    path.isAbsolute(relativeEntry) ||
    !(await stat(entryPath)).isFile()
  ) {
    throw new Error("The Gemini CLI npm bin entry points outside its package");
  }

  const executablePath = await resolveExecutable("node", environment, platform);
  return { executablePath, executableArgs: [entryPath] };
}

function defaultExecutableDirectories(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (platform === "darwin") {
    return ["/opt/homebrew/bin", "/usr/local/bin"];
  }
  if (platform === "linux") {
    const home = environment.HOME;
    return ["/usr/local/bin", ...(home ? [path.join(home, ".local", "bin")] : [])];
  }
  if (platform === "win32") {
    return [
      ...(environment.APPDATA ? [path.join(environment.APPDATA, "npm")] : []),
      ...(environment.ProgramFiles
        ? [path.join(environment.ProgramFiles, "nodejs")]
        : []),
      ...(environment.LOCALAPPDATA
        ? [path.join(environment.LOCALAPPDATA, "Programs", "nodejs")]
        : []),
    ];
  }
  return [];
}

async function verifyExecutable(
  candidatePath: string,
  platform: NodeJS.Platform,
): Promise<string> {
  await access(
    candidatePath,
    platform === "win32" ? fsConstants.F_OK : fsConstants.F_OK | fsConstants.X_OK,
  );
  return realpath(candidatePath);
}

function failedProbe(
  candidate: string,
  message: string,
): GeminiBinaryProbeResult {
  return { ok: false, candidate, code: "binary_probe_failed", message };
}

function formatExit(exitCode: number | null, timedOut: boolean): string {
  return timedOut ? " (timed out)" : ` (exit ${String(exitCode)})`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
