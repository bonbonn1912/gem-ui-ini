import { app, BrowserWindow, dialog } from "electron";
import electronSquirrelStartup from "electron-squirrel-startup";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { AgentExtensionService } from "./agent-extensions";
import { AppController } from "./app-controller";
import { AttachmentService } from "./attachments/attachment-service";
import { GeminiCapabilityService } from "./capability-service";
import {
  ContextAttachmentService,
  ContextAttachmentSubscriptionHub,
} from "./context-attachments";
import { GitService, GitStatusSubscriptionHub } from "./git";
import { SessionEventHub } from "./ipc/event-hub";
import { registerAppIpc } from "./ipc/register-app-ipc";
import { ProjectService } from "./projects";
import { ProjectFileService } from "./project-files";
import { TodoService, TodoSubscriptionHub } from "./todos";
import { LinkMetadataFetcher } from "./links";
import {
  createMainWindow,
  installApplicationMenu,
  loadMainWindow,
  registerAppProtocol,
} from "./security/main-window";
import {
  AttachmentRepository,
  ClientRequestRepository,
  ContextAttachmentRepository,
  EventRepository,
  GitLabRepository,
  JiraRepository,
  ProjectRepository,
  SessionRepository,
  SettingsRepository,
  TodoRepository,
  UsageRepository,
  openAppDatabase,
  type SqliteDatabase,
} from "./storage";
import { UsageService } from "./usage";
import { GitLabService, GitLabSubscriptionHub, GitLabTokenVault } from "./integrations/gitlab";
import { IntegrationRegistry } from "./integrations/integration-registry";
import { JiraService } from "./integrations/jira";
import { ExternalPromptContextRegistry } from "./integrations/external-prompt-context-registry";
import { IPC_CHANNELS } from "../shared/contracts";

app.setName("GeminUI");
configureUserDataPath();

const ownsInstance =
  !electronSquirrelStartup && app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | null = null;
let database: SqliteDatabase | null = null;
let controller: AppController | null = null;
let eventHub: SessionEventHub | null = null;
let gitStatusHub: GitStatusSubscriptionHub | null = null;
let contextAttachmentHub: ContextAttachmentSubscriptionHub | null = null;
let contextAttachmentService: ContextAttachmentService | null = null;
let todoService: TodoService | null = null;
let todoHub: TodoSubscriptionHub | null = null;
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
  const contextAttachmentRepository = new ContextAttachmentRepository(database);
  const settingsRepository = new SettingsRepository(database);
  const clientRequestRepository = new ClientRequestRepository(database);
  const usageRepository = new UsageRepository(database);
  const usageService = new UsageService(usageRepository);
  clientRequestRepository.clearPending();

  const projectService = new ProjectService(projectRepository);
  const projectFileService = new ProjectFileService(projectService);
  const agentExtensionService = new AgentExtensionService(projectService);
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

  const linkMetadataFetcher = new LinkMetadataFetcher();
  contextAttachmentService = new ContextAttachmentService(
    app.getPath("userData"),
    contextAttachmentRepository,
    projectService,
    sessionRepository,
    linkMetadataFetcher,
  );
  await contextAttachmentService.initialize();
  contextAttachmentHub = new ContextAttachmentSubscriptionHub(contextAttachmentService);

  const todoRepository = new TodoRepository(database, contextAttachmentRepository);
  todoService = new TodoService(
    todoRepository,
    contextAttachmentService,
    projectService,
    sessionRepository,
  );
  todoHub = new TodoSubscriptionHub(todoService);

  const gitService = new GitService(projectService, capabilityService);
  gitStatusHub = new GitStatusSubscriptionHub(gitService);

  const gitlabRepository = new GitLabRepository(database);
  const gitlabTokenVault = new GitLabTokenVault();
  const externalPromptContextRegistry = new ExternalPromptContextRegistry();
  const gitlabService = new GitLabService({
    gitlabRepository,
    tokenVault: gitlabTokenVault,
    projectService,
    getGitBinaryPath: () => capabilityService.requireGitBinaryPath(),
  });
  externalPromptContextRegistry.registerProvider("gitlab_review", gitlabService);

  const gitlabSubscriptionHub = new GitLabSubscriptionHub(
    (projectId, bindingId) => gitlabService.getReviewState(projectId, bindingId),
    (subscriptionId, state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.gitlabReviewStateChanged, {
          subscriptionId,
          state,
        });
      }
    },
  );
  const jiraRepository = new JiraRepository(database);
  const jiraService = new JiraService({
    repository: jiraRepository,
    projects: projectService,
    contextAttachments: contextAttachmentService,
  });

  const integrationRegistry = new IntegrationRegistry(
    gitlabRepository,
    jiraRepository,
  );

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
    contextAttachments: contextAttachmentService,
    projectFiles: projectFileService,
    capabilities: capabilityService,
    usage: usageService,
    publishEvents: (events) => eventHub?.publish(events),
    externalContextRegistry: externalPromptContextRegistry,
  });
  projectService.setRuntimeCoordinator(controller);

  runtimeServices = {
    projects: projectService,
    projectFiles: projectFileService,
    agentExtensions: agentExtensionService,
    controller,
    capabilities: capabilityService,
    attachments: attachmentService,
    contextAttachments: contextAttachmentService,
    contextAttachmentHub,
    todos: todoService,
    todoHub,
    linkMetadataFetcher,
    clientRequests: clientRequestRepository,
    eventHub,
    git: gitService,
    gitStatusHub,
    integrations: integrationRegistry,
    gitlab: gitlabService,
    gitlabSubscriptionHub,
    jira: jiraService,
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
    contextAttachmentHub?.close();
    todoHub?.close();
    todoService?.dispose();
    contextAttachmentService?.dispose();
    await controller?.dispose();
    controller = null;
    eventHub = null;
    gitStatusHub = null;
    contextAttachmentHub = null;
    todoHub = null;
    todoService = null;
    contextAttachmentService = null;
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
