import {
  WebContentsView,
  type BrowserWindow,
  type Event,
  type Rectangle,
  type Session,
} from "electron";

import type { SetLinkPreviewBoundsInput } from "../../shared";
import type { ContextAttachmentService } from "../context-attachments";
import { openExternalHttps } from "../security/main-window";
import { normalizeUrl } from "./url-policy";

export class LinkPreviewViewHost {
  #view: WebContentsView | null = null;
  #attachmentId: string | null = null;
  #bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly attachments: ContextAttachmentService,
    private readonly previewSession: Session,
  ) {
    previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    previewSession.setPermissionCheckHandler(() => false);
    previewSession.on("will-download", this.#preventDownload);
    mainWindow.on("hide", this.#hide);
    mainWindow.on("resize", this.#reapplyBounds);
  }

  async open(attachmentId: string) {
    const target = this.attachments.getLinkPreviewTarget(attachmentId);
    normalizeUrl(target.url);
    this.close();
    this.#bounds = { x: 0, y: 0, width: 0, height: 0 };
    const view = new WebContentsView({
      webPreferences: {
        session: this.previewSession,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        javascript: true,
        spellcheck: false,
        preload: undefined,
      },
    });
    view.webContents.setWindowOpenHandler(({ url }) => {
      try {
        normalizeUrl(url);
        void openExternalHttps(url).catch(() => undefined);
      } catch {
        // Non-HTTPS popups are denied below without exposing details.
      }
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      try {
        normalizeUrl(url);
      } catch {
        event.preventDefault();
      }
    });
    this.mainWindow.contentView.addChildView(view);
    this.#view = view;
    this.#attachmentId = attachmentId;
    view.setBounds(this.#bounds);
    try {
      await view.webContents.loadURL(target.url);
    } catch (error) {
      this.close();
      throw error;
    }
    return { attachmentId, host: target.host, loading: false };
  }

  setBounds(input: SetLinkPreviewBoundsInput): void {
    this.#bounds = {
      x: Math.round(input.x),
      y: Math.round(input.y),
      width: Math.max(0, Math.round(input.width)),
      height: Math.max(0, Math.round(input.height)),
    };
    this.#view?.setBounds(this.#bounds);
  }

  close(): void {
    const view = this.#view;
    this.#view = null;
    this.#attachmentId = null;
    if (!view) return;
    try {
      this.mainWindow.contentView.removeChildView(view);
    } finally {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
  }

  async clearStorage(): Promise<void> {
    this.close();
    await this.previewSession.clearStorageData();
  }

  dispose(): void {
    this.close();
    this.mainWindow.removeListener("hide", this.#hide);
    this.mainWindow.removeListener("resize", this.#reapplyBounds);
    this.previewSession.removeListener("will-download", this.#preventDownload);
  }

  #hide = () => {
    this.#view?.setBounds({ ...this.#bounds, height: 0 });
  };

  #reapplyBounds = () => {
    this.#view?.setBounds(this.#bounds);
  };

  #preventDownload = (event: Event) => {
    event.preventDefault();
  };
}
