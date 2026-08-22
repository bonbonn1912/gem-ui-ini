import { randomUUID } from "node:crypto";

import {
  ActivateJiraProjectIntegrationInputSchema,
  AttachJiraIssueInputSchema,
  DeactivateJiraProjectIntegrationInputSchema,
  DeleteJiraConfigInputSchema,
  GetJiraProjectIntegrationInputSchema,
  SaveJiraConfigInputSchema,
  buildJiraIssueUrl,
  type ActivateJiraProjectIntegrationInput,
  type AttachJiraIssueInput,
  type AttachJiraIssueResult,
  type DeactivateJiraProjectIntegrationInput,
  type DeleteJiraConfigInput,
  type GetJiraProjectIntegrationInput,
  type JiraConfig,
  type JiraProjectIntegration,
  type SaveJiraConfigInput,
} from "../../../shared/contracts";
import type { ContextAttachmentService } from "../../context-attachments";
import type { ProjectService } from "../../projects";
import type { JiraRepository } from "../../storage";

export type JiraServiceOptions = {
  repository: JiraRepository;
  projects: ProjectService;
  contextAttachments: ContextAttachmentService;
};

/**
 * Jira, unlike GitLab, is not spoken to over an API here.
 *
 * Everything the app needs — which issue a session is about and where that
 * issue lives — follows from a base URL and a list of issue prefixes. The
 * issue itself is shown in the same sandboxed WebContentsView the link preview
 * already uses, so the user's existing browser login is what grants access and
 * no token ever has to be stored.
 */
export class JiraService {
  readonly #repository: JiraRepository;
  readonly #projects: ProjectService;
  readonly #contextAttachments: ContextAttachmentService;

  constructor(options: JiraServiceOptions) {
    this.#repository = options.repository;
    this.#projects = options.projects;
    this.#contextAttachments = options.contextAttachments;
  }

  listConfigs(): JiraConfig[] {
    return this.#repository.listConfigs();
  }

  saveConfig(input: SaveJiraConfigInput): JiraConfig {
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

    const now = new Date().toISOString();
    if (parsed.configId === null) {
      return this.#repository.insertConfig({
        id: randomUUID(),
        name: parsed.name,
        baseUrl,
        issuePrefixes,
        createdAt: now,
        updatedAt: now,
      });
    }

    const existing = this.#repository.findConfig(parsed.configId);
    if (!existing) throw new Error("Diese Jira-Integration existiert nicht mehr.");
    return this.#repository.updateConfig({
      id: existing.id,
      name: parsed.name,
      baseUrl,
      issuePrefixes,
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
    this.#projects.get(parsed.projectId);
    return this.#readProjectIntegration(parsed.projectId);
  }

  activate(input: ActivateJiraProjectIntegrationInput): JiraProjectIntegration {
    const parsed = ActivateJiraProjectIntegrationInputSchema.parse(input);
    this.#projects.get(parsed.projectId);
    const config = this.#repository.findConfig(parsed.configId);
    if (!config) throw new Error("Diese Jira-Integration existiert nicht mehr.");
    // One row per project: activating a second configuration replaces the
    // first rather than adding to it.
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
    this.#projects.get(parsed.projectId);
    this.#repository.clearProjectIntegration(parsed.projectId);
    return this.#readProjectIntegration(parsed.projectId);
  }

  /**
   * Pins the issue to the session as a link attachment.
   *
   * `ingestLink` deduplicates on the normalised URL, so calling this again for
   * the same session and issue hands back the row that already exists instead
   * of piling up copies — which is what lets the renderer attach eagerly the
   * moment a title matches.
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
    const attachment = await this.#contextAttachments.ingestLink({
      clientRequestId: parsed.clientRequestId,
      projectId: parsed.projectId,
      scope: "session",
      sessionId: parsed.sessionId,
      url,
      title: parsed.issueKey,
      origin: "manual",
    });

    return {
      match: { issueKey: parsed.issueKey, prefix, url },
      attachmentId: attachment.id,
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
      // The cascade should make this impossible; treating it as "off" beats
      // handing the renderer an activation that points nowhere.
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
