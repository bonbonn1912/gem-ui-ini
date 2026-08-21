import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { runGitCommand } from "./git-command-runner";

export type GitBinaryProbeResult =
  | {
      ok: true;
      binaryPath: string;
      version: string;
      rawVersion: string;
    }
  | {
      ok: false;
      code: "binary_not_found" | "binary_probe_failed";
      message: string;
    };

export type GitBinaryProbeInput = {
  candidate?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
};

export async function probeGitBinary(
  input: GitBinaryProbeInput = {},
): Promise<GitBinaryProbeResult> {
  const environment = input.environment ?? process.env;
  const platform = input.platform ?? process.platform;
  const candidate = input.candidate?.trim();
  const paths = candidate
    ? [candidate]
    : gitCandidates(environment, platform);

  let binaryPath: string | null = null;
  for (const value of paths) {
    try {
      binaryPath = await verifyGitExecutable(value, platform);
      break;
    } catch {
      // Keep looking. Git is an optional capability.
    }
  }
  if (!binaryPath) {
    return {
      ok: false,
      code: "binary_not_found",
      message: "Git wurde nicht gefunden.",
    };
  }

  try {
    const result = await runGitCommand({
      binaryPath,
      args: ["--version"],
      environment,
      timeoutMs: input.timeoutMs ?? 3_000,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
      readOnly: true,
    });
    const rawVersion = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`.trim();
    const version = parseGitVersion(rawVersion);
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.aborted ||
      result.tooLarge ||
      !version
    ) {
      return {
        ok: false,
        code: "binary_probe_failed",
        message: "Die gefundene Git-Installation konnte nicht geprüft werden.",
      };
    }
    return { ok: true, binaryPath, version, rawVersion };
  } catch {
    return {
      ok: false,
      code: "binary_probe_failed",
      message: "Die gefundene Git-Installation konnte nicht gestartet werden.",
    };
  }
}

export function parseGitVersion(value: string): string | undefined {
  return value.match(/\bgit version\s+(\d+(?:\.\d+){1,3}(?:\.[0-9A-Za-z.-]+)?)/i)?.[1];
}

function gitCandidates(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const pathValue = environment.PATH ?? environment.Path ?? environment.path ?? "";
  const separator = platform === "win32" ? ";" : path.delimiter;
  const executable = platform === "win32" ? "git.exe" : "git";
  const fromPath = pathValue
    .split(separator)
    .filter(Boolean)
    .map((directory) => path.join(directory, executable));

  if (platform === "darwin") {
    return [
      ...fromPath,
      "/usr/bin/git",
      "/opt/homebrew/bin/git",
      "/usr/local/bin/git",
    ];
  }
  if (platform === "win32") {
    return [
      ...fromPath,
      ...(environment.ProgramFiles
        ? [
            path.join(environment.ProgramFiles, "Git", "cmd", "git.exe"),
            path.join(environment.ProgramFiles, "Git", "bin", "git.exe"),
          ]
        : []),
      ...(environment["ProgramFiles(x86)"]
        ? [path.join(environment["ProgramFiles(x86)"]!, "Git", "cmd", "git.exe")]
        : []),
      ...(environment.LOCALAPPDATA
        ? [
            path.join(environment.LOCALAPPDATA, "Programs", "Git", "cmd", "git.exe"),
            path.join(environment.LOCALAPPDATA, "GitHubDesktop", "app", "git", "cmd", "git.exe"),
          ]
        : []),
    ];
  }
  return [...fromPath, "/usr/bin/git", "/usr/local/bin/git"];
}

async function verifyGitExecutable(
  candidate: string,
  platform: NodeJS.Platform,
): Promise<string> {
  const absolute = path.resolve(candidate);
  if (platform === "win32" && path.extname(absolute).toLowerCase() !== ".exe") {
    throw new Error("Only native git.exe is supported on Windows");
  }
  await access(
    absolute,
    platform === "win32"
      ? fsConstants.F_OK
      : fsConstants.F_OK | fsConstants.X_OK,
  );
  const canonical = await realpath(absolute);
  if (!(await stat(canonical)).isFile()) {
    throw new Error("Git candidate is not a file");
  }
  return canonical;
}
