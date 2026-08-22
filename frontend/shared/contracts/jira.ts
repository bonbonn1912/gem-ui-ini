import { z } from "zod";

import {
  ClientRequestIdSchema,
  EntityIdSchema,
  HttpsUrlSchema,
  IsoTimestampSchema,
} from "./common";

/**
 * A Jira integration is two things kept deliberately apart.
 *
 * The *configuration* — a name, the instance's base URL and the issue prefixes
 * that live on it — is global: once someone has typed their company's Jira in
 * one project, every other project offers it in the integrations tab instead of
 * asking for the same URL again. Several may exist side by side, because a
 * person can work against more than one instance.
 *
 * The *activation* is per project and singular: a project points at exactly one
 * configuration, or at none. Nothing is enabled by default.
 */

export const MAX_JIRA_ISSUE_PREFIXES = 25;
export const MAX_JIRA_ISSUE_KEY_LENGTH = 60;

/**
 * A Jira project key: letters first, then letters, digits or underscores.
 * Stored upper-case so "aml" and "AML" are the same prefix rather than two.
 */
export const JiraIssuePrefixSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z][A-Z0-9_]{0,19}$/,
    "Ein Jira-Prefix beginnt mit einem Buchstaben und besteht aus Buchstaben, Ziffern oder Unterstrichen (max. 20 Zeichen).",
  );

export const JiraIssueKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .max(MAX_JIRA_ISSUE_KEY_LENGTH)
  .regex(/^[A-Z][A-Z0-9_]{0,19}-\d{1,12}$/, "Erwartet wird ein Jira-Issue-Key wie AML-1234.");

export const JiraConfigNameSchema = z.string().trim().min(1).max(100);

export const JiraConfigSchema = z
  .object({
    id: EntityIdSchema,
    name: JiraConfigNameSchema,
    baseUrl: HttpsUrlSchema,
    issuePrefixes: z
      .array(JiraIssuePrefixSchema)
      .min(1)
      .max(MAX_JIRA_ISSUE_PREFIXES),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();

export const JiraProjectIntegrationSchema = z
  .object({
    projectId: EntityIdSchema,
    /** The one configuration this project uses, or null when Jira is off. */
    activeConfigId: EntityIdSchema.nullable(),
    activeConfig: JiraConfigSchema.nullable(),
    updatedAt: IsoTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.activeConfigId === null) !== (value.activeConfig === null)) {
      context.addIssue({
        code: "custom",
        message: "activeConfigId and activeConfig must both be set or both be null",
        path: ["activeConfig"],
      });
    }
  });

export const ListJiraConfigsInputSchema = z.object({}).strict();

export const SaveJiraConfigInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    /** null creates a new configuration, an id updates that one in place. */
    configId: EntityIdSchema.nullable().default(null),
    name: JiraConfigNameSchema,
    baseUrl: HttpsUrlSchema,
    issuePrefixes: z
      .array(JiraIssuePrefixSchema)
      .min(1)
      .max(MAX_JIRA_ISSUE_PREFIXES),
  })
  .strict();

export const DeleteJiraConfigInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    configId: EntityIdSchema,
  })
  .strict();

export const GetJiraProjectIntegrationInputSchema = z
  .object({
    projectId: EntityIdSchema,
  })
  .strict();

export const ActivateJiraProjectIntegrationInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    projectId: EntityIdSchema,
    configId: EntityIdSchema,
  })
  .strict();

export const DeactivateJiraProjectIntegrationInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    projectId: EntityIdSchema,
  })
  .strict();

export const JiraIssueMatchSchema = z
  .object({
    issueKey: JiraIssueKeySchema,
    prefix: JiraIssuePrefixSchema,
    url: HttpsUrlSchema,
  })
  .strict();

export const AttachJiraIssueInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    projectId: EntityIdSchema,
    sessionId: EntityIdSchema,
    issueKey: JiraIssueKeySchema,
  })
  .strict();

export const AttachJiraIssueResultSchema = z
  .object({
    match: JiraIssueMatchSchema,
    attachmentId: EntityIdSchema,
  })
  .strict();

export type JiraConfig = z.infer<typeof JiraConfigSchema>;
export type JiraProjectIntegration = z.infer<typeof JiraProjectIntegrationSchema>;
export type ListJiraConfigsInput = z.input<typeof ListJiraConfigsInputSchema>;
export type SaveJiraConfigInput = z.input<typeof SaveJiraConfigInputSchema>;
export type DeleteJiraConfigInput = z.input<typeof DeleteJiraConfigInputSchema>;
export type GetJiraProjectIntegrationInput = z.input<
  typeof GetJiraProjectIntegrationInputSchema
>;
export type ActivateJiraProjectIntegrationInput = z.input<
  typeof ActivateJiraProjectIntegrationInputSchema
>;
export type DeactivateJiraProjectIntegrationInput = z.input<
  typeof DeactivateJiraProjectIntegrationInputSchema
>;
export type JiraIssueMatch = z.infer<typeof JiraIssueMatchSchema>;
export type AttachJiraIssueInput = z.input<typeof AttachJiraIssueInputSchema>;
export type AttachJiraIssueResult = z.infer<typeof AttachJiraIssueResultSchema>;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds the issue a session title refers to.
 *
 * A prefix on its own cannot address an issue, so what is looked for is the
 * full key — `AML-1234`, not a bare `AML`. When a title happens to mention two
 * configured prefixes, the one that appears **first** in the title wins; ties
 * (impossible in practice, but cheap to define) fall to the order the prefixes
 * were configured in. Matching is case-insensitive so `aml-12` still resolves,
 * and the returned key is normalised to upper case.
 */
export function matchJiraIssueKey(
  title: string,
  prefixes: readonly string[],
): { issueKey: string; prefix: string; index: number } | null {
  if (!title) return null;
  let best: { issueKey: string; prefix: string; index: number } | null = null;

  for (const rawPrefix of prefixes) {
    const prefix = rawPrefix.trim().toUpperCase();
    if (!prefix) continue;
    // The boundaries are hand-written rather than `\b`, because `\b` would
    // happily match the "BUG" inside "DEBUG-12".
    const pattern = new RegExp(
      `(?<![A-Za-z0-9_])${escapeRegExp(prefix)}-(\\d{1,12})(?![A-Za-z0-9])`,
      "i",
    );
    const found = pattern.exec(title);
    if (!found) continue;
    if (best === null || found.index < best.index) {
      best = { issueKey: `${prefix}-${found[1]}`, prefix, index: found.index };
    }
  }

  return best;
}

/** `https://jira.example.com/` + `AML-1234` → `https://jira.example.com/browse/AML-1234`. */
export function buildJiraIssueUrl(baseUrl: string, issueKey: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/browse/${issueKey.trim().toUpperCase()}`;
}
