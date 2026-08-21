import type { SqliteDatabase } from "./database";

type Migration = {
  version: number;
  name: string;
  sql: string;
};

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_project_session_storage",
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
        primary_root_id TEXT NOT NULL,
        primary_root_kind TEXT NOT NULL DEFAULT 'primary'
          CHECK(primary_root_kind = 'primary'),
        root_revision INTEGER NOT NULL DEFAULT 1 CHECK(root_revision >= 1),
        root_fingerprint TEXT NOT NULL
          CHECK(length(root_fingerprint) = 64 AND root_fingerprint NOT GLOB '*[^0-9a-f]*'),
        archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (id, primary_root_id, primary_root_kind)
          REFERENCES project_roots(project_id, id, kind)
          DEFERRABLE INITIALLY DEFERRED
      ) STRICT;

      CREATE TABLE project_roots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('primary', 'additional')),
        path TEXT NOT NULL CHECK(length(path) > 0),
        real_path TEXT NOT NULL CHECK(length(real_path) > 0),
        label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 200),
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
          DEFERRABLE INITIALLY DEFERRED,
        UNIQUE(project_id, id, kind),
        UNIQUE(project_id, real_path),
        UNIQUE(project_id, sort_order),
        CHECK(
          (kind = 'primary' AND sort_order = 0) OR
          (kind = 'additional' AND sort_order BETWEEN 1 AND 5)
        )
      ) STRICT;

      CREATE UNIQUE INDEX project_roots_one_primary
        ON project_roots(project_id)
        WHERE kind = 'primary';

      CREATE INDEX project_roots_project_order
        ON project_roots(project_id, sort_order);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK(provider = 'gemini-cli'),
        provider_session_id TEXT,
        project_id TEXT NOT NULL,
        last_root_revision INTEGER NOT NULL CHECK(last_root_revision >= 1),
        last_root_fingerprint TEXT NOT NULL
          CHECK(length(last_root_fingerprint) = 64 AND last_root_fingerprint NOT GLOB '*[^0-9a-f]*'),
        title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
        status TEXT NOT NULL CHECK(status IN (
          'idle', 'starting', 'running', 'awaiting_permission', 'cancelling',
          'roots_changed', 'error', 'disconnected'
        )),
        model TEXT,
        mode TEXT,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
        archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX sessions_project_updated
        ON sessions(project_id, archived, pinned DESC, updated_at DESC);

      CREATE TABLE session_roots (
        session_id TEXT NOT NULL,
        root_revision INTEGER NOT NULL CHECK(root_revision >= 1),
        root_fingerprint TEXT NOT NULL
          CHECK(length(root_fingerprint) = 64 AND root_fingerprint NOT GLOB '*[^0-9a-f]*'),
        kind TEXT NOT NULL CHECK(kind IN ('primary', 'additional')),
        path TEXT NOT NULL CHECK(length(path) > 0),
        real_path TEXT NOT NULL CHECK(length(real_path) > 0),
        label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 200),
        sort_order INTEGER NOT NULL CHECK(sort_order BETWEEN 0 AND 5),
        captured_at TEXT NOT NULL,
        PRIMARY KEY (session_id, root_revision, sort_order),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL CHECK(seq >= 1),
        turn_id TEXT,
        event_type TEXT NOT NULL CHECK(length(event_type) > 0),
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, seq),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX events_session_turn ON events(session_id, turn_id, seq);

      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        turn_id TEXT,
        display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 200),
        mime_type TEXT NOT NULL CHECK(mime_type IN (
          'image/png', 'image/jpeg', 'image/webp', 'image/gif'
        )),
        size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 10485760),
        sha256 TEXT NOT NULL
          CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
        storage_path TEXT NOT NULL CHECK(length(storage_path) > 0),
        status TEXT NOT NULL DEFAULT 'staged' CHECK(status IN ('staged', 'sent')),
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX attachments_session_turn
        ON attachments(session_id, turn_id, created_at);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 200),
        value_json TEXT NOT NULL CHECK(json_valid(value_json)),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    name: "client_request_idempotency",
    sql: `
      CREATE TABLE client_requests (
        client_request_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 200),
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX client_requests_created_at ON client_requests(created_at);
    `,
  },
  {
    version: 3,
    name: "project_approval_mode_default",
    sql: `
      ALTER TABLE projects ADD COLUMN approval_mode_id TEXT
        CHECK(approval_mode_id IS NULL OR length(trim(approval_mode_id)) BETWEEN 1 AND 100);
      ALTER TABLE projects ADD COLUMN approval_mode_state TEXT NOT NULL DEFAULT 'gemini_default'
        CHECK(approval_mode_state IN ('gemini_default', 'available', 'unavailable'));
    `,
  },
  {
    version: 4,
    name: "token_usage_tracking",
    sql: `
      CREATE TABLE turn_usage (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('acp_prompt_usage', 'gemini_meta_quota')),
        input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
        output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
        total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens >= 0),
        thought_tokens INTEGER CHECK(thought_tokens IS NULL OR thought_tokens >= 0),
        cached_read_tokens INTEGER CHECK(cached_read_tokens IS NULL OR cached_read_tokens >= 0),
        cached_write_tokens INTEGER CHECK(cached_write_tokens IS NULL OR cached_write_tokens >= 0),
        tool_tokens INTEGER CHECK(tool_tokens IS NULL OR tool_tokens >= 0),
        total_kind TEXT CHECK(total_kind IS NULL OR total_kind IN ('provider', 'derived_input_plus_output')),
        model_usage_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(model_usage_json)),
        observed_at TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE session_usage (
        session_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK(revision >= 0),
        snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    version: 5,
    name: "persistent_context_attachments",
    sql: `
      CREATE TABLE context_attachments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('project', 'session')),
        session_id TEXT,
        session_key TEXT NOT NULL CHECK(length(session_key) > 0),
        kind TEXT NOT NULL CHECK(kind IN ('file', 'link')),
        title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
        note TEXT CHECK(note IS NULL OR length(note) <= 2000),
        dedupe_key TEXT NOT NULL CHECK(length(dedupe_key) BETWEEN 1 AND 2048),
        sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
        default_include INTEGER NOT NULL DEFAULT 0 CHECK(default_include IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(
          (scope = 'project' AND session_id IS NULL AND session_key = '-') OR
          (scope = 'session' AND session_id IS NOT NULL AND session_key = session_id)
        ),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        UNIQUE(project_id, session_key, dedupe_key)
      ) STRICT;

      CREATE INDEX context_attachments_scope
        ON context_attachments(project_id, session_key, sort_order);

      CREATE TABLE context_attachment_files (
        attachment_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 200),
        mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 3 AND 200),
        size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 52428800),
        sha256 TEXT NOT NULL
          CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
        storage_dir TEXT NOT NULL CHECK(length(storage_dir) > 0),
        file_name TEXT NOT NULL CHECK(length(file_name) > 0),
        extraction_state TEXT NOT NULL DEFAULT 'pending' CHECK(extraction_state IN (
          'pending', 'running', 'ready', 'empty', 'unsupported', 'too_large', 'failed'
        )),
        extracted_chars INTEGER CHECK(extracted_chars IS NULL OR extracted_chars >= 0),
        page_count INTEGER CHECK(page_count IS NULL OR page_count >= 0),
        extraction_error TEXT CHECK(extraction_error IS NULL OR length(extraction_error) <= 500),
        FOREIGN KEY (attachment_id) REFERENCES context_attachments(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX context_attachment_files_sha256
        ON context_attachment_files(sha256);

      CREATE TABLE context_attachment_links (
        attachment_id TEXT PRIMARY KEY,
        url TEXT NOT NULL CHECK(length(url) BETWEEN 8 AND 2048),
        host TEXT NOT NULL CHECK(length(host) > 0),
        preview_state TEXT NOT NULL DEFAULT 'pending' CHECK(preview_state IN (
          'pending', 'ready', 'unauthorized', 'blocked', 'failed', 'disabled'
        )),
        preview_title TEXT CHECK(preview_title IS NULL OR length(preview_title) <= 300),
        preview_description TEXT
          CHECK(preview_description IS NULL OR length(preview_description) <= 1000),
        preview_site_name TEXT
          CHECK(preview_site_name IS NULL OR length(preview_site_name) <= 200),
        preview_image_file TEXT
          CHECK(preview_image_file IS NULL OR length(preview_image_file) > 0),
        preview_error TEXT CHECK(preview_error IS NULL OR length(preview_error) <= 500),
        fetched_at TEXT,
        FOREIGN KEY (attachment_id) REFERENCES context_attachments(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE context_attachment_selections (
        session_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        included INTEGER NOT NULL CHECK(included IN (0, 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, attachment_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (attachment_id) REFERENCES context_attachments(id) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    version: 6,
    name: "session_option_cache",
    sql: `
      ALTER TABLE sessions ADD COLUMN available_models_json TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(available_models_json));
      ALTER TABLE sessions ADD COLUMN available_modes_json TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(available_modes_json));
    `,
  },
  {
    version: 7,
    name: "gitlab_integration",
    sql: `
      CREATE TABLE gitlab_connections (
        id TEXT PRIMARY KEY,
        instance_url TEXT NOT NULL CHECK(length(instance_url) BETWEEN 8 AND 2048),
        api_base_url TEXT NOT NULL CHECK(length(api_base_url) BETWEEN 15 AND 2048),
        user_id INTEGER NOT NULL CHECK(user_id > 0),
        username TEXT NOT NULL CHECK(length(trim(username)) BETWEEN 1 AND 255),
        display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 255),
        token_cipher BLOB NOT NULL CHECK(length(token_cipher) > 0),
        access_mode TEXT NOT NULL CHECK(access_mode IN (
          'read_only', 'read_write', 'unknown', 'reauthentication_required'
        )),
        scopes_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(scopes_json)),
        expires_at TEXT,
        last_validated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(instance_url, user_id)
      ) STRICT;

      CREATE TABLE gitlab_repository_bindings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        root_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        repository_key TEXT NOT NULL
          CHECK(length(repository_key) = 64 AND repository_key NOT GLOB '*[^0-9a-f]*'),
        remote_name TEXT NOT NULL CHECK(length(remote_name) BETWEEN 1 AND 255),
        remote_url TEXT NOT NULL CHECK(length(remote_url) BETWEEN 1 AND 2048),
        source_project_id INTEGER NOT NULL CHECK(source_project_id > 0),
        source_project_path TEXT NOT NULL
          CHECK(length(source_project_path) BETWEEN 1 AND 1024),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
        selected_target_project_id INTEGER CHECK(selected_target_project_id > 0),
        selected_target_project_path TEXT
          CHECK(selected_target_project_path IS NULL OR length(selected_target_project_path) BETWEEN 1 AND 1024),
        selected_merge_request_iid INTEGER CHECK(selected_merge_request_iid > 0),
        last_synced_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (root_id) REFERENCES project_roots(id) ON DELETE CASCADE,
        FOREIGN KEY (connection_id) REFERENCES gitlab_connections(id) ON DELETE RESTRICT,
        UNIQUE(project_id, repository_key),
        CHECK(
          (selected_target_project_id IS NULL AND selected_target_project_path IS NULL
            AND selected_merge_request_iid IS NULL) OR
          (selected_target_project_id IS NOT NULL AND selected_target_project_path IS NOT NULL
            AND selected_merge_request_iid IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX gitlab_bindings_project
        ON gitlab_repository_bindings(project_id, enabled, updated_at);

      CREATE INDEX gitlab_bindings_connection
        ON gitlab_repository_bindings(connection_id, enabled);
    `,
  },
  {
    version: 8,
    name: "008_gitlab_allow_self_signed_tls",
    sql: `
      ALTER TABLE gitlab_connections
        ADD COLUMN allow_self_signed_tls INTEGER NOT NULL DEFAULT 0
        CHECK(allow_self_signed_tls IN (0, 1));
    `,
  },
  {
    version: 9,
    name: "009_context_attachment_origin",
    sql: `
      ALTER TABLE context_attachments
        ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
        CHECK(origin IN ('manual', 'chat'));
    `,
  },
  {
    version: 10,
    name: "010_project_todos",
    sql: `
      CREATE TABLE todos (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
        description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 20000),
        done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0, 1)),
        sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK((done = 1) = (completed_at IS NOT NULL)),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX todos_project_order ON todos(project_id, done, sort_order);

      -- A todo's attachment is a project context attachment that is also
      -- pinned to the todo. The link is what the todo owns; the attachment
      -- itself stays available to the whole project, so removing one from a
      -- todo never destroys data another todo or session still points at.
      CREATE TABLE todo_attachment_links (
        todo_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (todo_id, attachment_id),
        FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE,
        FOREIGN KEY (attachment_id) REFERENCES context_attachments(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX todo_attachment_links_order
        ON todo_attachment_links(todo_id, sort_order);
    `,
  },
];

export function runMigrations(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const appliedRows = database
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number }>;
  const appliedVersions = new Set(appliedRows.map(({ version }) => version));

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;

    database.transaction(() => {
      database.exec(migration.sql);
      database
        .prepare(
          `INSERT INTO schema_migrations (version, name, applied_at)
           VALUES (?, ?, ?)`,
        )
        .run(migration.version, migration.name, new Date().toISOString());
    })();
  }
}

export function getLatestSchemaVersion(): number {
  return migrations.at(-1)?.version ?? 0;
}
