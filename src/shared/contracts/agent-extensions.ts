import { z } from "zod";

import {
  DisplayNameSchema,
  EntityIdSchema,
  FileSystemPathSchema,
  IsoTimestampSchema,
} from "./common";

/**
 * Skills and MCP servers of the locally installed Gemini CLI.
 *
 * Both lists are read from the Gemini CLI's own configuration on disk — the
 * ACP channel exposes neither: `session/new` only *sends* `mcpServers` to the
 * agent, and `available_commands_update` carries slash commands, not skills.
 *
 * Secrets never cross this contract. Environment variables and HTTP headers
 * are reduced to their key names, URLs are stripped of userinfo, query and
 * fragment, and argument values that look like credentials are redacted in
 * the main process before the payload is built.
 */

export const MAX_GEMINI_SKILLS = 500;
export const MAX_MCP_SERVERS = 200;
export const MAX_AGENT_EXTENSION_SCAN_PATHS = 48;
export const MAX_MCP_SERVER_ARGS = 64;
export const MAX_MCP_SERVER_KEYS = 64;

/** Where a skill or server definition was found. */
export const AgentExtensionScopeSchema = z.enum([
  "builtin",
  "user",
  "project",
  "system",
]);

export const GeminiSkillSchema = z
  .object({
    id: z.string().trim().min(1).max(600),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4_000),
    scope: AgentExtensionScopeSchema,
    /** Root label for project skills, "Benutzer" for user skills. */
    scopeLabel: DisplayNameSchema.nullable(),
    path: FileSystemPathSchema,
    enabled: z.boolean(),
  })
  .strict();

export const GeminiSkillListSchema = z
  .object({
    projectId: EntityIdSchema.nullable(),
    refreshedAt: IsoTimestampSchema,
    skills: z.array(GeminiSkillSchema).max(MAX_GEMINI_SKILLS),
    /** Directories that were looked at, existing or not — shown as diagnostics. */
    scannedPaths: z
      .array(FileSystemPathSchema)
      .max(MAX_AGENT_EXTENSION_SCAN_PATHS),
    truncated: z.boolean(),
  })
  .strict();

/**
 * How Gemini CLI reaches the server. Derived from the configuration shape:
 * `httpUrl` wins over `url` wins over `command`. `unknown` keeps a malformed
 * entry visible instead of dropping it — the same tolerance the GitLab
 * contracts use for states a newer server version might invent.
 */
export const McpTransportSchema = z.enum(["stdio", "http", "sse", "unknown"]);

export const McpServerSchema = z
  .object({
    id: z.string().trim().min(1).max(600),
    name: z.string().trim().min(1).max(200),
    scope: AgentExtensionScopeSchema,
    scopeLabel: DisplayNameSchema.nullable(),
    transport: McpTransportSchema,
    /** stdio only. */
    command: z.string().trim().min(1).max(4_096).nullable(),
    args: z.array(z.string().max(4_096)).max(MAX_MCP_SERVER_ARGS),
    /** http/sse only, without userinfo, query string or fragment. */
    url: z.string().trim().min(1).max(4_096).nullable(),
    cwd: FileSystemPathSchema.nullable(),
    /** Key names only — values stay in the main process. */
    envKeys: z.array(z.string().trim().min(1).max(200)).max(MAX_MCP_SERVER_KEYS),
    /** Key names only — values stay in the main process. */
    headerKeys: z
      .array(z.string().trim().min(1).max(200))
      .max(MAX_MCP_SERVER_KEYS),
    description: z.string().trim().max(2_000).nullable(),
    /** `trust: true` in settings.json — this server skips tool confirmations. */
    trusted: z.boolean(),
    enabled: z.boolean(),
    /** settings.json the entry was read from. */
    configPath: FileSystemPathSchema,
  })
  .strict();

export const McpServerListSchema = z
  .object({
    projectId: EntityIdSchema.nullable(),
    refreshedAt: IsoTimestampSchema,
    servers: z.array(McpServerSchema).max(MAX_MCP_SERVERS),
    scannedPaths: z
      .array(FileSystemPathSchema)
      .max(MAX_AGENT_EXTENSION_SCAN_PATHS),
    truncated: z.boolean(),
  })
  .strict();

export const ListAgentExtensionsInputSchema = z
  .object({
    /** `null` limits the scan to user and system scope. */
    projectId: EntityIdSchema.nullable().default(null),
  })
  .strict();

export type AgentExtensionScope = z.infer<typeof AgentExtensionScopeSchema>;
export type GeminiSkill = z.infer<typeof GeminiSkillSchema>;
export type GeminiSkillList = z.infer<typeof GeminiSkillListSchema>;
export type McpTransport = z.infer<typeof McpTransportSchema>;
export type McpServer = z.infer<typeof McpServerSchema>;
export type McpServerList = z.infer<typeof McpServerListSchema>;
export type ListAgentExtensionsInput = z.input<
  typeof ListAgentExtensionsInputSchema
>;
