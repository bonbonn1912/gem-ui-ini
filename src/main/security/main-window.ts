import {
  BrowserWindow,
  Menu,
  net,
  protocol,
  session,
  shell,
} from "electron";
import type { MenuItemConstructorOptions } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isTrustedRendererUrl, parseExternalHttpsUrl } from "./ipc-guard";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true,
    },
  },
]);

let protocolRegistered = false;

export function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: "GeminUI",
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "Bearbeiten",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Fenster",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(process.platform === "darwin"
          ? [
              { type: "separator" as const },
              { role: "front" as const },
            ]
          : [{ role: "close" as const }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export async function registerAppProtocol(): Promise<void> {
  if (protocolRegistered || MAIN_WINDOW_VITE_DEV_SERVER_URL) return;
  protocolRegistered = true;
  const rendererRoot = path.resolve(
    __dirname,
    `../renderer/${MAIN_WINDOW_VITE_NAME}`,
  );

  await protocol.handle("app", async (request) => {
    const requestUrl = new URL(request.url);
    if (requestUrl.hostname !== "bundle") {
      return new Response("Not found", { status: 404 });
    }

    const relativePath = decodeURIComponent(requestUrl.pathname).replace(
      /^\/+/,
      "",
    );
    const requested = path.resolve(
      rendererRoot,
      relativePath.length > 0 ? relativePath : "index.html",
    );
    if (!isInsideDirectory(rendererRoot, requested)) {
      return new Response("Forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(requested).toString());
  });
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 920,
    minHeight: 640,
    show: false,
    backgroundColor: "#0f1115",
    title: "GeminUI",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("render-process-gone", (_event, details) => {
    if (!window.isDestroyed() && details.reason !== "clean-exit") {
      window.webContents.reload();
    }
  });

  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );

  return window;
}

export function loadMainWindow(window: BrowserWindow): Promise<void> {
  return window.loadURL(
    MAIN_WINDOW_VITE_DEV_SERVER_URL || "app://bundle/index.html",
  );
}

export async function openExternalHttps(value: string): Promise<void> {
  const url = parseExternalHttpsUrl(value);
  await shell.openExternal(url.toString(), { activate: true });
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
