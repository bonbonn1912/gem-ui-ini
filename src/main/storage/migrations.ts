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
