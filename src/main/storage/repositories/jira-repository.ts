import type { SqliteDatabase } from "../database";
import type { JiraConfig } from "../../../shared/contracts";

type ConfigRow = {
  id: string;
  name: string;
  base_url: string;
  issue_prefixes_json: string;
  created_at: string;
  updated_at: string;
};

type ProjectIntegrationRow = {
  project_id: string;
  config_id: string;
  created_at: string;
  updated_at: string;
};

export type StoredJiraProjectIntegration = {
  projectId: string;
  configId: string;
  createdAt: string;
  updatedAt: string;
};

function rowToConfig(row: ConfigRow): JiraConfig {
  let issuePrefixes: string[] = [];
  try {
    const parsed = JSON.parse(row.issue_prefixes_json);
    if (Array.isArray(parsed)) {
      issuePrefixes = parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    issuePrefixes = [];
  }

  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    issuePrefixes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class JiraRepository {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  listConfigs(): JiraConfig[] {
    const rows = this.#db
      .prepare("SELECT * FROM jira_configs ORDER BY name COLLATE NOCASE ASC")
      .all() as ConfigRow[];
    return rows.map(rowToConfig);
  }

  findConfig(id: string): JiraConfig | null {
    const row = this.#db
      .prepare("SELECT * FROM jira_configs WHERE id = ?")
      .get(id) as ConfigRow | undefined;
    return row ? rowToConfig(row) : null;
  }

  findConfigByName(name: string): JiraConfig | null {
    const row = this.#db
      .prepare("SELECT * FROM jira_configs WHERE name = ? COLLATE NOCASE")
      .get(name) as ConfigRow | undefined;
    return row ? rowToConfig(row) : null;
  }

  findConfigByBaseUrl(baseUrl: string): JiraConfig | null {
    const row = this.#db
      .prepare("SELECT * FROM jira_configs WHERE base_url = ? COLLATE NOCASE")
      .get(baseUrl) as ConfigRow | undefined;
    return row ? rowToConfig(row) : null;
  }

  insertConfig(data: {
    id: string;
    name: string;
    baseUrl: string;
    issuePrefixes: readonly string[];
    createdAt: string;
    updatedAt: string;
  }): JiraConfig {
    this.#db
      .prepare(
        `INSERT INTO jira_configs (id, name, base_url, issue_prefixes_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.id,
        data.name,
        data.baseUrl,
        JSON.stringify([...data.issuePrefixes]),
        data.createdAt,
        data.updatedAt,
      );

    const saved = this.findConfig(data.id);
    if (!saved) throw new Error("Die Jira-Konfiguration konnte nicht gespeichert werden.");
    return saved;
  }

  updateConfig(data: {
    id: string;
    name: string;
    baseUrl: string;
    issuePrefixes: readonly string[];
    updatedAt: string;
  }): JiraConfig {
    const result = this.#db
      .prepare(
        `UPDATE jira_configs
         SET name = ?, base_url = ?, issue_prefixes_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        data.name,
        data.baseUrl,
        JSON.stringify([...data.issuePrefixes]),
        data.updatedAt,
        data.id,
      );
    if (result.changes === 0) {
      throw new Error(`Jira-Konfiguration ${data.id} wurde nicht gefunden.`);
    }
    const saved = this.findConfig(data.id);
    if (!saved) throw new Error(`Jira-Konfiguration ${data.id} wurde nach dem Speichern nicht gefunden.`);
    return saved;
  }

  /**
   * Removes a configuration. The activations that pointed at it disappear with
   * it (ON DELETE CASCADE), which is exactly what deleting a Jira instance
   * should mean: the projects using it fall back to "not configured".
   */
  deleteConfig(id: string): void {
    const result = this.#db.prepare("DELETE FROM jira_configs WHERE id = ?").run(id);
    if (result.changes === 0) {
      throw new Error(`Jira-Konfiguration ${id} wurde nicht gefunden.`);
    }
  }

  countProjectsUsingConfig(configId: string): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS count FROM jira_project_integrations WHERE config_id = ?")
      .get(configId) as { count: number };
    return row.count;
  }

  getProjectIntegration(projectId: string): StoredJiraProjectIntegration | null {
    const row = this.#db
      .prepare("SELECT * FROM jira_project_integrations WHERE project_id = ?")
      .get(projectId) as ProjectIntegrationRow | undefined;
    if (!row) return null;
    return {
      projectId: row.project_id,
      configId: row.config_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  setProjectIntegration(data: {
    projectId: string;
    configId: string;
    now: string;
  }): StoredJiraProjectIntegration {
    this.#db
      .prepare(
        `INSERT INTO jira_project_integrations (project_id, config_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           config_id = excluded.config_id,
           updated_at = excluded.updated_at`,
      )
      .run(data.projectId, data.configId, data.now, data.now);

    const saved = this.getProjectIntegration(data.projectId);
    if (!saved) throw new Error("Die Jira-Aktivierung konnte nicht gespeichert werden.");
    return saved;
  }

  clearProjectIntegration(projectId: string): void {
    this.#db
      .prepare("DELETE FROM jira_project_integrations WHERE project_id = ?")
      .run(projectId);
  }
}
