export type DebugLogLevel = "info" | "warn" | "error" | "stream" | "ipc";
export type DebugLogSource = "app" | "gemini" | "git" | "ipc" | "renderer" | "system" | "jira";

export interface DebugLogEntry {
  id: string;
  timestamp: Date;
  level: DebugLogLevel;
  source: DebugLogSource;
  message: string;
  details?: unknown;
}

type Listener = (logs: DebugLogEntry[]) => void;

class DebugLoggerService {
  private logs: DebugLogEntry[] = [];
  private listeners: Set<Listener> = new Set();
  private readonly maxLogs = 1000;
  private readonly maxBytes = 2 * 1024 * 1024;
  private retainedBytes = 0;
  private notifyScheduled = false;
  private verboseDiagnostics = false;
  private isInitialized = false;

  constructor() {
    if (typeof window !== "undefined") {
      this.initGlobalErrorHandlers();
    }
  }

  private initGlobalErrorHandlers() {
    if (this.isInitialized) return;
    this.isInitialized = true;

    window.addEventListener("error", (event) => {
      this.error(
        "renderer",
        `Unbehandelter Fehler: ${event.message || "Unbekannter Script-Fehler"}`,
        {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          error: event.error ? String(event.error?.stack || event.error) : undefined,
        },
      );
    });

    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      this.error(
        "renderer",
        `Unhandled Promise Rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
        {
          stack: reason instanceof Error ? reason.stack : undefined,
          reason,
        },
      );
    });
  }

  public log(
    level: DebugLogLevel,
    source: DebugLogSource,
    message: string,
    details?: unknown,
  ): DebugLogEntry {
    const safeMessage = message.slice(0, 1_000);
    const safeDetails = details === undefined ? undefined : redact(details, 0, "", this.verboseDiagnostics);
    const entry: DebugLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date(),
      level,
      source,
      message: safeMessage,
      details: safeDetails,
    };

    this.logs.push(entry);
    this.retainedBytes += estimateBytes(entry);
    while (this.logs.length > this.maxLogs || this.retainedBytes > this.maxBytes) {
      const removed = this.logs.shift();
      if (removed) this.retainedBytes -= estimateBytes(removed);
    }

    this.scheduleNotify();
    return entry;
  }

  public info(source: DebugLogSource, message: string, details?: unknown): DebugLogEntry {
    return this.log("info", source, message, details);
  }

  public warn(source: DebugLogSource, message: string, details?: unknown): DebugLogEntry {
    return this.log("warn", source, message, details);
  }

  public error(source: DebugLogSource, message: string, details?: unknown): DebugLogEntry {
    return this.log("error", source, message, details);
  }

  public stream(source: DebugLogSource, message: string, details?: unknown): DebugLogEntry {
    return this.log("stream", source, message, details);
  }

  public ipc(source: DebugLogSource, message: string, details?: unknown): DebugLogEntry {
    return this.log("ipc", source, message, details);
  }

  public getLogs(): DebugLogEntry[] {
    return [...this.logs];
  }

  public clear(): void {
    this.logs = [];
    this.retainedBytes = 0;
    this.notify();
  }

  public setVerboseDiagnostics(enabled: boolean): void {
    this.verboseDiagnostics = enabled;
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getLogs());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const current = this.getLogs();
    for (const listener of this.listeners) {
      try {
        listener(current);
      } catch (err) {
        console.error("Error in debug log listener:", err);
      }
    }
  }

  private scheduleNotify(): void {
    if (this.listeners.size === 0 || this.notifyScheduled) return;
    this.notifyScheduled = true;
    const flush = () => {
      this.notifyScheduled = false;
      this.notify();
    };
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(flush);
    } else {
      setTimeout(flush, 50);
    }
  }
}

const SECRET_KEY = /token|secret|password|authorization|cookie|api.?key|credential/i;

/** Keep small metadata by default; full diagnostic values require explicit opt-in. */
function redact(value: unknown, depth = 0, key = "", verbose = false): unknown {
  const compactStringKeys = /^(type|code|status|name|source|level|kind|toolCallId|requestId)$/i;
  if (typeof value === "string") {
    if (!verbose && !compactStringKeys.test(key)) return `[Text mit ${value.length} Zeichen]`;
    return value.length > 240 ? `${value.slice(0, 240)}… [gekürzt]` : value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return { name: value.name, message: value.message.slice(0, 240) };
  if (depth >= 3) return "[Details gekürzt]";
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => redact(item, depth + 1, "", verbose));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 24)) {
      result[key] = SECRET_KEY.test(key) ? "[redigiert]" : redact(child, depth + 1, key, verbose);
    }
    return result;
  }
  return String(value).slice(0, 240);
}

function estimateBytes(entry: DebugLogEntry): number {
  try {
    return new TextEncoder().encode(JSON.stringify(entry)).byteLength;
  } catch {
    return 256;
  }
}

export const debugLogger = new DebugLoggerService();
