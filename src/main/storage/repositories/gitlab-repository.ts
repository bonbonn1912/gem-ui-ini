import type { SqliteDatabase } from "../database";
import type {
  GitLabAccessMode,
  GitLabConnectionSummary,
  GitLabRepositoryBinding,
} from "../../../shared/contracts";

type ConnectionRow = {
  id: string;
  instance_url: string;
  api_base_url: string;
  user_id: number;
  username: string;
  display_name: string;
  token_cipher: Buffer;
  access_mode: GitLabAccessMode;
  scopes_json: string;
  allow_self_signed_tls: number;
  expires_at: string | null;
  last_validated_at: string;
  created_at: string;
  updated_at: string;
};

type BindingRow = {
  id: string;
  project_id: string;
  root_id: string;
  connection_id: string;
  repository_key: string;
  remote_name: string;
  remote_url: string;
  source_project_id: number;
  source_project_path: string;
  enabled: number;
  selected_target_project_id: number | null;
  selected_target_project_path: string | null;
  selected_merge_request_iid: number | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

function rowToConnectionSummary(row: ConnectionRow): GitLabConnectionSummary {
  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(row.scopes_json);
    if (Array.isArray(parsed)) scopes = parsed.filter((s) => typeof s === "string");
  } catch {
    scopes = [];
  }

  return {
    id: row.id,
    instanceUrl: row.instance_url,
    apiBaseUrl: row.api_base_url,
    user: {
      id: row.user_id,
      username: row.username,
      name: row.display_name,
      avatarUrl: null,
    },
    tokenConfigured: true,
    access: row.access_mode,
    scopes,
    allowSelfSignedTls: row.allow_self_signed_tls === 1,
    expiresAt: row.expires_at,
    lastValidatedAt: row.last_validated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToBinding(row: BindingRow): GitLabRepositoryBinding {
  return {
    id: row.id,
    projectId: row.project_id,
    rootId: row.root_id,
    connectionId: row.connection_id,
    repositoryKey: row.repository_key,
    remoteName: row.remote_name,
    remoteUrl: row.remote_url,
    sourceProjectId: row.source_project_id,
    sourceProjectPath: row.source_project_path,
    enabled: row.enabled === 1,
    selectedTargetProjectId: row.selected_target_project_id,
    selectedTargetProjectPath: row.selected_target_project_path,
    selectedMergeRequestIid: row.selected_merge_request_iid,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class GitLabRepository {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  listConnections(): GitLabConnectionSummary[] {
    const rows = this.#db
      .prepare("SELECT * FROM gitlab_connections ORDER BY created_at DESC")
      .all() as ConnectionRow[];
    return rows.map(rowToConnectionSummary);
  }

  findConnection(id: string): GitLabConnectionSummary | null {
    const row = this.#db
      .prepare("SELECT * FROM gitlab_connections WHERE id = ?")
      .get(id) as ConnectionRow | undefined;
    return row ? rowToConnectionSummary(row) : null;
  }

  findConnectionByInstanceAndUser(
    instanceUrl: string,
    userId: number,
  ): GitLabConnectionSummary | null {
    const row = this.#db
      .prepare("SELECT * FROM gitlab_connections WHERE instance_url = ? AND user_id = ?")
      .get(instanceUrl, userId) as ConnectionRow | undefined;
    return row ? rowToConnectionSummary(row) : null;
  }

  findMatchingConnectionsForInstance(instanceUrl: string): GitLabConnectionSummary[] {
    const rows = this.#db
      .prepare("SELECT * FROM gitlab_connections WHERE instance_url = ? ORDER BY created_at DESC")
      .all(instanceUrl) as ConnectionRow[];
    return rows.map(rowToConnectionSummary);
  }

  getConnectionTokenCipher(id: string): Buffer {
    const row = this.#db
      .prepare("SELECT token_cipher FROM gitlab_connections WHERE id = ?")
      .get(id) as { token_cipher: Buffer } | undefined;
    if (!row) throw new Error(`GitLab connection ${id} not found.`);
    return row.token_cipher;
  }

  saveConnection(data: {
    id: string;
    instanceUrl: string;
    apiBaseUrl: string;
    userId: number;
    username: string;
    displayName: string;
    tokenCipher: Buffer | string;
    accessMode: GitLabAccessMode;
    scopes: string[];
    allowSelfSignedTls?: boolean;
    expiresAt: string | null;
    lastValidatedAt: string;
    createdAt: string;
    updatedAt: string;
  }): GitLabConnectionSummary {
    const cipherBuffer = Buffer.isBuffer(data.tokenCipher)
      ? data.tokenCipher
      : Buffer.from(data.tokenCipher);

    const stmt = this.#db.prepare(`
      INSERT INTO gitlab_connections (
        id, instance_url, api_base_url, user_id, username, display_name,
        token_cipher, access_mode, scopes_json, allow_self_signed_tls, expires_at, last_validated_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_url, user_id) DO UPDATE SET
        api_base_url = excluded.api_base_url,
        username = excluded.username,
        display_name = excluded.display_name,
        token_cipher = excluded.token_cipher,
        access_mode = excluded.access_mode,
        scopes_json = excluded.scopes_json,
        allow_self_signed_tls = excluded.allow_self_signed_tls,
        expires_at = excluded.expires_at,
        last_validated_at = excluded.last_validated_at,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      data.id,
      data.instanceUrl,
      data.apiBaseUrl,
      data.userId,
      data.username,
      data.displayName,
      cipherBuffer,
      data.accessMode,
      JSON.stringify(data.scopes),
      data.allowSelfSignedTls ? 1 : 0,
      data.expiresAt,
      data.lastValidatedAt,
      data.createdAt,
      data.updatedAt,
    );

    const connection = this.findConnectionByInstanceAndUser(data.instanceUrl, data.userId);
    if (!connection) throw new Error("Failed to save GitLab connection.");
    return connection;
  }

  updateConnectionToken(
    id: string,
    data: {
      tokenCipher: Buffer | string;
      accessMode: GitLabAccessMode;
      scopes: string[];
      allowSelfSignedTls?: boolean;
      expiresAt: string | null;
      lastValidatedAt: string;
      updatedAt: string;
    },
  ): GitLabConnectionSummary {
    const cipherBuffer = Buffer.isBuffer(data.tokenCipher)
      ? data.tokenCipher
      : Buffer.from(data.tokenCipher);

    const existing = this.findConnection(id);
    const allowSelfSigned = data.allowSelfSignedTls !== undefined
      ? (data.allowSelfSignedTls ? 1 : 0)
      : (existing?.allowSelfSignedTls ? 1 : 0);

    const stmt = this.#db.prepare(`
      UPDATE gitlab_connections
      SET token_cipher = ?, access_mode = ?, scopes_json = ?, allow_self_signed_tls = ?,
          expires_at = ?, last_validated_at = ?, updated_at = ?
      WHERE id = ?
    `);
    const result = stmt.run(
      cipherBuffer,
      data.accessMode,
      JSON.stringify(data.scopes),
      allowSelfSigned,
      data.expiresAt,
      data.lastValidatedAt,
      data.updatedAt,
      id,
    );
    if (result.changes === 0) throw new Error(`GitLab connection ${id} not found.`);
    const connection = this.findConnection(id);
    if (!connection) throw new Error(`GitLab connection ${id} not found after update.`);
    return connection;
  }

  updateConnectionStatus(
    id: string,
    data: {
      accessMode: GitLabAccessMode;
      lastValidatedAt: string;
      updatedAt: string;
    },
  ): GitLabConnectionSummary {
    const stmt = this.#db.prepare(`
      UPDATE gitlab_connections
      SET access_mode = ?, last_validated_at = ?, updated_at = ?
      WHERE id = ?
    `);
    const result = stmt.run(data.accessMode, data.lastValidatedAt, data.updatedAt, id);
    if (result.changes === 0) throw new Error(`GitLab connection ${id} not found.`);
    const connection = this.findConnection(id);
    if (!connection) throw new Error(`GitLab connection ${id} not found after status update.`);
    return connection;
  }

  removeConnection(id: string, forceDisableBindings = false): void {
    this.#db.transaction(() => {
      const activeBindings = this.#db
        .prepare("SELECT COUNT(*) as count FROM gitlab_repository_bindings WHERE connection_id = ? AND enabled = 1")
        .get(id) as { count: number };

      if (activeBindings.count > 0 && !forceDisableBindings) {
        throw new Error(
          `Diese Verbindung wird noch von ${activeBindings.count} aktive(n) Repository-Binding(s) verwendet.`,
        );
      }

      if (forceDisableBindings) {
        this.#db
          .prepare("UPDATE gitlab_repository_bindings SET enabled = 0, updated_at = ? WHERE connection_id = ?")
          .run(new Date().toISOString(), id);
      }

      // Delete all repository bindings referencing this connection to satisfy FK constraint
      this.#db
        .prepare("DELETE FROM gitlab_repository_bindings WHERE connection_id = ?")
        .run(id);

      const result = this.#db
        .prepare("DELETE FROM gitlab_connections WHERE id = ?")
        .run(id);
      if (result.changes === 0) throw new Error(`GitLab connection ${id} not found.`);
    })();
  }

  listBindingsByProject(projectId: string): GitLabRepositoryBinding[] {
    const rows = this.#db
      .prepare("SELECT * FROM gitlab_repository_bindings WHERE project_id = ? ORDER BY created_at ASC")
      .all(projectId) as BindingRow[];
    return rows.map(rowToBinding);
  }

  listEnabledBindingsByProject(projectId: string): GitLabRepositoryBinding[] {
    const rows = this.#db
      .prepare("SELECT * FROM gitlab_repository_bindings WHERE project_id = ? AND enabled = 1 ORDER BY created_at ASC")
      .all(projectId) as BindingRow[];
    return rows.map(rowToBinding);
  }

  listBindingsByConnection(connectionId: string): GitLabRepositoryBinding[] {
    const rows = this.#db
      .prepare("SELECT * FROM gitlab_repository_bindings WHERE connection_id = ? ORDER BY created_at ASC")
      .all(connectionId) as BindingRow[];
    return rows.map(rowToBinding);
  }

  findBinding(id: string): GitLabRepositoryBinding | null {
    const row = this.#db
      .prepare("SELECT * FROM gitlab_repository_bindings WHERE id = ?")
      .get(id) as BindingRow | undefined;
    return row ? rowToBinding(row) : null;
  }

  findBindingByProjectAndKey(
    projectId: string,
    repositoryKey: string,
  ): GitLabRepositoryBinding | null {
    const row = this.#db
      .prepare("SELECT * FROM gitlab_repository_bindings WHERE project_id = ? AND repository_key = ?")
      .get(projectId, repositoryKey) as BindingRow | undefined;
    return row ? rowToBinding(row) : null;
  }

  saveBinding(binding: GitLabRepositoryBinding): GitLabRepositoryBinding {
    const stmt = this.#db.prepare(`
      INSERT INTO gitlab_repository_bindings (
        id, project_id, root_id, connection_id, repository_key,
        remote_name, remote_url, source_project_id, source_project_path,
        enabled, selected_target_project_id, selected_target_project_path,
        selected_merge_request_iid, last_synced_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, repository_key) DO UPDATE SET
        root_id = excluded.root_id,
        connection_id = excluded.connection_id,
        remote_name = excluded.remote_name,
        remote_url = excluded.remote_url,
        source_project_id = excluded.source_project_id,
        source_project_path = excluded.source_project_path,
        enabled = excluded.enabled,
        selected_target_project_id = excluded.selected_target_project_id,
        selected_target_project_path = excluded.selected_target_project_path,
        selected_merge_request_iid = excluded.selected_merge_request_iid,
        last_synced_at = excluded.last_synced_at,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      binding.id,
      binding.projectId,
      binding.rootId,
      binding.connectionId,
      binding.repositoryKey,
      binding.remoteName,
      binding.remoteUrl,
      binding.sourceProjectId,
      binding.sourceProjectPath,
      binding.enabled ? 1 : 0,
      binding.selectedTargetProjectId,
      binding.selectedTargetProjectPath,
      binding.selectedMergeRequestIid,
      binding.lastSyncedAt,
      binding.createdAt,
      binding.updatedAt,
    );

    const saved = this.findBinding(binding.id);
    if (!saved) throw new Error("Failed to save GitLab repository binding.");
    return saved;
  }

  updateBindingSelection(
    bindingId: string,
    data: {
      selectedTargetProjectId: number | null;
      selectedTargetProjectPath: string | null;
      selectedMergeRequestIid: number | null;
      lastSyncedAt?: string | null;
      updatedAt: string;
    },
  ): GitLabRepositoryBinding {
    const stmt = this.#db.prepare(`
      UPDATE gitlab_repository_bindings
      SET selected_target_project_id = ?,
          selected_target_project_path = ?,
          selected_merge_request_iid = ?,
          last_synced_at = COALESCE(?, last_synced_at),
          updated_at = ?
      WHERE id = ?
    `);

    const result = stmt.run(
      data.selectedTargetProjectId,
      data.selectedTargetProjectPath,
      data.selectedMergeRequestIid,
      data.lastSyncedAt ?? null,
      data.updatedAt,
      bindingId,
    );
    if (result.changes === 0) throw new Error(`GitLab binding ${bindingId} not found.`);
    const saved = this.findBinding(bindingId);
    if (!saved) throw new Error(`GitLab binding ${bindingId} not found after update.`);
    return saved;
  }

  disableBinding(bindingId: string): void {
    const stmt = this.#db.prepare(`
      UPDATE gitlab_repository_bindings
      SET enabled = 0, updated_at = ?
      WHERE id = ?
    `);
    const result = stmt.run(new Date().toISOString(), bindingId);
    if (result.changes === 0) throw new Error(`GitLab binding ${bindingId} not found.`);
  }

  deleteBinding(bindingId: string): void {
    const result = this.#db
      .prepare("DELETE FROM gitlab_repository_bindings WHERE id = ?")
      .run(bindingId);
    if (result.changes === 0) throw new Error(`GitLab binding ${bindingId} not found.`);
  }
}
