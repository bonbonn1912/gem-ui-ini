import { randomUUID } from "node:crypto";

import {
  ActivateJiraProjectIntegrationInputSchema,
  AttachJiraIssueInputSchema,
  DeactivateJiraProjectIntegrationInputSchema,
  DeleteJiraConfigInputSchema,
  FetchJiraIssueDetailsInputSchema,
  GetJiraProjectIntegrationInputSchema,
  SaveJiraConfigInputSchema,
  SyncJiraAttachmentsInputSchema,
  buildJiraIssueUrl,
  type ActivateJiraProjectIntegrationInput,
  type AttachJiraIssueInput,
  type AttachJiraIssueResult,
  type DeactivateJiraProjectIntegrationInput,
  type DeleteJiraConfigInput,
  type FetchJiraIssueDetailsInput,
  type GetJiraProjectIntegrationInput,
  type JiraConfig,
  type JiraIssueDetails,
  type JiraProjectIntegration,
  type SaveJiraConfigInput,
  type SyncJiraAttachmentsInput,
  type SyncJiraAttachmentsResult,
} from "../../../shared/contracts";
import type { ContextAttachmentService } from "../../context-attachments";
import type { ProjectService } from "../../projects";
import type { JiraRepository } from "../../storage";
import { JiraApiClient } from "./jira-client";
import { JiraTokenVault } from "./jira-token-vault";

export type JiraServiceOptions = {
  repository: JiraRepository;
  projects?: ProjectService;
  contextAttachments: ContextAttachmentService;
  tokenVault?: JiraTokenVault;
  logger?: (level: "info" | "warn" | "error", message: string, details?: unknown) => void;
};

/**
 * Jira integration service.
 *
 * Supports lightweight URL-based integration as well as full REST API access
 * (Jira Cloud & Jira Self-Hosted / Data Center) when an access token is provided.
 * When a token is configured, issue details and descriptions are fetched via API,
 * converted to Markdown, attached to the session as `story.md`, and available
 * for direct insertion into chat prompts.
 */
export class JiraService {
  readonly #repository: JiraRepository;
  readonly #projects?: ProjectService;
  readonly #contextAttachments: ContextAttachmentService;
  readonly #tokenVault: JiraTokenVault;
  readonly #logger?: (level: "info" | "warn" | "error", message: string, details?: unknown) => void;

  constructor(options: JiraServiceOptions) {
    this.#repository = options.repository;
    this.#projects = options.projects;
    this.#contextAttachments = options.contextAttachments;
    this.#tokenVault = options.tokenVault ?? new JiraTokenVault();
    this.#logger = options.logger;
  }

  listConfigs(): JiraConfig[] {
    return this.#repository.listConfigs();
  }

  async saveConfig(input: SaveJiraConfigInput): Promise<JiraConfig> {
    const parsed = SaveJiraConfigInputSchema.parse(input);
    const baseUrl = normalizeBaseUrl(parsed.baseUrl);
    const issuePrefixes = uniquePrefixes(parsed.issuePrefixes);
    if (issuePrefixes.length === 0) {
      throw new Error("Mindestens ein Issue-Prefix wird benötigt.");
    }

    const nameOwner = this.#repository.findConfigByName(parsed.name);
    if (nameOwner && nameOwner.id !== parsed.configId) {
      throw new Error(`Es gibt bereits eine Jira-Integration mit dem Namen „${parsed.name}“.`);
    }

    let tokenCipher: Buffer | null | undefined = undefined;
    if (parsed.accessToken && parsed.accessToken.trim().length > 0) {
      tokenCipher = await this.#tokenVault.encryptToken(parsed.accessToken.trim());
    }

    const now = new Date().toISOString();
    if (parsed.configId === null) {
      return this.#repository.insertConfig({
        id: randomUUID(),
        name: parsed.name,
        baseUrl,
        issuePrefixes,
        tokenCipher: tokenCipher ?? null,
        email: parsed.email?.trim() || null,
        createdAt: now,
        updatedAt: now,
      });
    }

    const existing = this.#repository.findStoredConfig(parsed.configId);
    if (!existing) throw new Error("Diese Jira-Integration existiert nicht mehr.");

    return this.#repository.updateConfig({
      id: existing.id,
      name: parsed.name,
      baseUrl,
      issuePrefixes,
      tokenCipher: parsed.clearAccessToken ? null : tokenCipher !== undefined ? tokenCipher : existing.tokenCipher,
      email: parsed.email !== undefined ? (parsed.email?.trim() || null) : existing.email,
      clearToken: parsed.clearAccessToken,
      updatedAt: now,
    });
  }

  deleteConfig(input: DeleteJiraConfigInput): { ok: true } {
    const parsed = DeleteJiraConfigInputSchema.parse(input);
    this.#repository.deleteConfig(parsed.configId);
    return { ok: true };
  }

  getProjectIntegration(
    input: GetJiraProjectIntegrationInput,
  ): JiraProjectIntegration {
    const parsed = GetJiraProjectIntegrationInputSchema.parse(input);
    this.#projects?.get(parsed.projectId);
    return this.#readProjectIntegration(parsed.projectId);
  }

  activate(input: ActivateJiraProjectIntegrationInput): JiraProjectIntegration {
    const parsed = ActivateJiraProjectIntegrationInputSchema.parse(input);
    this.#projects?.get(parsed.projectId);
    const config = this.#repository.findConfig(parsed.configId);
    if (!config) throw new Error("Diese Jira-Integration existiert nicht mehr.");
    this.#repository.setProjectIntegration({
      projectId: parsed.projectId,
      configId: config.id,
      now: new Date().toISOString(),
    });
    return this.#readProjectIntegration(parsed.projectId);
  }

  deactivate(
    input: DeactivateJiraProjectIntegrationInput,
  ): JiraProjectIntegration {
    const parsed = DeactivateJiraProjectIntegrationInputSchema.parse(input);
    this.#projects?.get(parsed.projectId);
    this.#repository.clearProjectIntegration(parsed.projectId);
    return this.#readProjectIntegration(parsed.projectId);
  }

  /**
   * Fetches full issue details from the Jira REST API using the configured token.
   */
  async fetchIssueDetails(input: FetchJiraIssueDetailsInput): Promise<JiraIssueDetails> {
    const parsed = FetchJiraIssueDetailsInputSchema.parse(input);
    const integration = this.#readProjectIntegration(parsed.projectId);
    const config = integration.activeConfig;
    if (!config) {
      throw new Error("Für dieses Projekt ist keine Jira-Integration aktiviert.");
    }

    const storedConfig = this.#repository.findStoredConfig(config.id);
    if (!storedConfig?.tokenCipher) {
      throw new Error(
        "Für diese Jira-Integration ist kein Access Token hinterlegt. Bitte hinterlege einen Token in den Jira-Einstellungen.",
      );
    }

    return await this.#tokenVault.withDecryptedToken(
      storedConfig.tokenCipher,
      async (token) => {
        const client = new JiraApiClient({
          baseUrl: config.baseUrl,
          token,
          email: config.email,
          logger: this.#logger,
        });
        return await client.getIssue(parsed.issueKey);
      },
    );
  }

  /**
   * Downloads attachments from a Jira story and ingests them into the session's context attachments.
   */
  async syncAttachments(input: SyncJiraAttachmentsInput): Promise<SyncJiraAttachmentsResult> {
    const parsed = SyncJiraAttachmentsInputSchema.parse(input);
    const integration = this.#readProjectIntegration(parsed.projectId);
    const config = integration.activeConfig;
    if (!config) {
      throw new Error("Für dieses Projekt ist keine Jira-Integration aktiviert.");
    }

    const storedConfig = this.#repository.findStoredConfig(config.id);
    if (!storedConfig?.tokenCipher) {
      throw new Error(
        "Für diese Jira-Integration ist kein Access Token hinterlegt. Bitte hinterlege einen Token in den Jira-Einstellungen.",
      );
    }

    return await this.#tokenVault.withDecryptedToken(
      storedConfig.tokenCipher,
      async (token) => {
        const client = new JiraApiClient({
          baseUrl: config.baseUrl,
          token,
          email: config.email,
          logger: this.#logger,
        });

        const issue = await client.getIssue(parsed.issueKey);
        const allAttachments = issue.attachments || [];
        const toSync = parsed.attachmentIds && parsed.attachmentIds.length > 0
          ? allAttachments.filter((att) => parsed.attachmentIds!.includes(att.id))
          : allAttachments;

        const syncedAttachmentIds: string[] = [];
        for (const att of toSync) {
          try {
            const buffer = await client.downloadAttachment(att.contentUrl, att.id);
            const contextAttachment = await this.#contextAttachments.ingestBuffer({
              clientRequestId: `${parsed.clientRequestId}-${att.id}`,
              projectId: parsed.projectId,
              sessionId: parsed.sessionId,
              scope: "session",
              buffer,
              fileName: att.filename,
              title: `${parsed.issueKey}: ${att.filename}`,
              defaultInclude: true,
            });
            syncedAttachmentIds.push(contextAttachment.id);
          } catch (err) {
            console.warn(`[JiraService] Anhang ${att.filename} (${att.id}) konnte nicht synchronisiert werden:`, err);
          }
        }

        return {
          syncedCount: syncedAttachmentIds.length,
          attachmentIds: syncedAttachmentIds,
          skippedCount: allAttachments.length - syncedAttachmentIds.length,
        };
      },
    );
  }

  /**
   * Pins the issue to the session as a link attachment and, if an access token is
   * configured, fetches the story details via REST API and attaches `story.md`.
   */
  async attachIssue(input: AttachJiraIssueInput): Promise<AttachJiraIssueResult> {
    const parsed = AttachJiraIssueInputSchema.parse(input);
    const integration = this.#readProjectIntegration(parsed.projectId);
    const config = integration.activeConfig;
    if (!config) {
      throw new Error("Für dieses Projekt ist keine Jira-Integration aktiviert.");
    }

    const prefix = parsed.issueKey.slice(0, parsed.issueKey.lastIndexOf("-"));
    if (!config.issuePrefixes.includes(prefix)) {
      throw new Error(
        `„${prefix}“ gehört nicht zu den Prefixen der aktiven Jira-Integration.`,
      );
    }

    const url = buildJiraIssueUrl(config.baseUrl, parsed.issueKey);

    // 1. Ingest link attachment
    const linkAttachment = await this.#contextAttachments.ingestLink({
      clientRequestId: parsed.clientRequestId,
      projectId: parsed.projectId,
      scope: "session",
      sessionId: parsed.sessionId,
      url,
      title: parsed.issueKey,
      origin: "manual",
      defaultInclude: false,
    });

    let storyAttachmentId: string | null = null;
    let storyMarkdown: string | null = null;
    let summary: string | null = null;

    // 2. If access token is configured, fetch story details & ingest story.md
    const storedConfig = this.#repository.findStoredConfig(config.id);
    if (storedConfig?.tokenCipher) {
      try {
        const issueDetails = await this.#tokenVault.withDecryptedToken(
          storedConfig.tokenCipher,
          async (token) => {
            const client = new JiraApiClient({
              baseUrl: config.baseUrl,
              token,
              email: config.email,
              logger: this.#logger,
            });
            return await client.getIssue(parsed.issueKey);
          },
        );

        summary = issueDetails.summary;
        storyMarkdown = issueDetails.storyMarkdown;

        // Ensure only the single latest story.md exists for this session & issue
        try {
          const list = this.#contextAttachments.list({
            projectId: parsed.projectId,
            sessionId: parsed.sessionId,
          });
          const oldStoryAttachments = (list?.sessionAttachments || []).filter(
            (att) =>
              att.file?.displayName === "story.md" &&
              (att.title === `${parsed.issueKey}: story.md` ||
                att.title.endsWith(": story.md") ||
                att.title === "story.md"),
          );
          for (const old of oldStoryAttachments) {
            await this.#contextAttachments.remove({
              attachmentId: old.id,
              clientRequestId: `${parsed.clientRequestId}-rm-${old.id}`,
            });
          }
        } catch {
          // Ignore cleanup error
        }

        const storyAttachment = await this.#contextAttachments.ingestText({
          clientRequestId: `${parsed.clientRequestId}-story`,
          projectId: parsed.projectId,
          sessionId: parsed.sessionId,
          scope: "session",
          text: issueDetails.storyMarkdown,
          fileName: "story.md",
          title: `${parsed.issueKey}: story.md`,
          origin: "manual",
          defaultInclude: true,
        });

        storyAttachmentId = storyAttachment.id;
      } catch (apiError) {
        console.warn("[JiraService] Fehler beim Abrufen des Jira-Issues via API:", apiError);
      }
    }

    return {
      match: { issueKey: parsed.issueKey, prefix, url },
      attachmentId: linkAttachment.id,
      storyAttachmentId,
      storyMarkdown,
      summary,
    };
  }

  #readProjectIntegration(projectId: string): JiraProjectIntegration {
    const stored = this.#repository.getProjectIntegration(projectId);
    if (!stored) {
      return {
        projectId,
        activeConfigId: null,
        activeConfig: null,
        updatedAt: null,
      };
    }
    const config = this.#repository.findConfig(stored.configId);
    if (!config) {
      return {
        projectId,
        activeConfigId: null,
        activeConfig: null,
        updatedAt: null,
      };
    }
    return {
      projectId,
      activeConfigId: config.id,
      activeConfig: config,
      updatedAt: stored.updatedAt,
    };
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  const url = new URL(trimmed);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Die Jira-Base-URL muss mit http:// oder https:// beginnen.");
  }
  return trimmed;
}

function uniquePrefixes(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const prefix = value.trim().toUpperCase();
    if (!prefix || seen.has(prefix)) continue;
    seen.add(prefix);
    result.push(prefix);
  }
  return result;
}
