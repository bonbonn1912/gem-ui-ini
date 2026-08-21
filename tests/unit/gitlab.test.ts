import { describe, expect, it } from "vitest";
import { parseGitLabRemoteUrl, sanitizeRemoteUrl } from "../../src/main/integrations/gitlab/remote-url-parser";
import { MergeRequestResolver } from "../../src/main/integrations/gitlab/merge-request-resolver";
import { mapGitLabDiscussions } from "../../src/main/integrations/gitlab/discussion-mapper";
import { ReviewContextSnapshotStore } from "../../src/main/integrations/gitlab/review-context-snapshot-store";
import { GitLabRepository } from "../../src/main/storage/repositories/gitlab-repository";
import { openSqliteDatabase } from "../../src/main/storage/database";
import { ProjectRepository } from "../../src/main/storage/repositories/project-repository";
import { randomUUID } from "node:crypto";
import { GitLabDiscussionSchema } from "../../src/shared/contracts/gitlab";

describe("GitLab Remote URL Parser", () => {
  it("parses HTTPS URLs with and without .git", () => {
    const parsed1 = parseGitLabRemoteUrl("https://gitlab.example.com/team/backend/api.git");
    expect(parsed1).toMatchObject({
      instanceUrl: "https://gitlab.example.com",
      host: "gitlab.example.com",
      projectPath: "team/backend/api",
    });

    const parsed2 = parseGitLabRemoteUrl("https://gitlab.com/group/project");
    expect(parsed2).toMatchObject({
      instanceUrl: "https://gitlab.com",
      host: "gitlab.com",
      projectPath: "group/project",
    });
  });

  it("parses SSH and SCP-like URLs", () => {
    const scp = parseGitLabRemoteUrl("git@gitlab.company.org:dept/repo.git");
    expect(scp).toMatchObject({
      instanceUrl: "https://gitlab.company.org",
      host: "gitlab.company.org",
      projectPath: "dept/repo",
    });

    const ssh = parseGitLabRemoteUrl("ssh://git@gitlab.company.org:2222/dept/repo.git");
    expect(ssh).toMatchObject({
      instanceUrl: "https://gitlab.company.org",
      host: "gitlab.company.org",
      projectPath: "dept/repo",
    });
  });

  it("sanitizes credentials from remote URLs", () => {
    const clean = sanitizeRemoteUrl("https://oauth2:glpat-secret123@gitlab.com/org/repo.git");
    expect(clean).toBe("https://gitlab.com/org/repo.git");
  });
});

describe("GitLab Merge Request URL Resolver", () => {
  const resolver = new MergeRequestResolver();

  it("parses standard GitLab MR URLs", () => {
    const parsed = resolver.parseMergeRequestUrl(
      "https://gitlab.com",
      "https://gitlab.com/gitlab-org/gitlab/-/merge_requests/12345",
    );
    expect(parsed).toEqual({
      projectPath: "gitlab-org/gitlab",
      mergeRequestIid: 12345,
    });
  });

  it("parses nested subgroup MR URLs", () => {
    const parsed = resolver.parseMergeRequestUrl(
      "https://gitlab.company.com",
      "https://gitlab.company.com/team/subgroup/core/service/-/merge_requests/42",
    );
    expect(parsed).toEqual({
      projectPath: "team/subgroup/core/service",
      mergeRequestIid: 42,
    });
  });

  it("rejects MR URLs from a different instance", () => {
    const parsed = resolver.parseMergeRequestUrl(
      "https://gitlab.company.com",
      "https://gitlab.com/other/project/-/merge_requests/42",
    );
    expect(parsed).toBeNull();
  });
});

describe("GitLab API Client", () => {
  it("encodes project paths with slashes correctly in endpoints", async () => {
    const { GitLabApiClient } = await import("../../src/main/integrations/gitlab/gitlab-api-client");

    const requestedUrls: string[] = [];
    const mockFetch = async (url: string | URL | Request) => {
      requestedUrls.push(String(url));
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const client = new GitLabApiClient({
      instanceUrl: "https://gitlab.com",
      token: "test-token",
      fetchFn: mockFetch as any,
    });

    await client.listMergeRequests("dw191299/bonbot", { state: "opened" });
    expect(requestedUrls[0]).toContain("/projects/dw191299%2Fbonbot/merge_requests");
  });
});

describe("GitLab Discussion Mapper", () => {
  it("maps discussions, resolvability, notes and detects outdated diff positions", () => {
    const currentSha = "sha-head-current";
    const rawDiscussions = [
      {
        id: "disc-1",
        individual_note: false,
        notes: [
          {
            id: 101,
            type: "DiffNote",
            body: "Bitte hier refactorn",
            attachment: null,
            author: { id: 1, username: "alice", name: "Alice", state: "active", avatar_url: null, web_url: "" },
            created_at: "2026-08-20T10:00:00Z",
            updated_at: "2026-08-20T10:00:00Z",
            system: false,
            resolvable: true,
            resolved: false,
            resolved_by: null,
            position: {
              base_sha: "sha-base",
              start_sha: "sha-start",
              head_sha: "sha-head-old",
              old_path: "src/utils.ts",
              new_path: "src/utils.ts",
              position_type: "text",
              old_line: null,
              new_line: 42,
            },
          },
        ],
      },
      {
        id: "disc-2",
        individual_note: false,
        notes: [
          {
            id: 102,
            type: "DiffNote",
            body: "Sieht gut aus",
            attachment: null,
            author: { id: 2, username: "bob", name: "Bob", state: "active", avatar_url: null, web_url: "" },
            created_at: "2026-08-20T11:00:00Z",
            updated_at: "2026-08-20T11:00:00Z",
            system: false,
            resolvable: true,
            resolved: true,
            resolved_by: { id: 1, username: "alice", name: "Alice", state: "active", avatar_url: null, web_url: "" },
            position: {
              base_sha: "sha-base",
              start_sha: "sha-start",
              head_sha: currentSha,
              old_path: "src/app.ts",
              new_path: "src/app.ts",
              position_type: "text",
              old_line: null,
              new_line: 10,
            },
          },
        ],
      },
    ];

    const mapped = mapGitLabDiscussions(rawDiscussions as any, currentSha);
    expect(mapped).toHaveLength(2);

    // Discussion 1: unresolved, position outdated
    expect(mapped[0]?.resolvable).toBe(true);
    expect(mapped[0]?.resolved).toBe(false);
    expect(mapped[0]?.notes[0]?.position?.outdated).toBe(true);
    expect(mapped[0]?.notes[0]?.position?.newLine).toBe(42);

    // Discussion 2: resolved, position not outdated
    expect(mapped[1]?.resolvable).toBe(true);
    expect(mapped[1]?.resolved).toBe(true);
    expect(mapped[1]?.notes[0]?.position?.outdated).toBe(false);
    expect(mapped[1]?.notes[0]?.resolvedBy?.username).toBe("alice");
  });

  it("accepts unexpected line_range types (expanded/null/missing) without failing contract validation", () => {
    const sha = "a".repeat(40);
    const author = { id: 1, username: "alice", name: "Alice", avatar_url: null };
    const makeNote = (id: number, lineType: unknown, includeType: boolean) => ({
      id,
      type: "DiffNote",
      body: "Multi-line Kommentar",
      author,
      created_at: "2026-08-20T10:00:00Z",
      updated_at: "2026-08-20T10:00:00Z",
      system: false,
      resolvable: true,
      resolved: false,
      resolved_by: null,
      position: {
        position_type: "text",
        base_sha: sha,
        start_sha: sha,
        head_sha: sha,
        old_path: "src/utils.ts",
        new_path: "src/utils.ts",
        old_line: null,
        new_line: 12,
        line_range: {
          start: { line_code: "abc_10_10", old_line: null, new_line: 10, ...(includeType ? { type: lineType } : {}) },
          end: { line_code: "abc_12_12", old_line: null, new_line: 12, ...(includeType ? { type: lineType } : {}) },
        },
      },
    });

    const rawDiscussions = [
      { id: "disc-expanded", individual_note: false, notes: [makeNote(201, "expanded", true)] },
      { id: "disc-null-type", individual_note: false, notes: [makeNote(202, null, true)] },
      { id: "disc-no-type", individual_note: false, notes: [makeNote(203, undefined, false)] },
      { id: "disc-future-type", individual_note: false, notes: [makeNote(204, "something_new", true)] },
    ];

    const mapped = mapGitLabDiscussions(rawDiscussions as never, sha);
    expect(mapped).toHaveLength(4);

    // Every mapped discussion must satisfy the IPC contract schema — one odd thread
    // must never invalidate the whole review state.
    for (const discussion of mapped) {
      expect(GitLabDiscussionSchema.safeParse(discussion).success).toBe(true);
    }

    expect(mapped[0]?.notes[0]?.position?.lineRange?.start.type).toBe("expanded");
    expect(mapped[1]?.notes[0]?.position?.lineRange?.start.type).toBeNull();
    expect(mapped[2]?.notes[0]?.position?.lineRange?.end.type).toBeNull();
    expect(mapped[3]?.notes[0]?.position?.lineRange?.start.type).toBe("something_new");

    // Line numbers used by the renderer stay intact.
    expect(mapped[0]?.notes[0]?.position?.lineRange?.start.newLine).toBe(10);
    expect(mapped[0]?.notes[0]?.position?.lineRange?.end.newLine).toBe(12);
  });

  it("maps unknown note types to \"unknown\" and drops non-absolute avatar URLs", () => {
    const rawDiscussions = [
      {
        id: "disc-unknown-note-type",
        individual_note: true,
        notes: [
          {
            id: 301,
            type: "SomeFutureNote",
            body: "Hinweis",
            author: { id: 3, username: "carol", name: "Carol", avatar_url: "/uploads/-/system/user/avatar/3/avatar.png" },
            created_at: "2026-08-20T10:00:00Z",
            updated_at: "2026-08-20T10:00:00Z",
            system: false,
            resolvable: false,
            resolved: false,
            resolved_by: null,
            position: null,
          },
        ],
      },
    ];

    const mapped = mapGitLabDiscussions(rawDiscussions as never, null);
    expect(GitLabDiscussionSchema.safeParse(mapped[0]).success).toBe(true);
    expect(mapped[0]?.notes[0]?.type).toBe("unknown");
    expect(mapped[0]?.notes[0]?.author.avatarUrl).toBeNull();
  });
});

describe("ReviewContextSnapshotStore", () => {
  it("stores and single-consumes prompt context snapshots", () => {
    const store = new ReviewContextSnapshotStore(1000);
    const prepared = {
      ref: { kind: "gitlab_review" as const, id: "test-ref-1" },
      title: "GitLab Review · test/proj!42",
      repositoryLabel: "test/proj",
      mergeRequestReference: "test/proj!42: Fix stuff",
      filePath: "src/main.ts",
      startLine: 10,
      endLine: 20,
      contextMode: "affected_lines" as const,
      estimatedChars: 500,
      expiresAt: new Date(Date.now() + 1000).toISOString(),
      warnings: [],
    };
    const parts = [{ type: "text" as const, text: "Prompt text" }];

    const refId = store.saveSnapshot(prepared, parts);
    expect(refId).toBe("test-ref-1");

    // First consumption succeeds
    const consumed = store.consumeSnapshot("test-ref-1");
    expect(consumed).not.toBeNull();
    expect(consumed?.parts).toEqual(parts);
    expect(consumed?.snapshot.title).toBe(prepared.title);

    // Second consumption returns null (one-time use)
    const second = store.consumeSnapshot("test-ref-1");
    expect(second).toBeNull();
  });
});

describe("GitLabRepository Storage", () => {
  it("persists connections and bindings with transaction safety", () => {
    const db = openSqliteDatabase(":memory:");
    try {
      const gitlabRepo = new GitLabRepository(db);
      const projectRepo = new ProjectRepository(db);

      const projId = randomUUID();
      const rootId = randomUUID();
      const now = new Date().toISOString();
      const proj = projectRepo.create(
        {
          id: projId,
          name: "Test Project",
          primaryRootId: rootId,
          rootRevision: 1,
          rootFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          approvalModeId: null,
          approvalModeState: "gemini_default",
          archived: false,
          createdAt: now,
          updatedAt: now,
        },
        [
          {
            id: rootId,
            projectId: projId,
            kind: "primary",
            path: "/path/to/repo",
            realPath: "/path/to/repo",
            label: "repo",
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
          },
        ],
      );
      const conn = gitlabRepo.saveConnection({
        id: randomUUID(),
        instanceUrl: "https://gitlab.com",
        apiBaseUrl: "https://gitlab.com/api/v4",
        userId: 12345,
        username: "devuser",
        displayName: "Developer",
        tokenCipher: "encrypted_token_hex",
        accessMode: "read_write",
        scopes: ["api"],
        allowSelfSignedTls: true,
        expiresAt: null,
        lastValidatedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      expect(conn.user.username).toBe("devuser");
      expect(conn.tokenConfigured).toBe(true);
      expect(conn.allowSelfSignedTls).toBe(true);

      const binding = gitlabRepo.saveBinding({
        id: randomUUID(),
        projectId: proj.id,
        rootId: proj.roots[0]!.id,
        connectionId: conn.id,
        repositoryKey: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        remoteName: "origin",
        remoteUrl: "https://gitlab.com/org/repo.git",
        sourceProjectId: 100,
        sourceProjectPath: "org/repo",
        enabled: true,
        selectedTargetProjectId: null,
        selectedTargetProjectPath: null,
        selectedMergeRequestIid: null,
        lastSyncedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      expect(binding.enabled).toBe(true);

      // Disable binding
      gitlabRepo.disableBinding(binding.id);
      const foundBinding = gitlabRepo.findBinding(binding.id);
      expect(foundBinding?.enabled).toBe(false);

      // Removing connection disables bindings
      gitlabRepo.removeConnection(conn.id, true);
      expect(gitlabRepo.findConnection(conn.id)).toBeNull();
    } finally {
      db.close();
    }
  });

  it("encrypts and decrypts tokens seamlessly via AES-GCM fallback", async () => {
    const { GitLabTokenVault, AesGcmSecretStorageAdapter, HybridSecretStorageAdapter } = await import(
      "../../src/main/integrations/gitlab/gitlab-token-vault"
    );

    const rawKey = Buffer.alloc(32, 7);
    const adapter = new AesGcmSecretStorageAdapter(rawKey);
    const cipher = await adapter.encrypt("glpat-secret-test-token-12345");
    expect(cipher.length).toBeGreaterThan(28);

    const decrypted = await adapter.decrypt(cipher);
    expect(decrypted).toBe("glpat-secret-test-token-12345");

    // Test Hybrid Vault with fallback
    const hybrid = new HybridSecretStorageAdapter(undefined, adapter);
    const hybridVault = new GitLabTokenVault(hybrid);

    const tokenCipher = await hybridVault.encryptToken("glpat-my-secure-personal-token");
    expect(tokenCipher.length).toBeGreaterThan(28);

    const result = await hybridVault.withDecryptedToken(tokenCipher, async (token) => {
      return `Used token: ${token}`;
    });
    expect(result).toBe("Used token: glpat-my-secure-personal-token");
  });
});
