import { app, BrowserWindow, dialog } from "electron";
import electronSquirrelStartup from "electron-squirrel-startup";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { AppController } from "./app-controller";
import { AttachmentService } from "./attachments/attachment-service";
import { GeminiCapabilityService } from "./capability-service";
import { GitService, GitStatusSubscriptionHub } from "./git";
import { SessionEventHub } from "./ipc/event-hub";
import { registerAppIpc } from "./ipc/register-app-ipc";
import { ProjectService } from "./projects";
import {
  createMainWindow,
  installApplicationMenu,
  loadMainWindow,
  registerAppProtocol,
} from "./security/main-window";
import {
  AttachmentRepository,
  ClientRequestRepository,
  EventRepository,
  ProjectRepository,
  SessionRepository,
  SettingsRepository,
  UsageRepository,
  openAppDatabase,
  type SqliteDatabase,
} from "./storage";
import { UsageService } from "./usage";

app.setName("GeminUI");
configureUserDataPath();

const ownsInstance =
  !electronSquirrelStartup && app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | null = null;
let database: SqliteDatabase | null = null;
let controller: AppController | null = null;
let eventHub: SessionEventHub | null = null;
let gitStatusHub: GitStatusSubscriptionHub | null = null;
let runtimeServices: Omit<
  Parameters<typeof registerAppIpc>[0],
  "mainWindow"
> | null = null;
let unregisterIpc: (() => void) | null = null;
let quitAfterCleanup = false;
let cleanupPromise: Promise<void> | null = null;

if (!ownsInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(bootstrap).catch(handleFatalStartupError);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void openApplicationWindow();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (quitAfterCleanup) return;
    event.preventDefault();
    void cleanup().finally(() => {
      quitAfterCleanup = true;
      app.quit();
    });
  });
}

async function bootstrap(): Promise<void> {
  if (process.platform === "win32") {
    app.setAppUserModelId("dev.geminui.desktop");
  }

  installApplicationMenu();
  await registerAppProtocol();
  database = openAppDatabase(app.getPath("userData"));

  const projectRepository = new ProjectRepository(database);
  const sessionRepository = new SessionRepository(database);
  const eventRepository = new EventRepository(database);
  const attachmentRepository = new AttachmentRepository(database);
  const settingsRepository = new SettingsRepository(database);
  const clientRequestRepository = new ClientRequestRepository(database);
  const usageRepository = new UsageRepository(database);
  const usageService = new UsageService(usageRepository);
  clientRequestRepository.clearPending();

  const projectService = new ProjectService(projectRepository);
  const capabilityService = new GeminiCapabilityService(
    settingsRepository,
    app.getVersion(),
  );
  await capabilityService.refresh();

  const attachmentService = new AttachmentService(
    app.getPath("userData"),
    attachmentRepository,
  );
  await attachmentService.initialize();

  const gitService = new GitService(projectService, capabilityService);
  gitStatusHub = new GitStatusSubscriptionHub(gitService);

  eventHub = new SessionEventHub({
    eventsAfter: (sessionId, afterSeq) =>
      eventRepository.listAfter(sessionId, afterSeq),
    usageSnapshot: (sessionId) => usageService.getSnapshot(sessionId),
  });
  controller = new AppController({
    projects: projectService,
    sessions: sessionRepository,
    events: eventRepository,
    attachmentRepository,
    attachmentService,
    capabilities: capabilityService,
    usage: usageService,
    publishEvents: (events) => eventHub?.publish(events),
  });
  projectService.setRuntimeCoordinator(controller);

  runtimeServices = {
    projects: projectService,
    controller,
    capabilities: capabilityService,
    attachments: attachmentService,
    clientRequests: clientRequestRepository,
    eventHub,
    git: gitService,
    gitStatusHub,
  };
  await openApplicationWindow();
}

async function openApplicationWindow(): Promise<void> {
  if (!runtimeServices) return;

  unregisterIpc?.();
  mainWindow = createMainWindow();
  unregisterIpc = registerAppIpc({ mainWindow, ...runtimeServices });
  await loadMainWindow(mainWindow);
  mainWindow.on("closed", () => {
    unregisterIpc?.();
    unregisterIpc = null;
    mainWindow = null;
  });
}

async function cleanup(): Promise<void> {
  cleanupPromise ??= (async () => {
    unregisterIpc?.();
    unregisterIpc = null;
    eventHub?.close();
    gitStatusHub?.close();
    await controller?.dispose();
    controller = null;
    eventHub = null;
    gitStatusHub = null;
    runtimeServices = null;
    if (database?.open) database.close();
    database = null;
  })();
  return cleanupPromise;
}

function handleFatalStartupError(error: unknown): void {
  const message =
    error instanceof Error ? error.message : "Unbekannter Startfehler";
  dialog.showErrorBox(
    "GeminUI konnte nicht gestartet werden",
    message.slice(0, 2_000),
  );
  void cleanup().finally(() => {
    quitAfterCleanup = true;
    app.quit();
  });
}

function configureUserDataPath(): void {
  // Keep Electron's explicit test/admin override intact.
  if (process.argv.some((argument) => argument.startsWith("--user-data-dir="))) {
    return;
  }
  const appData = app.getPath("appData");
  const legacyPath = path.join(appData, "Gem UI");
  const currentPath = path.join(appData, "GeminUI");
  if (!existsSync(currentPath) && existsSync(legacyPath)) {
    try {
      renameSync(legacyPath, currentPath);
    } catch {
      // Preserve existing projects/sessions if an OS policy blocks migration.
      app.setPath("userData", legacyPath);
      return;
    }
  }
  app.setPath("userData", currentPath);
}
