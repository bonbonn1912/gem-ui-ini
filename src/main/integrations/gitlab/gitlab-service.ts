import { randomUUID } from "node:crypto";
import type {
  ConnectGitLabMergeRequestUrlInput,
  EnableGitLabBindingInput,
  GitLabAccessMode,
  GitLabConnectionSummary,
  GitLabDiscussion,
  GitLabMergeRequestSummary,
  GitLabRepositoryBinding,
  GitLabRepositoryCandidate,
  GitLabReviewState,
  PrepareGitLabReviewContextInput,
  PreparedExternalContext,
  ReplaceGitLabTokenInput,
  ReplyToGitLabDiscussionInput,
  ResolveGitLabDiscussionInput,
  SaveGitLabConnectionInput,
  SelectGitLabMergeRequestInput,
  TestGitLabConnectionInput,
} from "../../../shared/contracts";
import type { ProjectService } from "../../projects";
import type { GitLabRepository } from "../../storage";
import type { ExternalPromptContextProvider } from "../external-prompt-context-registry";
import { mapGitLabDiscussions } from "./discussion-mapper";
import { GitLabApiClient, normalizeApiBaseUrl } from "./gitlab-api-client";
import { GitLabTokenVault } from "./gitlab-token-vault";
import { MergeRequestResolver } from "./merge-request-resolver";
import { RepositoryBindingResolver } from "./repository-binding-resolver";
import { ReviewContextBuilder } from "./review-context-builder";
import { ReviewContextSnapshotStore } from "./review-context-snapshot-store";

export type GitLabServiceOptions = {
  gitlabRepository: GitLabRepository;
  tokenVault: GitLabTokenVault;
  projectService: ProjectService;
  getGitBinaryPath: () => string;
  bindingResolver?: RepositoryBindingResolver;
  mrResolver?: MergeRequestResolver;
  contextBuilder?: ReviewContextBuilder;
  snapshotStore?: ReviewContextSnapshotStore;
  fetchFn?: typeof fetch;
};

export class GitLabService implements ExternalPromptContextProvider {
  readonly #repo: GitLabRepository;
  readonly #vault: GitLabTokenVault;
  readonly #projects: ProjectService;
  readonly #getGitBinaryPath: () => string;
  readonly #bindingResolver: RepositoryBindingResolver;
  readonly #mrResolver: MergeRequestResolver;
  readonly #contextBuilder: ReviewContextBuilder;
  readonly #snapshotStore: ReviewContextSnapshotStore;
  readonly #fetchFn?: typeof fetch;

  constructor(options: GitLabServiceOptions) {
    this.#repo = options.gitlabRepository;
    this.#vault = options.tokenVault;
    this.#projects = options.projectService;
    this.#getGitBinaryPath = options.getGitBinaryPath;
    this.#bindingResolver = options.bindingResolver ?? new RepositoryBindingResolver(this.#repo);
    this.#mrResolver = options.mrResolver ?? new MergeRequestResolver();
    this.#contextBuilder = options.contextBuilder ?? new ReviewContextBuilder();
    this.#snapshotStore = options.snapshotStore ?? new ReviewContextSnapshotStore();
    this.#fetchFn = options.fetchFn;
  }

  async listRepositoryCandidates(projectId: string): Promise<GitLabRepositoryCandidate[]> {
    const access = await this.#projects.getCurrentAccess(projectId);
    const gitBinaryPath = this.#getGitBinaryPath();

    const allRoots = [access.primaryRoot, ...access.additionalRoots];

    return this.#bindingResolver.discoverCandidates({
      gitBinaryPath,
      projectId,
      roots: allRoots.map((r) => ({
        id: r.id,
        label: r.label,
        realPath: r.realPath,
      })),
    });
  }

  listConnections(): GitLabConnectionSummary[] {
    return this.#repo.listConnections();
  }

  async testConnection(input: TestGitLabConnectionInput): Promise<GitLabConnectionSummary> {
    const { instanceUrl, apiBaseUrl } = normalizeApiBaseUrl(input.instanceUrl);
    const client = new GitLabApiClient({
      instanceUrl,
      apiBaseUrl,
      token: input.token,
      allowSelfSignedTls: input.allowSelfSignedTls,
      fetchFn: this.#fetchFn,
    });

    const user = await client.getCurrentUser();
    const tokenMeta = await client.getPersonalAccessTokenSelf();

    const scopes = tokenMeta?.scopes ?? [];
    let access: GitLabAccessMode = "read_write";
    if (scopes.length > 0 && !scopes.includes("api") && scopes.includes("read_api")) {
      access = "read_only";
    }

    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      instanceUrl,
      apiBaseUrl,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        avatarUrl: null,
      },
      tokenConfigured: true,
      access,
      scopes,
      allowSelfSignedTls: Boolean(input.allowSelfSignedTls),
      expiresAt: tokenMeta?.expires_at ? new Date(tokenMeta.expires_at).toISOString() : null,
      lastValidatedAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  async saveConnection(input: SaveGitLabConnectionInput): Promise<GitLabConnectionSummary> {
    const validated = await this.testConnection({
      instanceUrl: input.instanceUrl,
      token: input.token,
      allowSelfSignedTls: input.allowSelfSignedTls,
    });

    const tokenCipher = await this.#vault.encryptToken(input.token);
    const now = new Date().toISOString();

    return this.#repo.saveConnection({
      id: validated.id,
      instanceUrl: validated.instanceUrl,
      apiBaseUrl: validated.apiBaseUrl,
      userId: validated.user.id,
      username: validated.user.username,
      displayName: validated.user.name,
      tokenCipher,
      accessMode: validated.access,
      scopes: validated.scopes,
      allowSelfSignedTls: validated.allowSelfSignedTls,
      expiresAt: validated.expiresAt,
      lastValidatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  async replaceToken(input: ReplaceGitLabTokenInput): Promise<GitLabConnectionSummary> {
    const connection = this.#repo.findConnection(input.connectionId);
    if (!connection) throw new Error("GitLab-Verbindung nicht gefunden.");

    const validated = await this.testConnection({
      instanceUrl: connection.instanceUrl,
      token: input.token,
      allowSelfSignedTls: input.allowSelfSignedTls ?? connection.allowSelfSignedTls,
    });

    if (validated.user.id !== connection.user.id) {
      throw new Error(
        `Der neue Token gehört zu Benutzer @${validated.user.username}, erwartet wurde @${connection.user.username}.`,
      );
    }

    const tokenCipher = await this.#vault.encryptToken(input.token);
    const now = new Date().toISOString();

    return this.#repo.updateConnectionToken(connection.id, {
      tokenCipher,
      accessMode: validated.access,
      scopes: validated.scopes,
      allowSelfSignedTls: validated.allowSelfSignedTls,
      expiresAt: validated.expiresAt,
      lastValidatedAt: now,
      updatedAt: now,
    });
  }

  removeConnection(input: { connectionId: string; forceDisableBindings?: boolean }): void {
    this.#repo.removeConnection(input.connectionId, input.forceDisableBindings);
  }

  async enableBinding(input: EnableGitLabBindingInput): Promise<GitLabRepositoryBinding> {
    const access = await this.#projects.getCurrentAccess(input.projectId);
    if (input.expectedRootRevision !== access.rootRevision) {
      throw new Error("Die Projektordner wurden geändert. Bitte erneut versuchen.");
    }

    const connection = this.#repo.findConnection(input.connectionId);
    if (!connection) throw new Error("GitLab-Verbindung nicht gefunden.");

    const now = new Date().toISOString();
    const binding: GitLabRepositoryBinding = {
      id: randomUUID(),
      projectId: input.projectId,
      rootId: input.rootId,
      connectionId: input.connectionId,
      repositoryKey: input.repositoryKey,
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
      sourceProjectId: input.sourceProjectId,
      sourceProjectPath: input.sourceProjectPath,
      enabled: true,
      selectedTargetProjectId: null,
      selectedTargetProjectPath: null,
      selectedMergeRequestIid: null,
      lastSyncedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    return this.#repo.saveBinding(binding);
  }

  async disableBinding(projectId: string, bindingId: string): Promise<void> {
    const binding = this.#repo.findBinding(bindingId);
    if (!binding || binding.projectId !== projectId) {
      throw new Error("GitLab-Binding nicht gefunden.");
    }
    this.#repo.disableBinding(bindingId);
  }

  async listMergeRequests(
    projectId: string,
    bindingId: string,
  ): Promise<GitLabMergeRequestSummary[]> {
    const binding = this.#repo.findBinding(bindingId);
    if (!binding || binding.projectId !== projectId || !binding.enabled) {
      throw new Error("Aktives GitLab-Binding nicht gefunden.");
    }

    const connection = this.#repo.findConnection(binding.connectionId);
    if (!connection) throw new Error("GitLab-Verbindung nicht gefunden.");

    const cipher = this.#repo.getConnectionTokenCipher(connection.id);
    return this.#vault.withDecryptedToken(cipher, async (token) => {
      const client = new GitLabApiClient({
        instanceUrl: connection.instanceUrl,
        apiBaseUrl: connection.apiBaseUrl,
        token,
        allowSelfSignedTls: connection.allowSelfSignedTls,
        fetchFn: this.#fetchFn,
      });

      // Get candidates to find branch
      const candidates = await this.listRepositoryCandidates(projectId);
      const candidate = candidates.find((c) => c.binding?.id === bindingId);
      const branch = candidate?.branch;

      if (branch) {
        return this.#mrResolver.findMergeRequestsForBranch(
          client,
          binding.sourceProjectId,
          binding.sourceProjectPath,
          branch,
        );
      }

      // If detached or no branch, return open MRs of source project
      const rawList = await client.listMergeRequests(binding.sourceProjectId, { state: "opened" });
      return rawList.map((raw) => ({
        targetProjectId: raw.target_project_id ?? raw.project_id,
        targetProjectPath: binding.sourceProjectPath,
        iid: raw.iid,
        title: raw.title,
        webUrl: raw.web_url,
        state: raw.state as "opened" | "closed" | "locked" | "merged",
        draft: Boolean(raw.draft || raw.work_in_progress),
        sourceBranch: raw.source_branch,
        targetBranch: raw.target_branch,
        sourceProjectId: raw.source_project_id ?? raw.project_id,
        headSha: raw.diff_refs?.head_sha ?? raw.sha,
        baseSha: raw.diff_refs?.base_sha ?? null,
        startSha: raw.diff_refs?.start_sha ?? null,
        author: {
          id: raw.author.id,
          username: raw.author.username,
          name: raw.author.name,
          avatarUrl: raw.author.avatar_url ?? null,
        },
        unresolvedCount: raw.user_notes_count ?? 0,
        updatedAt: raw.updated_at,
      }));
    });
  }

  async selectMergeRequest(
    input: SelectGitLabMergeRequestInput,
  ): Promise<GitLabRepositoryBinding> {
    const binding = this.#repo.findBinding(input.bindingId);
    if (!binding || binding.projectId !== input.projectId || !binding.enabled) {
      throw new Error("Aktives GitLab-Binding nicht gefunden.");
    }

    const now = new Date().toISOString();
    return this.#repo.updateBindingSelection(input.bindingId, {
      selectedTargetProjectId: input.targetProjectId,
      selectedTargetProjectPath: input.targetProjectPath,
      selectedMergeRequestIid: input.mergeRequestIid,
      lastSyncedAt: now,
      updatedAt: now,
    });
  }

  async connectMergeRequestUrl(
    input: ConnectGitLabMergeRequestUrlInput,
  ): Promise<GitLabRepositoryBinding> {
    const binding = this.#repo.findBinding(input.bindingId);
    if (!binding || binding.projectId !== input.projectId || !binding.enabled) {
      throw new Error("Aktives GitLab-Binding nicht gefunden.");
    }

    const connection = this.#repo.findConnection(binding.connectionId);
    if (!connection) throw new Error("GitLab-Verbindung nicht gefunden.");

    const parsed = this.#mrResolver.parseMergeRequestUrl(connection.instanceUrl, input.mergeRequestUrl);
    if (!parsed) {
      throw new Error("Die Merge-Request-URL gehört nicht zur konfigurierten GitLab-Instanz oder ist ungültig.");
    }

    const cipher = this.#repo.getConnectionTokenCipher(connection.id);
    const mr = await this.#vault.withDecryptedToken(cipher, async (token) => {
      const client = new GitLabApiClient({
        instanceUrl: connection.instanceUrl,
        apiBaseUrl: connection.apiBaseUrl,
        token,
        allowSelfSignedTls: connection.allowSelfSignedTls,
        fetchFn: this.#fetchFn,
      });
      return this.#mrResolver.resolveMergeRequestByUrl(client, parsed.projectPath, parsed.mergeRequestIid);
    });

    const now = new Date().toISOString();
    return this.#repo.updateBindingSelection(input.bindingId, {
      selectedTargetProjectId: mr.targetProjectId,
      selectedTargetProjectPath: mr.targetProjectPath,
      selectedMergeRequestIid: mr.iid,
      lastSyncedAt: now,
      updatedAt: now,
    });
  }

  async getReviewState(
    projectId: string,
    bindingId: string,
  ): Promise<GitLabReviewState> {
    const binding = this.#repo.findBinding(bindingId);
    if (!binding || binding.projectId !== projectId || !binding.enabled) {
      throw new Error("Aktives GitLab-Binding nicht gefunden.");
    }

    const connection = this.#repo.findConnection(binding.connectionId);
    if (!connection) throw new Error("GitLab-Verbindung nicht gefunden.");

    const candidates = await this.listRepositoryCandidates(projectId);
    const candidate = candidates.find((c) => c.binding?.id === bindingId);
    const repositoryDisplayName = candidate?.displayName || binding.sourceProjectPath;

    const cipher = this.#repo.getConnectionTokenCipher(connection.id);
    return this.#vault.withDecryptedToken(cipher, async (token) => {
      const client = new GitLabApiClient({
        instanceUrl: connection.instanceUrl,
        apiBaseUrl: connection.apiBaseUrl,
        token,
        allowSelfSignedTls: connection.allowSelfSignedTls,
        fetchFn: this.#fetchFn,
      });

      let mrSummary: GitLabMergeRequestSummary | null = null;
      let discussions: GitLabDiscussion[] = [];

      let targetProjectId = binding.selectedTargetProjectId;
      let mrIid = binding.selectedMergeRequestIid;

      // If no MR is selected yet, try to auto-select matching branch MR
      if (!targetProjectId || !mrIid) {
        if (candidate?.branch) {
          const mrs = await this.#mrResolver.findMergeRequestsForBranch(
            client,
            binding.sourceProjectId,
            binding.sourceProjectPath,
            candidate.branch,
          );
          if (mrs.length === 1) {
            const first = mrs[0]!;
            targetProjectId = first.targetProjectId;
            mrIid = first.iid;
            this.#repo.updateBindingSelection(bindingId, {
              selectedTargetProjectId: targetProjectId,
              selectedTargetProjectPath: first.targetProjectPath,
              selectedMergeRequestIid: mrIid,
              updatedAt: new Date().toISOString(),
            });
            mrSummary = first;
          }
        }
      }

      if (targetProjectId && mrIid) {
        if (!mrSummary) {
          const rawMr = await client.getMergeRequest(targetProjectId, mrIid);
          mrSummary = {
            targetProjectId: rawMr.target_project_id ?? rawMr.project_id,
            targetProjectPath: binding.selectedTargetProjectPath || binding.sourceProjectPath,
            iid: rawMr.iid,
            title: rawMr.title,
            webUrl: rawMr.web_url,
            state: rawMr.state as "opened" | "closed" | "locked" | "merged",
            draft: Boolean(rawMr.draft || rawMr.work_in_progress),
            sourceBranch: rawMr.source_branch,
            targetBranch: rawMr.target_branch,
            sourceProjectId: rawMr.source_project_id ?? rawMr.project_id,
            headSha: rawMr.diff_refs?.head_sha ?? rawMr.sha,
            baseSha: rawMr.diff_refs?.base_sha ?? null,
            startSha: rawMr.diff_refs?.start_sha ?? null,
            author: {
              id: rawMr.author.id,
              username: rawMr.author.username,
              name: rawMr.author.name,
              avatarUrl: rawMr.author.avatar_url ?? null,
            },
            unresolvedCount: rawMr.user_notes_count ?? 0,
            updatedAt: rawMr.updated_at,
          };
        }

        const rawDiscussions = await client.listDiscussions(targetProjectId, mrIid);
        discussions = mapGitLabDiscussions(rawDiscussions, mrSummary.headSha);
      }

      const unresolvedCount = discussions.filter((d) => d.resolvable && !d.resolved).length;

      return {
        projectId,
        bindingId,
        repositoryDisplayName,
        connection,
        binding: this.#repo.findBinding(bindingId) ?? binding,
        mergeRequest: mrSummary,
        discussions,
        totalDiscussionsCount: discussions.length,
        unresolvedDiscussionsCount: unresolvedCount,
        lastRefreshedAt: new Date().toISOString(),
      };
    });
  }

  async prepareReviewContext(
    input: PrepareGitLabReviewContextInput,
  ): Promise<PreparedExternalContext> {
    const state = await this.getReviewState(input.projectId, input.bindingId);
    if (!state.mergeRequest) {
      throw new Error("Kein Merge Request für dieses Binding ausgewählt.");
    }
    const discussion = state.discussions.find((d) => d.id === input.discussionId);
    if (!discussion) {
      throw new Error("Review-Diskussion nicht gefunden.");
    }

    const access = await this.#projects.getCurrentAccess(input.projectId);
    const allRoots = [access.primaryRoot, ...access.additionalRoots];
    const root = allRoots.find((r) => r.id === state.binding.rootId) ?? access.primaryRoot;

    const cipher = this.#repo.getConnectionTokenCipher(state.connection.id);
    const { prepared, parts } = await this.#vault.withDecryptedToken(cipher, async (token) => {
      const client = new GitLabApiClient({
        instanceUrl: state.connection.instanceUrl,
        apiBaseUrl: state.connection.apiBaseUrl,
        token,
        allowSelfSignedTls: state.connection.allowSelfSignedTls,
        fetchFn: this.#fetchFn,
      });

      return this.#contextBuilder.build({
        gitBinaryPath: this.#getGitBinaryPath(),
        worktreePath: root.realPath,
        client,
        targetProjectId: input.targetProjectId,
        mergeRequest: state.mergeRequest!,
        discussion,
        selectedNoteId: input.selectedNoteId,
        contextMode: input.contextMode,
        repositoryLabel: state.repositoryDisplayName,
      });
    });

    const refId = this.#snapshotStore.saveSnapshot(prepared, parts);
    return {
      ...prepared,
      ref: { kind: "gitlab_review", id: refId },
    };
  }

  async resolveDiscussion(
    input: ResolveGitLabDiscussionInput,
  ): Promise<GitLabDiscussion> {
    const binding = this.#repo.findBinding(input.bindingId);
    if (!binding || binding.projectId !== input.projectId || !binding.enabled) {
      throw new Error("Aktives GitLab-Binding nicht gefunden.");
    }

    const connection = this.#repo.findConnection(binding.connectionId);
    if (!connection) throw new Error("GitLab-Verbindung nicht gefunden.");

    const cipher = this.#repo.getConnectionTokenCipher(connection.id);
    return this.#vault.withDecryptedToken(cipher, async (token) => {
      const client = new GitLabApiClient({
        instanceUrl: connection.instanceUrl,
        apiBaseUrl: connection.apiBaseUrl,
        token,
        allowSelfSignedTls: connection.allowSelfSignedTls,
        fetchFn: this.#fetchFn,
      });

      const updated = await client.resolveDiscussion(
        input.targetProjectId,
        input.mergeRequestIid,
        input.discussionId,
        input.resolved,
      );

      const mapped = mapGitLabDiscussions([updated], null);
      if (!mapped[0]) throw new Error("Discussion konnte nach Aktualisierung nicht gelesen werden.");
      return mapped[0];
    });
  }

  async replyToDiscussion(
    input: ReplyToGitLabDiscussionInput,
  ): Promise<GitLabDiscussion> {
    const binding = this.#repo.findBinding(input.bindingId);
    if (!binding || binding.projectId !== input.projectId || !binding.enabled) {
      throw new Error("Aktives GitLab-Binding nicht gefunden.");
    }

    const connection = this.#repo.findConnection(binding.connectionId);
    if (!connection) throw new Error("GitLab-Verbindung nicht gefunden.");

    const cipher = this.#repo.getConnectionTokenCipher(connection.id);
    return this.#vault.withDecryptedToken(cipher, async (token) => {
      const client = new GitLabApiClient({
        instanceUrl: connection.instanceUrl,
        apiBaseUrl: connection.apiBaseUrl,
        token,
        allowSelfSignedTls: connection.allowSelfSignedTls,
        fetchFn: this.#fetchFn,
      });

      await client.replyToDiscussion(
        input.targetProjectId,
        input.mergeRequestIid,
        input.discussionId,
        input.body,
      );

      // Re-fetch discussion to get updated notes & author
      const discussions = await client.listDiscussions(input.targetProjectId, input.mergeRequestIid);
      const mapped = mapGitLabDiscussions(discussions, null);
      const found = mapped.find((d) => d.id === input.discussionId);
      if (!found) throw new Error("Discussion nach Antwort nicht gefunden.");
      return found;
    });
  }

  async resolveContext(refId: string) {
    const item = this.#snapshotStore.consumeSnapshot(refId);
    if (!item) {
      throw new Error("Vorbereiteter GitLab-Reviewkontext ist abgelaufen oder wurde bereits gesendet.");
    }
    return item;
  }
}
