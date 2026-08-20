export type ProjectRootErrorCode =
  | "root_path_not_absolute"
  | "root_not_found"
  | "root_not_accessible"
  | "root_not_directory"
  | "root_reauthorization_mismatch"
  | "duplicate_root"
  | "overlapping_root"
  | "root_changed_on_disk"
  | "too_many_additional_roots";

export class ProjectRootValidationError extends Error {
  constructor(
    readonly code: ProjectRootErrorCode,
    message: string,
    readonly rootPath?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectRootValidationError";
  }
}

export class ProjectBusyError extends Error {
  readonly code = "project_busy";

  constructor(projectId: string) {
    super(`Project ${projectId} has an active turn and its roots cannot be changed`);
    this.name = "ProjectBusyError";
  }
}
