import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { JiraService } from "../../src/main/integrations/jira/jira-service";
import {
  JiraRepository,
  openSqliteDatabase,
  ProjectRepository,
} from "../../src/main/storage";
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

describe("JiraService attachIssue", () => {
  it("attaches Jira issue with defaultInclude: false so it is not active for the prompt by default", async () => {
    const database = openSqliteDatabase(":memory:");
    try {
      const jiraRepo = new JiraRepository(database);
      const ingestLink = vi.fn().mockResolvedValue({
        id: randomUUID(),
        projectId: randomUUID(),
        scope: "session",
        sessionId: randomUUID(),
        title: "AML-1234",
        url: "https://jira.example.com/browse/AML-1234",
      });

      const jiraService = new JiraService({
        repository: jiraRepo,
        contextAttachments: { ingestLink },
      });

      const projectRepo = new ProjectRepository(database);
      const projectId = randomUUID();
      const sessionId = randomUUID();
      const rootId = randomUUID();

      projectRepo.create(
        {
          id: projectId,
          name: "Test Project",
          primaryRootId: rootId,
          rootRevision: 1,
          rootFingerprint: "a".repeat(64),
          approvalModeId: null,
          approvalModeState: "gemini_default",
          archived: false,
          createdAt: "2026-08-22T10:00:00.000Z",
          updatedAt: "2026-08-22T10:00:00.000Z",
        },
        [
          {
            id: rootId,
            projectId,
            kind: "primary",
            path: "/tmp/primary",
            realPath: "/tmp/primary",
            label: "primary",
            sortOrder: 0,
            createdAt: "2026-08-22T10:00:00.000Z",
            updatedAt: "2026-08-22T10:00:00.000Z",
          },
        ],
      );

      const config = await jiraService.saveConfig({
        clientRequestId: randomUUID(),
        name: "Firmen-Jira",
        baseUrl: "https://jira.example.com",
        issuePrefixes: ["AML"],
      });

      await jiraService.activate({
        clientRequestId: randomUUID(),
        projectId,
        configId: config.id,
      });

      const clientRequestId = randomUUID();
      const result = await jiraService.attachIssue({
        clientRequestId,
        projectId,
        sessionId,
        issueKey: "AML-1234",
      });

      expect(result.match.issueKey).toBe("AML-1234");
      expect(result.match.url).toBe("https://jira.example.com/browse/AML-1234");

      expect(ingestLink).toHaveBeenCalledWith({
        clientRequestId,
        projectId,
        scope: "session",
        sessionId,
        url: "https://jira.example.com/browse/AML-1234",
        title: "AML-1234",
        origin: "manual",
        defaultInclude: false,
      });
    } finally {
      database.close();
    }
  });
});
