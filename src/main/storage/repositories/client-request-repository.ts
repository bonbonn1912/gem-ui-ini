import {
  ClientRequestIdSchema,
  IsoTimestampSchema,
  JsonValueSchema,
  type JsonValue,
} from "../../../shared";
import type { SqliteDatabase } from "../database";
import { StorageConflictError, StorageCorruptionError } from "../errors";

type ClientRequestRow = {
  client_request_id: string;
  operation: string;
  result_json: string | null;
  created_at: string;
};

export type ClientRequestRecord = {
  clientRequestId: string;
  operation: string;
  state: "pending" | "completed";
  result: JsonValue | null;
  createdAt: string;
};

export class ClientRequestRepository {
  constructor(private readonly database: SqliteDatabase) {}

  get(clientRequestId: string): ClientRequestRecord | null {
    const id = ClientRequestIdSchema.parse(clientRequestId);
    const row = this.database
      .prepare(
        `SELECT client_request_id, operation, result_json, created_at
         FROM client_requests WHERE client_request_id = ?`,
      )
      .get(id) as ClientRequestRow | undefined;
    return row ? parseClientRequest(row) : null;
  }

  reserve(input: {
    clientRequestId: string;
    operation: string;
    createdAt?: string;
  }): { acquired: true } | { acquired: false; existing: ClientRequestRecord } {
    const clientRequestId = ClientRequestIdSchema.parse(input.clientRequestId);
    const operation = validateOperation(input.operation);
    const createdAt = IsoTimestampSchema.parse(
      input.createdAt ?? new Date().toISOString(),
    );
    const result = this.database
      .prepare(
        `INSERT INTO client_requests (
           client_request_id, operation, result_json, created_at
         ) VALUES (?, ?, NULL, ?)
         ON CONFLICT(client_request_id) DO NOTHING`,
      )
      .run(clientRequestId, operation, createdAt);

    if (result.changes === 1) return { acquired: true };
    const existing = this.get(clientRequestId);
    if (!existing) throw new Error("Client request disappeared after conflict");
    assertSameOperation(existing, operation);
    return { acquired: false, existing };
  }

  save(input: {
    clientRequestId: string;
    operation: string;
    result: JsonValue;
    createdAt?: string;
  }): ClientRequestRecord {
    const clientRequestId = ClientRequestIdSchema.parse(input.clientRequestId);
    const operation = validateOperation(input.operation);
    const parsedResult = JsonValueSchema.parse(input.result);
    const createdAt = IsoTimestampSchema.parse(
      input.createdAt ?? new Date().toISOString(),
    );

    this.database.transaction(() => {
      const existing = this.get(clientRequestId);
      if (existing) {
        assertSameOperation(existing, operation);
        if (existing.state === "completed") return;
        this.database
          .prepare(
            `UPDATE client_requests SET result_json = ?
             WHERE client_request_id = ? AND result_json IS NULL`,
          )
          .run(JSON.stringify(parsedResult), clientRequestId);
        return;
      }

      this.database
        .prepare(
          `INSERT INTO client_requests (
             client_request_id, operation, result_json, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          clientRequestId,
          operation,
          JSON.stringify(parsedResult),
          createdAt,
        );
    })();

    const stored = this.get(clientRequestId);
    if (!stored) throw new Error("Client request disappeared after save");
    return stored;
  }

  removePending(clientRequestId: string, operation: string): boolean {
    const id = ClientRequestIdSchema.parse(clientRequestId);
    const validatedOperation = validateOperation(operation);
    const result = this.database
      .prepare(
        `DELETE FROM client_requests
         WHERE client_request_id = ? AND operation = ? AND result_json IS NULL`,
      )
      .run(id, validatedOperation);
    return result.changes === 1;
  }

  clearPending(): number {
    const result = this.database
      .prepare("DELETE FROM client_requests WHERE result_json IS NULL")
      .run();
    return result.changes;
  }
}

function parseClientRequest(row: ClientRequestRow): ClientRequestRecord {
  try {
    const result =
      row.result_json === null
        ? null
        : JsonValueSchema.parse(JSON.parse(row.result_json));
    return {
      clientRequestId: ClientRequestIdSchema.parse(row.client_request_id),
      operation: validateOperation(row.operation),
      state: row.result_json === null ? "pending" : "completed",
      result,
      createdAt: IsoTimestampSchema.parse(row.created_at),
    };
  } catch (error) {
    throw new StorageCorruptionError("client request", { cause: error });
  }
}

function validateOperation(operation: string): string {
  const trimmed = operation.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new RangeError("Client request operation must contain 1 to 200 characters");
  }
  return trimmed;
}

function assertSameOperation(
  record: ClientRequestRecord,
  operation: string,
): void {
  if (record.operation !== operation) {
    throw new StorageConflictError(
      "A clientRequestId cannot be reused for a different operation",
    );
  }
}
