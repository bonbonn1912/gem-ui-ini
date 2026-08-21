import type { BrowserWindow, IpcMainInvokeEvent } from "electron";

export class IpcSecurityError extends Error {
  constructor(message = "Nicht autorisierter IPC-Aufruf.") {
    super(message);
    this.name = "IpcSecurityError";
  }
}

export function assertTrustedIpcSender(
  event: IpcMainInvokeEvent,
  mainWindow: BrowserWindow,
): void {
  if (
    mainWindow.isDestroyed() ||
    event.sender.id !== mainWindow.webContents.id ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    !isTrustedRendererUrl(event.senderFrame.url)
  ) {
    throw new IpcSecurityError();
  }
}

export function isTrustedRendererUrl(value: string): boolean {
  if (value.startsWith("app://bundle/")) return true;
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    try {
      const expected = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      const actual = new URL(value);
      return actual.origin === expected.origin;
    } catch {
      return false;
    }
  }
  return false;
}

export function parseExternalHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IpcSecurityError("Die externe URL ist ungültig.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname
  ) {
    throw new IpcSecurityError("Nur normale HTTPS-Links sind erlaubt.");
  }
  return url;
}

export function toPublicError(error: unknown): Error {
  if (
    error instanceof IpcSecurityError ||
    (error instanceof Error && error.name.endsWith("ValidationError"))
  ) {
    return error;
  }
  if (error instanceof Error) {
    let message = error.message || error.name;
    if (error.cause) {
      const causeMsg =
        error.cause instanceof Error
          ? error.cause.message
          : typeof error.cause === "string"
            ? error.cause
            : JSON.stringify(error.cause);
      if (causeMsg && !message.includes(causeMsg)) {
        message += ` (Ursache: ${causeMsg})`;
      }
    }
    if (
      "details" in error &&
      error.details &&
      typeof error.details === "object"
    ) {
      try {
        const detailsStr = JSON.stringify(error.details);
        if (detailsStr !== "{}") {
          message += ` [Details: ${detailsStr}]`;
        }
      } catch {
        // ignore JSON circular refs
      }
    }
    return new Error(message.slice(0, 2000));
  }
  return new Error(
    String(error).slice(0, 2000) || "Die Aktion konnte nicht ausgeführt werden.",
  );
}
