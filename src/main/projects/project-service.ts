import { randomUUID } from "node:crypto";

import {
  ArchiveProjectInputSchema,
  CreateProjectInputSchema,
  DeleteProjectInputSchema,
  ListProjectsInputSchema,
  ProjectAccessSchema,
  RenameProjectInputSchema,
  SetProjectRootsInputSchema,
  type AppProject,
  type ArchiveProjectInput,
  type CreateProjectInput,
  type DeleteProjectInput,
  type ListProjectsInput,
  type ProjectAccess,
  type ProjectRoot,
  type ProjectWithRoots,
  type ProjectApprovalModeState,
  type RenameProjectInput,
  type SetProjectRootsInput,
} from "../../shared";
import {
  ProjectRepository,
  StorageConflictError,
  StorageNotFoundError,
} from "../storage";
import { ProjectRootValidationError } from "./errors";
import {
  canonicalPathsEqual,
  resolveProjectRootSet,
  verifyStoredProjectRootSet,
} from "./root-resolver";

export interface ProjectRuntimeCoordinator {
  assertProjectIdle(projectId: string): void | Promise<void>;
  stopProjectProcesses(projectId: string): void | Promise<void>;
}

const NOOP_RUNTIME_COORDINATOR: ProjectRuntimeCoordinator = {
  assertProjectIdle: () => undefined,
  stopProjectProcesses: () => undefined,
};

export type ProjectServiceOptions = {
  now?: () => Date;
  createId?: () => string;
  runtimeCoordinator?: ProjectRuntimeCoordinator;
};

export class ProjectService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private runtimeCoordinator: ProjectRuntimeCoordinator;

  constructor(
    private readonly projects: ProjectRepository,
    options: ProjectServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.runtimeCoordinator =
      options.runtimeCoordinator ?? NOOP_RUNTIME_COORDINATOR;
  }

  setRuntimeCoordinator(coordinator: ProjectRuntimeCoordinator): void {
    this.runtimeCoordinator = coordinator;
  }

  list(input: ListProjectsInput = {}): ProjectWithRoots[] {
    const parsed = ListProjectsInputSchema.parse(input);
    return this.projects.list(parsed.includeArchived);
  }

  get(projectId: string): ProjectWithRoots {
    return this.projects.getById(projectId);
  }

  getRootForReauthorization(projectId: string, rootId: string): ProjectRoot {
    const project = this.projects.getById(projectId);
    const root = project.roots.find((candidate) => candidate.id === rootId);
    if (!root) throw new StorageNotFoundError("project root", rootId);
    return root;
  }

  async reauthorizeRootSelection(input: {
    projectId: string;
    rootId: string;
    selectedPath: string;
  }): Promise<ProjectRoot> {
    const storedRoot = this.getRootForReauthorization(
      input.projectId,
      input.rootId,
    );
    const selected = await resolveProjectRootSet({
      primaryRootPath: input.selectedPath,
    });
    if (
      !canonicalPathsEqual(
        selected.primaryRoot.realPath,
        storedRoot.realPath,
      )
    ) {
      throw new ProjectRootValidationError(
        "root_reauthorization_mismatch",
        `Der ausgewählte Ordner entspricht nicht dem gespeicherten Projektordner „${storedRoot.label}“. Bitte wähle exakt diesen Ordner aus: ${storedRoot.path}`,
        input.selectedPath,
      );
    }

    // Selecting through NSOpenPanel is the non-MAS TCC recovery action. Do not
    // report success until the persisted path itself can be resolved and
    // traversed again with the newly granted process access. Other roots are
    // recovered independently through the same single-root flow.
    const revalidated = await resolveProjectRootSet({
      primaryRootPath: storedRoot.path,
    });
    if (
      !canonicalPathsEqual(
        revalidated.primaryRoot.realPath,
        storedRoot.realPath,
      )
    ) {
      throw new ProjectRootValidationError(
        "root_changed_on_disk",
        `Der gespeicherte Projektordner verweist inzwischen auf einen anderen Ort: ${storedRoot.path}`,
        storedRoot.path,
      );
    }
    return storedRoot;
  }

  async create(input: CreateProjectInput): Promise<ProjectWithRoots> {
    const parsed = CreateProjectInputSchema.parse(input);
    const resolved = await resolveProjectRootSet({
      primaryRootPath: parsed.primaryRootPath,
      additionalRootPaths: parsed.additionalRootPaths,
    });
    const projectId = this.createId();
    const primaryRootId = this.createId();
    const timestamp = this.now().toISOString();
    const roots: ProjectRoot[] = [
      {
        id: primaryRootId,
        projectId,
        kind: "primary",
        path: resolved.primaryRoot.path,
        realPath: resolved.primaryRoot.realPath,
        label: resolved.primaryRoot.label,
        sortOrder: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      ...resolved.additionalRoots.map<ProjectRoot>((root, index) => ({
        id: this.createId(),
        projectId,
        kind: "additional",
        path: root.path,
        realPath: root.realPath,
        label: root.label,
        sortOrder: index + 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
    ];
    const project: AppProject = {
      id: projectId,
      name: parsed.name,
      primaryRootId,
      rootRevision: 1,
      rootFingerprint: resolved.fingerprint,
      approvalModeId: null,
      approvalModeState: "gemini_default",
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    return this.projects.create(project, roots);
  }

  rename(input: RenameProjectInput): ProjectWithRoots {
    const parsed = RenameProjectInputSchema.parse(input);
    return this.projects.rename(
      parsed.projectId,
      parsed.name,
      this.now().toISOString(),
    );
  }

  setArchived(input: ArchiveProjectInput): ProjectWithRoots {
    const parsed = ArchiveProjectInputSchema.parse(input);
    return this.projects.setArchived(
      parsed.projectId,
      parsed.archived,
      this.now().toISOString(),
    );
  }

  async setAdditionalRoots(
    input: SetProjectRootsInput,
  ): Promise<ProjectWithRoots> {
    const parsed = SetProjectRootsInputSchema.parse(input);
    const current = this.projects.getById(parsed.projectId);
    if (current.rootRevision !== parsed.expectedRootRevision) {
      throw new StorageConflictError(
        "The project root revision changed before validation",
      );
    }

    await this.runtimeCoordinator.assertProjectIdle(parsed.projectId);
    const primary = getPrimaryRoot(current);
    const resolved = await resolveProjectRootSet({
      primaryRootPath: primary.path,
      additionalRootPaths: parsed.additionalRootPaths,
    });
    if (resolved.fingerprint === current.rootFingerprint) return current;

    await this.runtimeCoordinator.stopProjectProcesses(parsed.projectId);
    const timestamp = this.now().toISOString();
    const additionalRoots = resolved.additionalRoots.map<ProjectRoot>(
      (root, index) => ({
        id: this.createId(),
        projectId: parsed.projectId,
        kind: "additional",
        path: root.path,
        realPath: root.realPath,
        label: root.label,
        sortOrder: index + 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );

    return this.projects.replaceAdditionalRoots({
      projectId: parsed.projectId,
      expectedRootRevision: parsed.expectedRootRevision,
      newRootRevision: parsed.expectedRootRevision + 1,
      rootFingerprint: resolved.fingerprint,
      additionalRoots,
      updatedAt: timestamp,
    });
  }

  delete(input: DeleteProjectInput): void {
    const parsed = DeleteProjectInputSchema.parse(input);
    this.projects.delete(parsed.projectId);
  }

  setApprovalModeState(input: {
    projectId: string;
    modeId: string | null;
    state: ProjectApprovalModeState;
  }): ProjectWithRoots {
    return this.projects.setApprovalMode(
      input.projectId,
      input.modeId,
      input.state,
      this.now().toISOString(),
    );
  }

  async getCurrentAccess(projectId: string): Promise<ProjectAccess> {
    const project = this.projects.getById(projectId);
    const primaryRoot = getPrimaryRoot(project);
    const additionalRoots = project.roots.filter(
      (root) => root.kind === "additional",
    );
    await verifyStoredProjectRootSet({
      primaryRoot,
      additionalRoots,
      expectedFingerprint: project.rootFingerprint,
    });

    return ProjectAccessSchema.parse({
      projectId: project.id,
      rootRevision: project.rootRevision,
      rootFingerprint: project.rootFingerprint,
      primaryRoot,
      additionalRoots,
    });
  }
}

function getPrimaryRoot(project: ProjectWithRoots): ProjectRoot {
  const root = project.roots.find((candidate) => candidate.kind === "primary");
  if (!root) {
    throw new Error(`Project ${project.id} has no primary root`);
  }
  return root;
}
