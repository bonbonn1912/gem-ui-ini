import {
  AppProjectSchema,
  ProjectRootSchema,
  ProjectWithRootsSchema,
  type AppProject,
  type ProjectRoot,
  type ProjectWithRoots,
} from "../../../shared";
import type { SqliteDatabase } from "../database";
import {
  StorageConflictError,
  StorageCorruptionError,
  StorageNotFoundError,
} from "../errors";

type ProjectRow = {
  id: string;
  name: string;
  primary_root_id: string;
  root_revision: number;
  root_fingerprint: string;
  approval_mode_id: string | null;
  approval_mode_state: "gemini_default" | "available" | "unavailable";
  archived: number;
  created_at: string;
  updated_at: string;
};

type ProjectRootRow = {
  id: string;
  project_id: string;
  kind: "primary" | "additional";
  path: string;
  real_path: string;
  label: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export class ProjectRepository {
  constructor(private readonly database: SqliteDatabase) {}

  create(project: AppProject, roots: readonly ProjectRoot[]): ProjectWithRoots {
    const parsedProject = AppProjectSchema.parse(project);
    const parsedRoots = roots.map((root) => ProjectRootSchema.parse(root));
    ProjectWithRootsSchema.parse({ ...parsedProject, roots: parsedRoots });

    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO projects (
             id, name, primary_root_id, root_revision, root_fingerprint,
             approval_mode_id, approval_mode_state, archived, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsedProject.id,
          parsedProject.name,
          parsedProject.primaryRootId,
          parsedProject.rootRevision,
          parsedProject.rootFingerprint,
          parsedProject.approvalModeId,
          parsedProject.approvalModeState,
          parsedProject.archived ? 1 : 0,
          parsedProject.createdAt,
          parsedProject.updatedAt,
        );

      const insertRoot = this.database.prepare(
        `INSERT INTO project_roots (
           id, project_id, kind, path, real_path, label, sort_order,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const root of parsedRoots) {
        insertRoot.run(
          root.id,
          root.projectId,
          root.kind,
          root.path,
          root.realPath,
          root.label,
          root.sortOrder,
          root.createdAt,
          root.updatedAt,
        );
      }
    })();

    return this.getById(parsedProject.id);
  }

  getById(projectId: string): ProjectWithRoots {
    const project = this.database
      .prepare(
        `SELECT id, name, primary_root_id, root_revision, root_fingerprint,
                approval_mode_id, approval_mode_state,
                archived, created_at, updated_at
         FROM projects WHERE id = ?`,
      )
      .get(projectId) as ProjectRow | undefined;

    if (!project) throw new StorageNotFoundError("Project", projectId);

    const roots = this.database
      .prepare(
        `SELECT id, project_id, kind, path, real_path, label, sort_order,
                created_at, updated_at
         FROM project_roots
         WHERE project_id = ?
         ORDER BY sort_order`,
      )
      .all(projectId) as ProjectRootRow[];

    return parseProject(project, roots);
  }

  findById(projectId: string): ProjectWithRoots | null {
    try {
      return this.getById(projectId);
    } catch (error) {
      if (error instanceof StorageNotFoundError) return null;
      throw error;
    }
  }

  list(includeArchived = false): ProjectWithRoots[] {
    const projects = this.database
      .prepare(
        `SELECT id, name, primary_root_id, root_revision, root_fingerprint,
                approval_mode_id, approval_mode_state,
                archived, created_at, updated_at
         FROM projects
         WHERE archived = 0 OR ? = 1
         ORDER BY archived, updated_at DESC, name COLLATE NOCASE`,
      )
      .all(includeArchived ? 1 : 0) as ProjectRow[];

    const getRoots = this.database.prepare(
      `SELECT id, project_id, kind, path, real_path, label, sort_order,
              created_at, updated_at
       FROM project_roots
       WHERE project_id = ?
       ORDER BY sort_order`,
    );

    return projects.map((project) =>
      parseProject(
        project,
        getRoots.all(project.id) as ProjectRootRow[],
      ),
    );
  }

  rename(projectId: string, name: string, updatedAt: string): ProjectWithRoots {
    const result = this.database
      .prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
      .run(name, updatedAt, projectId);
    if (result.changes !== 1) {
      throw new StorageNotFoundError("Project", projectId);
    }
    return this.getById(projectId);
  }

  setArchived(
    projectId: string,
    archived: boolean,
    updatedAt: string,
  ): ProjectWithRoots {
    const result = this.database
      .prepare(
        "UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?",
      )
      .run(archived ? 1 : 0, updatedAt, projectId);
    if (result.changes !== 1) {
      throw new StorageNotFoundError("Project", projectId);
    }
    return this.getById(projectId);
  }

  setApprovalMode(
    projectId: string,
    modeId: string | null,
    state: ProjectRow["approval_mode_state"],
    updatedAt: string,
  ): ProjectWithRoots {
    if ((modeId === null) !== (state === "gemini_default")) {
      throw new TypeError(
        "Gemini default requires no mode id; explicit modes require an availability state",
      );
    }
    const result = this.database
      .prepare(
        `UPDATE projects
         SET approval_mode_id = ?, approval_mode_state = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(modeId, state, updatedAt, projectId);
    if (result.changes !== 1) {
      throw new StorageNotFoundError("Project", projectId);
    }
    return this.getById(projectId);
  }

  replaceAdditionalRoots(input: {
    projectId: string;
    expectedRootRevision: number;
    newRootRevision: number;
    rootFingerprint: string;
    additionalRoots: readonly ProjectRoot[];
    updatedAt: string;
  }): ProjectWithRoots {
    const additionalRoots = input.additionalRoots.map((root) =>
      ProjectRootSchema.parse(root),
    );
    if (additionalRoots.some((root) => root.kind !== "additional")) {
      throw new TypeError("replaceAdditionalRoots accepts additional roots only");
    }

    this.database.transaction(() => {
      const update = this.database
        .prepare(
          `UPDATE projects
           SET root_revision = ?, root_fingerprint = ?, updated_at = ?
           WHERE id = ? AND root_revision = ?`,
        )
        .run(
          input.newRootRevision,
          input.rootFingerprint,
          input.updatedAt,
          input.projectId,
          input.expectedRootRevision,
        );

      if (update.changes !== 1) {
        if (!this.findById(input.projectId)) {
          throw new StorageNotFoundError("Project", input.projectId);
        }
        throw new StorageConflictError(
          "The project root revision changed before the update was committed",
        );
      }

      this.database
        .prepare(
          "DELETE FROM project_roots WHERE project_id = ? AND kind = 'additional'",
        )
        .run(input.projectId);

      const insert = this.database.prepare(
        `INSERT INTO project_roots (
           id, project_id, kind, path, real_path, label, sort_order,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const root of additionalRoots) {
        insert.run(
          root.id,
          root.projectId,
          root.kind,
          root.path,
          root.realPath,
          root.label,
          root.sortOrder,
          root.createdAt,
          root.updatedAt,
        );
      }

      this.database
        .prepare(
          `UPDATE sessions
           SET status = 'roots_changed', updated_at = ?
           WHERE project_id = ?`,
        )
        .run(input.updatedAt, input.projectId);
    })();

    return this.getById(input.projectId);
  }

  delete(projectId: string): void {
    const result = this.database
      .prepare("DELETE FROM projects WHERE id = ?")
      .run(projectId);
    if (result.changes !== 1) {
      throw new StorageNotFoundError("Project", projectId);
    }
  }
}

function parseProject(
  project: ProjectRow,
  roots: readonly ProjectRootRow[],
): ProjectWithRoots {
  try {
    return ProjectWithRootsSchema.parse({
      id: project.id,
      name: project.name,
      primaryRootId: project.primary_root_id,
      rootRevision: project.root_revision,
      rootFingerprint: project.root_fingerprint,
      approvalModeId: project.approval_mode_id,
      approvalModeState: project.approval_mode_state,
      archived: project.archived === 1,
      createdAt: project.created_at,
      updatedAt: project.updated_at,
      roots: roots.map((root) => ({
        id: root.id,
        projectId: root.project_id,
        kind: root.kind,
        path: root.path,
        realPath: root.real_path,
        label: root.label,
        sortOrder: root.sort_order,
        createdAt: root.created_at,
        updatedAt: root.updated_at,
      })),
    });
  } catch (error) {
    throw new StorageCorruptionError("project", { cause: error });
  }
}
