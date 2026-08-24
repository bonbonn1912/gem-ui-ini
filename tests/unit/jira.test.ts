import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { ContextAttachmentService } from "../../src/main/context-attachments";
import {
  buildJiraAuthHeader,
  convertAdfToMarkdown,
  convertJiraWikiMarkupToMarkdown,
  isJiraCloudUrl,
  parseRawJiraIssue,
} from "../../src/main/integrations/jira/jira-client";
import { JiraService } from "../../src/main/integrations/jira/jira-service";
import { JiraTokenVault } from "../../src/main/integrations/jira/jira-token-vault";
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
    expect(
      matchJiraIssueKey("BUG-7 hängt an AML-1234", ["AML", "BUG"])?.issueKey,
    ).toBe("BUG-7");
    expect(
      matchJiraIssueKey("AML-1234 hängt an BUG-7", ["AML", "BUG"])?.issueKey,
    ).toBe("AML-1234");
  });

  it("normalises case but keeps word boundaries", () => {
    expect(matchJiraIssueKey("fix aml-9 now", ["AML"])?.issueKey).toBe("AML-9");
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

  it("supports accessToken and email in SaveJiraConfigInput", () => {
    const base = {
      clientRequestId: randomUUID(),
      configId: null,
      name: "Firmen-Jira",
      baseUrl: "https://mycompany.atlassian.net",
      issuePrefixes: ["AML"],
      accessToken: "my-secret-token",
      email: "user@mycompany.com",
    };
    const parsed = SaveJiraConfigInputSchema.parse(base);
    expect(parsed.accessToken).toBe("my-secret-token");
    expect(parsed.email).toBe("user@mycompany.com");
  });

  it("keeps the activation singular and self-consistent", () => {
    const projectId = randomUUID();
    const config = JiraConfigSchema.parse({
      id: randomUUID(),
      name: "Firmen-Jira",
      baseUrl: "https://jira.example.com",
      issuePrefixes: ["AML"],
      hasAccessToken: true,
      email: "user@example.com",
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
    expect(
      JiraProjectIntegrationSchema.safeParse({
        projectId,
        activeConfigId: config.id,
        activeConfig: null,
        updatedAt: timestamp,
      }).success,
    ).toBe(false);
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

describe("JiraApiClient & Markdown conversion", () => {
  it("detects Jira Cloud vs Self-hosted URLs", () => {
    expect(isJiraCloudUrl("https://mycompany.atlassian.net")).toBe(true);
    expect(isJiraCloudUrl("https://jira.mycompany.atlassian.net")).toBe(true);
    expect(isJiraCloudUrl("https://jira.mycompany.com")).toBe(false);
    expect(isJiraCloudUrl("http://localhost:8080")).toBe(false);
  });

  it("builds auth headers for Cloud and Self-Hosted instances", () => {
    // Cloud with email + token
    const cloudHeader = buildJiraAuthHeader({
      baseUrl: "https://mycompany.atlassian.net",
      token: "secret-token",
      email: "alice@example.com",
    });
    expect(cloudHeader).toBe(`Basic ${Buffer.from("alice@example.com:secret-token").toString("base64")}`);

    // Self-hosted PAT
    const serverHeader = buildJiraAuthHeader({
      baseUrl: "https://jira.mycompany.com",
      token: "pat-token-12345",
    });
    expect(serverHeader).toBe("Bearer pat-token-12345");
  });

  it("converts Jira Wiki Markup to Markdown", () => {
    const wiki = `h1. Story Title
Here is *bold* text and _italic_ text and {{monospace}}.

h2. Details
* Bullet 1
* Bullet 2
** Nested bullet

# Step 1
# Step 2

{code:typescript}
const x: number = 42;
{code}

||Name||Role||
|Alice|Developer|
|Bob|Reviewer|

[Link to docs|https://example.com/docs]
bq. This is important
`;

    const md = convertJiraWikiMarkupToMarkdown(wiki);
    expect(md).toContain("# Story Title");
    expect(md).toContain("**bold**");
    expect(md).toContain("*italic*");
    expect(md).toContain("`monospace`");
    expect(md).toContain("## Details");
    expect(md).toContain("- Bullet 1");
    expect(md).toContain("  - Nested bullet");
    expect(md).toContain("1. Step 1");
    expect(md).toContain("```typescript\nconst x: number = 42;\n```");
    expect(md).toContain("| Name | Role |");
    expect(md).toContain("[Link to docs](https://example.com/docs)");
    expect(md).toContain("> This is important");
  });

  it("converts Atlassian Document Format (ADF) to Markdown", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Acceptance Criteria" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Please implement the " },
            {
              type: "text",
              text: "login feature",
              marks: [{ type: "strong" }],
            },
            { type: "text", text: " properly." },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Support SSO" }],
                },
              ],
            },
          ],
        },
        {
          type: "codeBlock",
          attrs: { language: "json" },
          content: [{ type: "text", text: '{\n  "auth": true\n}' }],
        },
      ],
    };

    const md = convertAdfToMarkdown(adf);
    expect(md).toContain("## Acceptance Criteria");
    expect(md).toContain("Please implement the **login feature** properly.");
    expect(md).toContain("- Support SSO");
    expect(md).toContain('```json\n{\n  "auth": true\n}\n```');
  });

  it("parses raw Jira issue response into structured story markdown", () => {
    const raw = {
      key: "AML-999",
      fields: {
        summary: "Benutzer-Authentifizierung via OIDC",
        description: "h2. Ziel\n* OIDC einbinden",
        status: { name: "In Bearbeitung" },
        issuetype: { name: "Story" },
        priority: { name: "Hoch" },
        assignee: { displayName: "Max Mustermann" },
        labels: ["backend", "security"],
      },
    };

    const issueDetails = parseRawJiraIssue(raw, "https://jira.example.com");
    expect(issueDetails.issueKey).toBe("AML-999");
    expect(issueDetails.summary).toBe("Benutzer-Authentifizierung via OIDC");
    expect(issueDetails.status).toBe("In Bearbeitung");
    expect(issueDetails.assignee).toBe("Max Mustermann");
    expect(issueDetails.storyMarkdown).toContain("# [AML-999] Benutzer-Authentifizierung via OIDC");
    expect(issueDetails.storyMarkdown).toContain("- **Status:** In Bearbeitung");
    expect(issueDetails.storyMarkdown).toContain("## Ziel");
  });
});

describe("JiraService with token & story.md attachment", () => {
  it("attaches story.md and link attachment when token is present", async () => {
    const database = openSqliteDatabase(":memory:");
    try {
      const jiraRepo = new JiraRepository(database);
      const ingestLink = vi.fn().mockResolvedValue({
        id: "link-att-1",
        projectId: "p1",
        scope: "session",
        sessionId: "s1",
        title: "AML-1234",
        url: "https://jira.example.com/browse/AML-1234",
      });

      const ingestText = vi.fn().mockResolvedValue({
        id: "story-att-1",
        projectId: "p1",
        scope: "session",
        sessionId: "s1",
        title: "AML-1234: story.md",
        fileName: "story.md",
      });

      const ingestBuffer = vi.fn().mockResolvedValue({
        id: "ctx-file-1",
        projectId: "p1",
        scope: "session",
        sessionId: "s1",
        title: "AML-1234: rechnung_error.png",
        fileName: "rechnung_error.png",
      });

      const list = vi.fn().mockReturnValue({ sessionAttachments: [] });
      const remove = vi.fn().mockResolvedValue({});

      const tokenVault = new JiraTokenVault();
      const jiraService = new JiraService({
        repository: jiraRepo,
        contextAttachments: {
          ingestLink,
          ingestText,
          ingestBuffer,
          list,
          remove,
        } as unknown as ContextAttachmentService,
        tokenVault,
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
          statsEnabled: false,
          liveTokensEnabled: false,
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

      // Save config with accessToken
      const config = await jiraService.saveConfig({
        clientRequestId: randomUUID(),
        name: "Firmen-Jira",
        baseUrl: "https://jira.example.com",
        issuePrefixes: ["AML"],
        accessToken: "secret-pat-token",
      });

      expect(config.hasAccessToken).toBe(true);

      await jiraService.activate({
        clientRequestId: randomUUID(),
        projectId,
        configId: config.id,
      });

      // Mock fetch for Jira API response
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          key: "AML-1234",
          fields: {
            summary: "Rechnungslauf reparieren",
            description: "h2. Fehler\nRechnungslauf bricht ab.",
            status: { name: "Open" },
            issuetype: { name: "Bug" },
            priority: { name: "Critical" },
            assignee: { displayName: "Dominik" },
            attachment: [
              {
                id: "att-100",
                filename: "rechnung_error.png",
                size: 2048,
                mimeType: "image/png",
                content: "https://jira.example.com/rest/api/2/attachment/content/att-100",
              },
            ],
          },
        }),
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const clientRequestId = randomUUID();
      const result = await jiraService.attachIssue({
        clientRequestId,
        projectId,
        sessionId,
        issueKey: "AML-1234",
      });

      expect(result.match.issueKey).toBe("AML-1234");
      expect(result.attachmentId).toBe("link-att-1");
      expect(result.storyAttachmentId).toBe("story-att-1");
      expect(result.summary).toBe("Rechnungslauf reparieren");
      expect(result.storyMarkdown).toContain("# [AML-1234] Rechnungslauf reparieren");

      expect(ingestText).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId,
          sessionId,
          fileName: "story.md",
          title: "AML-1234: story.md",
          defaultInclude: true,
        }),
      );

      // Re-attaching with existing story.md in session removes the old one
      list.mockReturnValue({
        sessionAttachments: [
          {
            id: "old-story-id",
            file: { displayName: "story.md" },
            title: "AML-1234: story.md",
          },
        ],
      });

      await jiraService.attachIssue({
        clientRequestId: randomUUID(),
        projectId,
        sessionId,
        issueKey: "AML-1234",
      });

      expect(remove).toHaveBeenCalledWith(
        expect.objectContaining({
          attachmentId: "old-story-id",
        }),
      );

      // Test fetchIssueDetails with attachments
      const details = await jiraService.fetchIssueDetails({
        projectId,
        issueKey: "AML-1234",
      });
      expect(details.issueKey).toBe("AML-1234");
      expect(details.summary).toBe("Rechnungslauf reparieren");
      expect(details.attachments).toHaveLength(1);
      expect(details.attachments[0].filename).toBe("rechnung_error.png");
      expect(details.attachments[0].size).toBe(2048);

      // Test syncAttachments
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("attachment/content")) {
          return {
            ok: true,
            arrayBuffer: async () => Buffer.from("fake-png-data").buffer,
          };
        }
        return {
          ok: true,
          json: async () => ({
            key: "AML-1234",
            fields: {
              summary: "Rechnungslauf reparieren",
              description: "h2. Fehler\nRechnungslauf bricht ab.",
              attachment: [
                {
                  id: "att-100",
                  filename: "rechnung_error.png",
                  size: 2048,
                  mimeType: "image/png",
                  content: "https://jira.example.com/rest/api/2/attachment/content/att-100",
                },
              ],
            },
          }),
        };
      });

      const syncResult = await jiraService.syncAttachments({
        clientRequestId: randomUUID(),
        projectId,
        sessionId,
        issueKey: "AML-1234",
      });

      expect(syncResult.syncedCount).toBe(1);
      expect(syncResult.attachmentIds).toEqual(["ctx-file-1"]);
      expect(ingestBuffer).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId,
          sessionId,
          fileName: "rechnung_error.png",
          title: "AML-1234: rechnung_error.png",
          defaultInclude: true,
        }),
      );
    } finally {
      database.close();
    }
  });
});
