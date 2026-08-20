export class StorageNotFoundError extends Error {
  readonly code = "storage_not_found";

  constructor(entity: string, id: string) {
    super(`${entity} ${id} was not found`);
    this.name = "StorageNotFoundError";
  }
}

export class StorageConflictError extends Error {
  readonly code = "storage_conflict";

  constructor(message: string) {
    super(message);
    this.name = "StorageConflictError";
  }
}

export class StorageCorruptionError extends Error {
  readonly code = "storage_corruption";

  constructor(entity: string, options?: ErrorOptions) {
    super(`Stored ${entity} data failed runtime validation`, options);
    this.name = "StorageCorruptionError";
  }
}
