import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  GeminiSkillListSchema,
  ListAgentExtensionsInputSchema,
  MAX_GEMINI_SKILLS,
  MAX_MCP_SERVERS,
  MAX_MCP_SERVER_ARGS,
  MAX_MCP_SERVER_KEYS,
  McpServerListSchema,
  type AgentExtensionScope,
  type GeminiSkill,
  type GeminiSkillList,
  type ListAgentExtensionsInput,
  type McpServer,
  type McpServerList,
  type McpTransport,
} from "../../shared/contracts";
import type { ProjectService } from "../projects";

/**
 * Reads the Gemini CLI's own on-disk configuration.
 *
 * Neither list is available over ACP: `session/new` only *hands* `mcpServers`
 * to the agent, and `available_commands_update` reports slash commands, not
 * skills. Gemini CLI resolves both from settings files and skill folders, so
 * GeminUI reads the same locations.
 *
 * Every filesystem access is optional. A missing directory, an unreadable file
 * or a broken JSON document is skipped; the resulting list is simply shorter.
 */

/** Skill folders, lowest precedence first inside one tier. */
const SKILL_DIRECTORY_NAMES = [
  path.join(".gemini", "skills"),
  // Documented alias; it wins over .gemini/skills inside the same tier.
  path.join(".agents", "skills"),
] as const;

const SETTINGS_RELATIVE_PATH = path.join(".gemini", "settings.json");

const MAX_SKILL_FILE_BYTES = 512 * 1024;
const MAX_SETTINGS_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_ENTRIES_PER_DIRECTORY = 400;

/**
 * `--api-key=…` style arguments are the one place where a credential regularly
 * ends up in an otherwise harmless command line.
 */
const SECRET_ARGUMENT =
  /^(--?[A-Za-z0-9._-]*(?:token|key|secret|password|passwd|pwd|auth|credential)[A-Za-z0-9._-]*)=(.*)$/i;

const REDACTED = "•••";

type ScanTarget = {
  readonly directory: string;
  readonly scope: AgentExtensionScope;
  readonly scopeLabel: string | null;
  /** Higher wins when two definitions share a name. */
  readonly rank: number;
};

type GeminiSettings = {
  readonly mcpServers: Record<string, unknown>;
  readonly mcpAllowed: string[] | null;
  readonly mcpExcluded: string[] | null;
  readonly disabledSkills: string[];
};

export class AgentExtensionService {
  constructor(private readonly projects: ProjectService) {}

  async listSkills(input: ListAgentExtensionsInput): Promise<GeminiSkillList> {
    const parsed = ListAgentExtensionsInputSchema.parse(input);
    const targets = this.#skillTargets(parsed.projectId);
    const disabled = await this.#disabledSkillNames(parsed.projectId);

    const byName = new Map<string, { skill: GeminiSkill; rank: number }>();
    let truncated = false;

    for (const target of targets) {
      const entries = await readDirectoryNames(target.directory);
      if (entries.length > MAX_SKILL_ENTRIES_PER_DIRECTORY) truncated = true;
      for (const entry of entries.slice(0, MAX_SKILL_ENTRIES_PER_DIRECTORY)) {
        const skillPath = path.join(target.directory, entry);
        const metadata = await readSkillMetadata(path.join(skillPath, "SKILL.md"));
        if (!metadata) continue;
        const name = metadata.name || entry;
        const existing = byName.get(name);
        if (existing && existing.rank > target.rank) continue;
        byName.set(name, {
          rank: target.rank,
          skill: {
            id: `${target.scope}:${name}`,
            name,
            description: metadata.description,
            scope: target.scope,
            scopeLabel: target.scopeLabel,
            path: skillPath,
            enabled: !disabled.has(name.toLowerCase()),
          },
        });
      }
    }

    const skills = [...byName.values()]
      .map((entry) => entry.skill)
      .sort((left, right) => left.name.localeCompare(right.name, "de"));
    if (skills.length > MAX_GEMINI_SKILLS) truncated = true;

    return GeminiSkillListSchema.parse({
      projectId: parsed.projectId,
      refreshedAt: new Date().toISOString(),
      skills: skills.slice(0, MAX_GEMINI_SKILLS),
      scannedPaths: targets.map((target) => target.directory),
      truncated,
    });
  }

  async listMcpServers(input: ListAgentExtensionsInput): Promise<McpServerList> {
    const parsed = ListAgentExtensionsInputSchema.parse(input);
    const targets = this.#settingsTargets(parsed.projectId);

    const byName = new Map<string, { server: McpServer; rank: number }>();
    let allowed: string[] | null = null;
    let excluded: string[] | null = null;
    let truncated = false;

    for (const target of targets) {
      const settings = await readGeminiSettings(target.directory);
      if (!settings) continue;
      if (settings.mcpAllowed) allowed = settings.mcpAllowed;
      if (settings.mcpExcluded) excluded = settings.mcpExcluded;

      for (const [name, definition] of Object.entries(settings.mcpServers)) {
        if (!isRecord(definition)) continue;
        const existing = byName.get(name);
        if (existing && existing.rank > target.rank) continue;
        byName.set(name, {
          rank: target.rank,
          server: describeMcpServer(name, definition, target),
        });
      }
    }

    const servers = [...byName.values()]
      .map(({ server }) => ({
        ...server,
        enabled:
          !(excluded ?? []).includes(server.name) &&
          (allowed === null || allowed.includes(server.name)),
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "de"));
    if (servers.length > MAX_MCP_SERVERS) truncated = true;

    return McpServerListSchema.parse({
      projectId: parsed.projectId,
      refreshedAt: new Date().toISOString(),
      servers: servers.slice(0, MAX_MCP_SERVERS),
      scannedPaths: targets.map((target) =>
        path.join(target.directory, SETTINGS_RELATIVE_PATH),
      ),
      truncated,
    });
  }

  /**
   * Project roots, primary last so it outranks the additional ones, mirroring
   * how the primary root is the Gemini working directory.
   */
  #projectRoots(projectId: string | null): Array<{ path: string; label: string }> {
    if (!projectId) return [];
    try {
      const project = this.projects.get(projectId);
      const roots = [...project.roots].sort((left, right) =>
        left.kind === right.kind
          ? right.sortOrder - left.sortOrder
          : left.kind === "primary"
            ? 1
            : -1,
      );
      return roots.map((root) => ({ path: root.path, label: root.label }));
    } catch {
      // A deleted or unauthorised project simply contributes no project scope.
      return [];
    }
  }

  #skillTargets(projectId: string | null): ScanTarget[] {
    const targets: ScanTarget[] = [];
    const home = safeHomeDirectory();
    if (home) {
      SKILL_DIRECTORY_NAMES.forEach((relative, index) => {
        targets.push({
          directory: path.join(home, relative),
          scope: "user",
          scopeLabel: "Benutzer",
          rank: 10 + index,
        });
      });
    }
    this.#projectRoots(projectId).forEach((root, rootIndex) => {
      SKILL_DIRECTORY_NAMES.forEach((relative, index) => {
        targets.push({
          directory: path.join(root.path, relative),
          scope: "project",
          scopeLabel: root.label,
          rank: 100 + rootIndex * 10 + index,
        });
      });
    });
    return targets;
  }

  /** Directories that may hold a `.gemini/settings.json`, weakest first. */
  #settingsTargets(projectId: string | null): ScanTarget[] {
    const targets: ScanTarget[] = [];
    const home = safeHomeDirectory();
    if (home) {
      targets.push({
        directory: home,
        scope: "user",
        scopeLabel: "Benutzer",
        rank: 10,
      });
    }
    this.#projectRoots(projectId).forEach((root, rootIndex) => {
      targets.push({
        directory: root.path,
        scope: "project",
        scopeLabel: root.label,
        rank: 100 + rootIndex,
      });
    });
    return targets;
  }

  async #disabledSkillNames(projectId: string | null): Promise<Set<string>> {
    const disabled = new Set<string>();
    for (const target of this.#settingsTargets(projectId)) {
      const settings = await readGeminiSettings(target.directory);
      for (const name of settings?.disabledSkills ?? []) {
        disabled.add(name.toLowerCase());
      }
    }
    return disabled;
  }
}

function describeMcpServer(
  name: string,
  definition: Record<string, unknown>,
  target: ScanTarget,
): McpServer {
  const httpUrl = readString(definition["httpUrl"]);
  const sseUrl = readString(definition["url"]);
  const command = readString(definition["command"]);

  const transport: McpTransport = httpUrl
    ? "http"
    : sseUrl
      ? "sse"
      : command
        ? "stdio"
        : "unknown";

  return {
    id: `${target.scope}:${name}`,
    name,
    scope: target.scope,
    scopeLabel: target.scopeLabel,
    transport,
    command: command ?? null,
    args: readStringArray(definition["args"])
      .slice(0, MAX_MCP_SERVER_ARGS)
      .map(redactArgument),
    url: sanitizeUrl(httpUrl ?? sseUrl),
    cwd: readString(definition["cwd"]) ?? null,
    envKeys: readKeyNames(definition["env"]),
    headerKeys: readKeyNames(definition["headers"]),
    description: readString(definition["description"]) ?? null,
    trusted: definition["trust"] === true,
    // Overwritten by the caller once the effective allow/exclude lists are known.
    enabled: true,
    configPath: path.join(target.directory, SETTINGS_RELATIVE_PATH),
  };
}

/**
 * Strips credentials that a configured endpoint may carry. Userinfo, query and
 * fragment are dropped; a value the URL parser rejects (an unexpanded
 * `${VAR}` placeholder, for instance) is cut at the first `?` or `#`.
 */
function sanitizeUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 4_096);
  } catch {
    return (raw.split(/[?#]/)[0] ?? raw).slice(0, 4_096) || null;
  }
}

function redactArgument(value: string): string {
  const match = SECRET_ARGUMENT.exec(value);
  return match ? `${match[1]}=${REDACTED}` : value;
}

function readKeyNames(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.keys(value)
    .filter((key) => key.trim().length > 0)
    .slice(0, MAX_MCP_SERVER_KEYS)
    .map((key) => key.slice(0, 200));
}

async function readDirectoryNames(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith("."))
      .sort((left, right) => left.localeCompare(right, "de"));
  } catch {
    // A missing skills folder is the normal case, not an error.
    return [];
  }
}

async function readSkillMetadata(
  skillFile: string,
): Promise<{ name: string; description: string } | null> {
  const text = await readTextFile(skillFile, MAX_SKILL_FILE_BYTES);
  if (text === null) return null;
  const frontmatter = parseFrontmatter(text);
  return {
    name: (frontmatter["name"] ?? "").trim().slice(0, 200),
    description: (frontmatter["description"] ?? "").trim().slice(0, 4_000),
  };
}

async function readGeminiSettings(
  directory: string,
): Promise<GeminiSettings | null> {
  const text = await readTextFile(
    path.join(directory, SETTINGS_RELATIVE_PATH),
    MAX_SETTINGS_FILE_BYTES,
  );
  if (text === null) return null;
  const document = parseJsonWithComments(text);
  if (!isRecord(document)) return null;

  const mcpSection = isRecord(document["mcp"]) ? document["mcp"] : {};
  const skillsSection = isRecord(document["skills"]) ? document["skills"] : {};

  return {
    mcpServers: isRecord(document["mcpServers"]) ? document["mcpServers"] : {},
    mcpAllowed: readOptionalStringArray(mcpSection["allowed"]),
    mcpExcluded: readOptionalStringArray(mcpSection["excluded"]),
    disabledSkills: readStringArray(skillsSection["disabled"]),
  };
}

async function readTextFile(
  filePath: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    const buffer = await readFile(filePath);
    if (buffer.byteLength > maxBytes) return null;
    return buffer.toString("utf8");
  } catch {
    // Missing, unreadable or a directory — all mean "nothing to show".
    return null;
  }
}

/**
 * Gemini CLI tolerates comments and trailing commas in its settings files, so
 * a strict `JSON.parse` would hide real configuration. Both are removed before
 * parsing; a document that still fails yields `null` instead of an error.
 */
export function parseJsonWithComments(text: string): unknown {
  const withoutComments = stripJsonComments(text);
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(withoutTrailingCommas);
  } catch {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

function stripJsonComments(text: string): string {
  let result = "";
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const character = text[index] ?? "";
    if (inString) {
      result += character;
      if (character === "\\") {
        result += text[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    result += character;
    index += 1;
  }
  return result;
}

/**
 * Reads the `---` delimited YAML header of a SKILL.md. Only the flat
 * `key: value` shape Gemini CLI documents is supported, plus folded values
 * that continue on indented lines and the `|`/`>` block markers.
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return {};

  const body = normalized.slice(4, end + 1);
  const result: Record<string, string> = {};
  let currentKey: string | null = null;

  for (const line of body.split("\n")) {
    if (!line.trim()) {
      if (currentKey) result[currentKey] = `${result[currentKey] ?? ""}\n`;
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+):\s?(.*)$/.exec(line);
    if (match && !/^\s/.test(line)) {
      currentKey = match[1] ?? null;
      if (!currentKey) continue;
      const value = (match[2] ?? "").trim();
      result[currentKey] = value === "|" || value === ">" || value === "|-" || value === ">-"
        ? ""
        : unquote(value);
      continue;
    }
    if (currentKey) {
      const continuation = line.trim();
      const previous = result[currentKey] ?? "";
      result[currentKey] = previous ? `${previous.trimEnd()} ${continuation}` : continuation;
    }
  }

  for (const key of Object.keys(result)) {
    result[key] = unquote((result[key] ?? "").trim());
  }
  return result;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function safeHomeDirectory(): string | null {
  try {
    const home = homedir();
    return home && home.trim() ? home : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function readOptionalStringArray(value: unknown): string[] | null {
  return Array.isArray(value) ? readStringArray(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
