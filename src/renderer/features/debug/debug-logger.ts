export type DebugLogLevel = "info" | "warn" | "error" | "stream" | "ipc";
export type DebugLogSource = "app" | "gemini" | "git" | "ipc" | "renderer" | "system";

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
  private maxLogs = 1000;
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
    const entry: DebugLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date(),
      level,
      source,
      message,
      details,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.splice(0, this.logs.length - this.maxLogs);
    }

    this.notify();
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
    this.notify();
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getLogs());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const current = this.getLogs();
    for (const listener of this.listeners) {
      try {
        listener(current);
      } catch (err) {
        console.error("Error in debug log listener:", err);
      }
    }
  }
}

export const debugLogger = new DebugLoggerService();
