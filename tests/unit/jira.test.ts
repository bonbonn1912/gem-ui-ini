import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ActivateJiraProjectIntegrationInputSchema,
  AttachJiraIssueInputSchema,
  JiraConfigSchema,
  JiraIssuePrefixSchema,
  JiraProjectIntegrationSchema,
  SaveJiraConfigInputSchema,
  buildJiraIssueUrl,
  matchJiraIssueKey,
} from "../../src/shared/contracts";

describe("Jira issue keys in session titles", () => {
  it("finds the key for a configured prefix", () => {
    expect(matchJiraIssueKey("AML-1234 Rechnungslauf reparieren", ["AML", "BUG"])).toEqual({
      issueKey: "AML-1234",
      prefix: "AML",
      index: 0,
    });
  });

  it("takes the first match when a title names two configured prefixes", () => {
    // "NUR 1. match": the earlier position in the title wins, not the earlier
    // entry in the configuration.
    expect(
      matchJiraIssueKey("BUG-7 hängt an AML-1234", ["AML", "BUG"])?.issueKey,
    ).toBe("BUG-7");
    expect(
      matchJiraIssueKey("AML-1234 hängt an BUG-7", ["AML", "BUG"])?.issueKey,
    ).toBe("AML-1234");
  });

  it("normalises case but keeps word boundaries", () => {
    expect(matchJiraIssueKey("fix aml-9 now", ["AML"])?.issueKey).toBe("AML-9");
    // "BUG" inside "DEBUG" is not the prefix.
    expect(matchJiraIssueKey("DEBUG-12 aufräumen", ["BUG"])).toBeNull();
    expect(matchJiraIssueKey("AML-12X", ["AML"])).toBeNull();
  });

  it("needs a number, because a bare prefix addresses no issue", () => {
    expect(matchJiraIssueKey("AML Umbau", ["AML"])).toBeNull();
    expect(matchJiraIssueKey("", ["AML"])).toBeNull();
    expect(matchJiraIssueKey("AML-1", [])).toBeNull();
  });

  it("builds the browse URL regardless of a trailing slash", () => {
    expect(buildJiraIssueUrl("https://jira.example.com/", "AML-1234")).toBe(
      "https://jira.example.com/browse/AML-1234",
    );
    expect(buildJiraIssueUrl("https://jira.example.com", "aml-1234")).toBe(
      "https://jira.example.com/browse/AML-1234",
    );
  });
});

describe("Jira contracts", () => {
  const timestamp = "2026-08-22T10:00:00.000Z";

  it("stores prefixes upper-case and rejects malformed ones", () => {
    expect(JiraIssuePrefixSchema.parse(" aml ")).toBe("AML");
    expect(JiraIssuePrefixSchema.safeParse("1AML").success).toBe(false);
    expect(JiraIssuePrefixSchema.safeParse("A-ML").success).toBe(false);
    expect(JiraIssuePrefixSchema.safeParse("").success).toBe(false);
  });

  it("requires at least one prefix on a configuration", () => {
    const base = {
      clientRequestId: randomUUID(),
      configId: null,
      name: "Firmen-Jira",
      baseUrl: "https://jira.example.com",
    };
    expect(
      SaveJiraConfigInputSchema.parse({ ...base, issuePrefixes: ["aml", "BUG"] }).issuePrefixes,
    ).toEqual(["AML", "BUG"]);
    expect(
      SaveJiraConfigInputSchema.safeParse({ ...base, issuePrefixes: [] }).success,
    ).toBe(false);
    expect(
      SaveJiraConfigInputSchema.safeParse({ ...base, baseUrl: "jira.example.com", issuePrefixes: ["AML"] })
        .success,
    ).toBe(false);
  });

  it("keeps the activation singular and self-consistent", () => {
    const projectId = randomUUID();
    const config = JiraConfigSchema.parse({
      id: randomUUID(),
      name: "Firmen-Jira",
      baseUrl: "https://jira.example.com",
      issuePrefixes: ["AML"],
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(
      JiraProjectIntegrationSchema.safeParse({
        projectId,
        activeConfigId: null,
        activeConfig: null,
        updatedAt: null,
      }).success,
    ).toBe(true);
    expect(
      JiraProjectIntegrationSchema.safeParse({
        projectId,
        activeConfigId: config.id,
        activeConfig: config,
        updatedAt: timestamp,
      }).success,
    ).toBe(true);
    // An activation pointing at nothing must not typecheck as "on".
    expect(
      JiraProjectIntegrationSchema.safeParse({
        projectId,
        activeConfigId: config.id,
        activeConfig: null,
        updatedAt: timestamp,
      }).success,
    ).toBe(false);

    expect(
      ActivateJiraProjectIntegrationInputSchema.safeParse({
        clientRequestId: randomUUID(),
        projectId,
        configId: config.id,
      }).success,
    ).toBe(true);
  });

  it("only accepts a full issue key when attaching", () => {
    const base = {
      clientRequestId: randomUUID(),
      projectId: randomUUID(),
      sessionId: randomUUID(),
    };
    expect(AttachJiraIssueInputSchema.parse({ ...base, issueKey: "aml-12" }).issueKey).toBe(
      "AML-12",
    );
    expect(AttachJiraIssueInputSchema.safeParse({ ...base, issueKey: "AML" }).success).toBe(false);
  });
});
