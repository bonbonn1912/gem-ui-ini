export type GeminiErrorCode =
  | "binary_not_found"
  | "binary_not_executable"
  | "binary_probe_failed"
  | "acp_unsupported"
  | "protocol_mismatch"
  | "capability_unsupported"
  | "invalid_project_access"
  | "invalid_permission_response"
  | "session_busy"
  | "session_not_found"
  | "session_already_active"
  | "process_crashed"
  | "timeout"
  | "disposed";

/** A stable, renderer-safe error shape for the Gemini integration boundary. */
export class GeminiIntegrationError extends Error {
  readonly code: GeminiErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: GeminiErrorCode,
    message: string,
    options: {
      cause?: unknown;
      details?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "GeminiIntegrationError";
    this.code = code;
    this.details = options.details;
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "Unknown Gemini integration error";
}
