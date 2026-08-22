import type { JsonValue } from "../../shared/contracts";

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

export type GeminiErrorDescription = {
  /** Für die Anzeige aufbereitete Meldung. */
  readonly message: string;
  /** Rohwerte für die aufklappbaren Details, JSON-sicher. */
  readonly details?: Record<string, JsonValue>;
};

const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_DETAIL_TEXT_LENGTH = 700;

/** Nur übernehmen, was sich verlustfrei durch die IPC-Grenze serialisieren lässt. */
function toJsonSafe(value: unknown): JsonValue | undefined {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return undefined;
  }
}

/** Aus `data` die Aussage herausziehen, die ein Mensch lesen will. */
function readableData(data: unknown): string | null {
  if (data === null || data === undefined) return null;
  if (typeof data === "string") return data.trim() || null;
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  if (typeof data !== "object") return null;

  const record = data as Record<string, unknown>;
  for (const key of ["details", "message", "error", "reason", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, MAX_DETAIL_TEXT_LENGTH);
    }
  }
  try {
    const json = JSON.stringify(data);
    if (json && json !== "{}" && json !== "null") {
      return json.slice(0, MAX_DETAIL_TEXT_LENGTH);
    }
  } catch {
    // Zirkuläre Struktur — dann bleibt nur die Grundmeldung.
  }
  return null;
}

/**
 * JSON-RPC-Fehler der ACP-Verbindung tragen ihre eigentliche Aussage nicht in
 * `message`: Bei Code -32603 steht dort schlicht "Internal error", während der
 * Grund in `data` liegt. `error.message` allein ergibt deshalb eine Meldung,
 * mit der niemand etwas anfangen kann. Diese Funktion setzt Meldung, Code,
 * `data` und die Ursachenkette zu einem lesbaren Satz zusammen und hebt die
 * Rohwerte zusätzlich strukturiert auf.
 */
export function describeGeminiError(error: unknown): GeminiErrorDescription {
  if (!(error instanceof Error)) {
    const text = typeof error === "string" ? error.trim() : "";
    return { message: text || "Unbekannter Fehler der Gemini-Integration" };
  }

  const record = error as unknown as Record<string, unknown>;
  const parts: string[] = [error.message || error.name];
  const details: Record<string, JsonValue> = {};

  const code = record["code"];
  if (typeof code === "number" || (typeof code === "string" && code.trim())) {
    details["code"] = code;
    parts[0] = `${parts[0]} (Code ${code})`;
  }
  if (error.name && error.name !== "Error") details["name"] = error.name;

  const dataText = readableData(record["data"]);
  if (dataText) parts.push(dataText);
  const safeData = toJsonSafe(record["data"]);
  if (safeData !== undefined && safeData !== null) details["data"] = safeData;

  // Ursachenkette, begrenzt: die ersten beiden Glieder tragen die Information.
  let cause: unknown = error.cause;
  const causes: string[] = [];
  for (let depth = 0; depth < 2 && cause; depth += 1) {
    const text =
      cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : (readableData(cause) ?? "");
    if (text && !parts.some((part) => part.includes(text))) {
      causes.push(text.slice(0, MAX_DETAIL_TEXT_LENGTH));
      parts.push(`Ursache: ${text.slice(0, MAX_DETAIL_TEXT_LENGTH)}`);
    }
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  if (causes.length > 0) details["cause"] = causes;

  const message = parts.join(" — ").slice(0, MAX_DESCRIPTION_LENGTH);
  return Object.keys(details).length > 0
    ? { message, details }
    : { message };
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "Unknown Gemini integration error";
}
