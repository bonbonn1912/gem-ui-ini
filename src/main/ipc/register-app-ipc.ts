import { dialog, type BrowserWindow } from "electron";
import path from "node:path";
import {
  IPC_CHANNELS,
  JsonValueSchema,
  type ActivateJiraProjectIntegrationInput,
  type ArchiveProjectInput,
  type AttachJiraIssueInput,
  type AddContextFilesInput,
  type DeactivateJiraProjectIntegrationInput,
  type DeleteJiraConfigInput,
  type GetJiraProjectIntegrationInput,
  type SaveJiraConfigInput,
  type AddContextLinkInput,
  type AddTodoFilesInput,
  type AddTodoLinkInput,
  type AttachmentPreviewInput,
  type AttachTodoAttachmentInput,
  type CancelTurnInput,
  type ClipboardImageInput,
  type CreateProjectInput,
  type CreateSessionInput,
  type CreateTodoInput,
  type DeleteProjectInput,
  type DeleteSessionInput,
  type DeleteTodoInput,
  type DetachTodoAttachmentInput,
  type ContextAttachmentBytesInput,
  type GetProjectInput,
  type ListAgentExtensionsInput,
  type GetProjectApprovalPolicyInput,
  type GetGitFileDiffInput,
  type GetGitProjectStatusInput,
  type ListProjectsInput,
  type ListSessionsInput,
  type ListContextAttachmentsInput,
  type ListTodosInput,
  type OpenContextAttachmentInput,
  type OpenLinkPreviewInput,
  type PermissionResponse,
  type PickImagesInput,
  type PrepareTodoForSessionInput,
  type RemoveAttachmentInput,
  type ReorderTodosInput,
  type RemoveContextAttachmentInput,
  type RefreshLinkPreviewInput,
  type ReauthorizeProjectRootInput,
  type RenameProjectInput,
  type SendPromptInput,
  type SetProjectRootsInput,
  type SetProjectApprovalPolicyInput,
  type SearchProjectFilesInput,
  type SearchSessionsInput,
  type SetSessionModeInput,
  type SetSessionModelInput,
  type SetContextInclusionInput,
  type SetLinkPreviewBoundsInput,
  type StageDroppedPathInput,
  type SubscribeSessionEventsInput,
  type SubscribeGitProjectStatusInput,
  type UpdateSessionInput,
  type UpdateContextAttachmentInput,
  type UpdateTodoInput,
} from "../../shared/contracts";
import type { AgentExtensionService } from "../agent-extensions";
import type { AppController } from "../app-controller";
import type { AttachmentService } from "../attachments/attachment-service";
import type {
  ContextAttachmentService,
  ContextAttachmentSubscriptionHub,
} from "../context-attachments";
import type { GeminiCapabilityService } from "../capability-service";
import type { GitService, GitStatusSubscriptionHub } from "../git";
import type { ProjectService } from "../projects";
import type { ProjectFileService } from "../project-files";
import type { TodoService, TodoSubscriptionHub } from "../todos";
import { LinkPreviewViewHost, type LinkMetadataFetcher } from "../links";
import type { ClientRequestRepository } from "../storage";
import { openExternalHttps, openStoredFile } from "../security/main-window";
import type { SessionEventHub } from "./event-hub";
import { registerValidatedIpcHandler } from "./register-handler";

import type { IntegrationRegistry } from "../integrations/integration-registry";
import type { GitLabService, GitLabSubscriptionHub } from "../integrations/gitlab";
import type { JiraService } from "../integrations/jira";
import { AppUpdateService } from "../updates/app-update-service";

export type RegisterAppIpcOptions = {
  mainWindow: BrowserWindow;
  projects: ProjectService;
  projectFiles: ProjectFileService;
  agentExtensions: AgentExtensionService;
  controller: AppController;
  capabilities: GeminiCapabilityService;
  attachments: AttachmentService;
  contextAttachments: ContextAttachmentService;
  contextAttachmentHub: ContextAttachmentSubscriptionHub;
  todos: TodoService;
  todoHub: TodoSubscriptionHub;
  linkMetadataFetcher: LinkMetadataFetcher;
  clientRequests: ClientRequestRepository;
  eventHub: SessionEventHub;
  git: GitService;
  gitStatusHub: GitStatusSubscriptionHub;
  integrations?: IntegrationRegistry;
  gitlab?: GitLabService;
  gitlabSubscriptionHub?: GitLabSubscriptionHub;
  jira?: JiraService;
  updateService?: AppUpdateService;
};

export function registerAppIpc(options: RegisterAppIpcOptions): () => void {
  const cleanups: Array<() => void> = [];
  const latestGitStatus = new Map<number, AbortController>();
  const latestGitDiff = new Map<number, AbortController>();
  const linkPreview = new LinkPreviewViewHost(
    options.mainWindow,
    options.contextAttachments,
    options.linkMetadataFetcher.previewSession,
  );
  const register = (
    channel: Parameters<typeof registerValidatedIpcHandler>[0],
    handler: Parameters<typeof registerValidatedIpcHandler>[2],
  ) => {
    cleanups.push(
      registerValidatedIpcHandler(channel, options.mainWindow, handler),
    );
  };

  register(IPC_CHANNELS.getCapabilities, () => options.capabilities.snapshot());

  register(IPC_CHANNELS.chooseGeminiBinary, async () => {
    options.controller.assertCanSwitchGeminiBinary();
    const result = await dialog.showOpenDialog(options.mainWindow, {
      title: "Gemini CLI auswählen",
      buttonLabel: "Gemini verwenden",
      properties: ["openFile"],
    });
    const binaryPath = result.filePaths[0];
    if (result.canceled || !binaryPath) return options.capabilities.snapshot();
    await options.controller.resetGeminiManager();
    return options.capabilities.choose(binaryPath);
  });

  register(IPC_CHANNELS.chooseGitBinary, async () => {
    const result = await dialog.showOpenDialog(options.mainWindow, {
      title: "Git auswählen",
      buttonLabel: "Git verwenden",
      properties: ["openFile"],
      filters: process.platform === "win32"
        ? [{ name: "Git", extensions: ["exe"] }]
        : undefined,
    });
    const binaryPath = result.filePaths[0];
    if (result.canceled || !binaryPath) return options.capabilities.snapshot();
    return options.capabilities.chooseGit(binaryPath);
  });

  register(IPC_CHANNELS.listProjects, (input) =>
    options.projects.list(input as ListProjectsInput),
  );
  register(IPC_CHANNELS.getProject, (input) =>
    options.projects.get((input as GetProjectInput).projectId),
  );
  register(IPC_CHANNELS.searchProjectFiles, (input) =>
    options.projectFiles.search(input as SearchProjectFilesInput),
  );
  register(IPC_CHANNELS.reauthorizeProjectRoot, async (input) => {
    const value = input as ReauthorizeProjectRootInput;
    const root = options.projects.getRootForReauthorization(
      value.projectId,
      value.rootId,
    );
    const result = await dialog.showOpenDialog(options.mainWindow, {
      title: `Zugriff auf „${root.label}“ erneut erlauben`,
      buttonLabel: "Diesen Ordner erlauben",
      defaultPath: root.path,
      message:
        "Wähle exakt den bereits gespeicherten Projektordner aus. Die Projektkonfiguration wird nicht geändert.",
      properties: ["openDirectory"],
    });
    const selectedPath = result.filePaths[0];
    if (result.canceled || !selectedPath) {
      return { status: "cancelled" as const };
    }
    const authorizedRoot = await options.projects.reauthorizeRootSelection({
      projectId: value.projectId,
      rootId: value.rootId,
      selectedPath,
    });
    return { status: "authorized" as const, root: authorizedRoot };
  });
  register(IPC_CHANNELS.getProjectApprovalPolicy, (input) =>
    options.controller.getProjectApprovalPolicy(
      input as GetProjectApprovalPolicyInput,
    ),
  );
  register(IPC_CHANNELS.pickProjectFolders, async (input) => {
    const allowMultiple = (input as { allowMultiple: boolean }).allowMultiple;
    const result = await dialog.showOpenDialog(options.mainWindow, {
      title: "Projektordner auswählen",
      buttonLabel: "Ordner übernehmen",
      properties: [
        "openDirectory",
        "createDirectory",
        ...(allowMultiple ? (["multiSelections"] as const) : []),
      ],
    });
    if (result.canceled) return [];
    if (result.filePaths.length > 6) {
      throw new Error(
        "Ein Projekt unterstützt einen Hauptordner und höchstens fünf Zusatzordner.",
      );
    }
    return result.filePaths.map((filePath) => ({
      path: filePath,
      label: path.basename(filePath) || path.parse(filePath).root,
    }));
  });

  register(IPC_CHANNELS.createProject, (input) =>
    idempotent(
      options.clientRequests,
      input as CreateProjectInput,
      "projects.create",
      () => options.projects.create(input as CreateProjectInput),
    ),
  );
  register(IPC_CHANNELS.renameProject, (input) =>
    idempotent(
      options.clientRequests,
      input as RenameProjectInput,
      "projects.rename",
      () => options.projects.rename(input as RenameProjectInput),
    ),
  );
  register(IPC_CHANNELS.archiveProject, (input) =>
    idempotent(
      options.clientRequests,
      input as ArchiveProjectInput,
      "projects.archive",
      () => options.projects.setArchived(input as ArchiveProjectInput),
    ),
  );
  register(IPC_CHANNELS.setProjectRoots, (input) =>
    idempotent(
      options.clientRequests,
      input as SetProjectRootsInput,
      "projects.set-roots",
      () => options.projects.setAdditionalRoots(input as SetProjectRootsInput),
    ),
  );
  register(IPC_CHANNELS.setProjectApprovalPolicy, (input) =>
    idempotent(
      options.clientRequests,
      input as SetProjectApprovalPolicyInput,
      "projects.set-approval-policy",
      () =>
        options.controller.setProjectApprovalPolicy(
          input as SetProjectApprovalPolicyInput,
        ),
    ),
  );
  register(IPC_CHANNELS.deleteProject, (input) =>
    idempotent(
      options.clientRequests,
      input as DeleteProjectInput,
      "projects.delete",
      async () => {
        const value = input as DeleteProjectInput;
        await options.controller.prepareProjectDeletion(value.projectId);
        options.projects.delete(value);
        return { ok: true as const };
      },
    ),
  );

  register(IPC_CHANNELS.listSessions, (input) =>
    options.controller.listSessions(input as ListSessionsInput),
  );
  register(IPC_CHANNELS.createSession, (input) =>
    idempotent(
      options.clientRequests,
      input as CreateSessionInput,
      "sessions.create",
      () => options.controller.createSession(input as CreateSessionInput),
    ),
  );
  register(IPC_CHANNELS.updateSession, (input) =>
    idempotent(
      options.clientRequests,
      input as UpdateSessionInput,
      "sessions.update",
      () => options.controller.updateSession(input as UpdateSessionInput),
    ),
  );
  register(IPC_CHANNELS.deleteSession, (input) =>
    idempotent(
      options.clientRequests,
      input as DeleteSessionInput,
      "sessions.delete",
      async () => {
        await options.controller.deleteSession(input as DeleteSessionInput);
        return { ok: true as const };
      },
    ),
  );
  register(IPC_CHANNELS.sendPrompt, (input) =>
    idempotent(
      options.clientRequests,
      input as SendPromptInput,
      "sessions.send-prompt",
      () => options.controller.sendPrompt(input as SendPromptInput),
    ),
  );
  register(IPC_CHANNELS.cancelTurn, (input) =>
    idempotent(
      options.clientRequests,
      input as CancelTurnInput,
      "sessions.cancel-turn",
      async () => {
        await options.controller.cancelTurn(input as CancelTurnInput);
        return { ok: true as const };
      },
    ),
  );
  register(IPC_CHANNELS.respondToPermission, (input) =>
    idempotent(
      options.clientRequests,
      input as PermissionResponse,
      "sessions.respond-permission",
      () => {
        options.controller.respondToPermission(input as PermissionResponse);
        return { ok: true as const };
      },
    ),
  );
  register(IPC_CHANNELS.setSessionMode, (input) =>
    idempotent(
      options.clientRequests,
      input as SetSessionModeInput,
      "sessions.set-mode",
      () => options.controller.setMode(input as SetSessionModeInput),
    ),
  );
  register(IPC_CHANNELS.setSessionModel, (input) =>
    idempotent(
      options.clientRequests,
      input as SetSessionModelInput,
      "sessions.set-model",
      () => options.controller.setModel(input as SetSessionModelInput),
    ),
  );

  register(IPC_CHANNELS.getSessionReconnectState, (input) =>
    options.controller.getSessionReconnectState(
      input as { sessionId: string },
    ),
  );

  register(IPC_CHANNELS.searchSessions, (input) =>
    options.controller.searchSessions(input as SearchSessionsInput),
  );

  register(IPC_CHANNELS.pickImages, (input) =>
    idempotent(
      options.clientRequests,
      input as PickImagesInput,
      "attachments.pick",
      async () => {
        const value = input as PickImagesInput;
        const result = await dialog.showOpenDialog(options.mainWindow, {
          title: "Bilder auswählen",
          buttonLabel: "Bilder anhängen",
          properties: ["openFile", "multiSelections"],
          filters: [
            {
              name: "Bilder",
              extensions: ["png", "jpg", "jpeg", "webp", "gif"],
            },
          ],
        });
        if (result.canceled) return [];
        return stageFiles(
          options.attachments,
          result.filePaths,
          value.sessionId ?? null,
        );
      },
    ),
  );
  register(IPC_CHANNELS.stageDroppedPaths, (input) =>
    idempotent(
      options.clientRequests,
      input as StageDroppedPathInput,
      "attachments.stage-dropped",
      () => {
        const value = input as StageDroppedPathInput;
        if (value.paths.some((filePath) => !path.isAbsolute(filePath))) {
          throw new Error("Gedroppte Dateien müssen absolute Pfade besitzen.");
        }
        return stageFiles(
          options.attachments,
          value.paths,
          value.sessionId ?? null,
        );
      },
    ),
  );
  register(IPC_CHANNELS.stageClipboardImage, (input) =>
    idempotent(
      options.clientRequests,
      input as ClipboardImageInput,
      "attachments.stage-clipboard",
      () => {
        const value = input as ClipboardImageInput;
        return options.attachments.stageBytes({
          bytes: value.bytes,
          displayName: value.displayName,
          declaredMimeType: value.mimeType,
          sessionId: value.sessionId,
        });
      },
    ),
  );
  register(IPC_CHANNELS.getAttachmentPreview, (input) =>
    options.attachments.getPreviewBytes(
      (input as AttachmentPreviewInput).attachmentId,
    ),
  );
  register(IPC_CHANNELS.removeAttachment, (input) =>
    idempotent(
      options.clientRequests,
      input as RemoveAttachmentInput,
      "attachments.remove",
      async () => {
        await options.attachments.remove(
          (input as RemoveAttachmentInput).attachmentId,
        );
        return { ok: true as const };
      },
    ),
  );

  register(IPC_CHANNELS.listContextAttachments, (input) =>
    options.contextAttachments.list(input as ListContextAttachmentsInput),
  );
  register(IPC_CHANNELS.addContextFiles, (input) =>
    idempotent(
      options.clientRequests,
      input as AddContextFilesInput,
      "context-attachments.add-files",
      async () => {
        const value = input as AddContextFilesInput;
        let paths = value.paths ?? [];
        if (paths.length === 0) {
          const result = await dialog.showOpenDialog(options.mainWindow, {
            title: "Dateien als dauerhafte Anhänge hinzufügen",
            buttonLabel: "Anhängen",
            properties: ["openFile", "multiSelections"],
          });
          if (result.canceled) return options.contextAttachments.list({
            projectId: value.projectId,
            sessionId: value.sessionId,
          });
          paths = result.filePaths;
        }
        if (paths.some((filePath) => !path.isAbsolute(filePath))) {
          throw new Error("Anhangspfade müssen absolut sein.");
        }
        return options.contextAttachments.addFiles({ ...value, paths });
      },
    ),
  );
  register(IPC_CHANNELS.addContextLink, (input) =>
    idempotent(
      options.clientRequests,
      input as AddContextLinkInput,
      "context-attachments.add-link",
      () => options.contextAttachments.addLink(input as AddContextLinkInput),
    ),
  );
  register(IPC_CHANNELS.updateContextAttachment, (input) =>
    idempotent(
      options.clientRequests,
      input as UpdateContextAttachmentInput,
      "context-attachments.update",
      () => options.contextAttachments.update(input as UpdateContextAttachmentInput),
    ),
  );
  register(IPC_CHANNELS.setContextInclusion, (input) =>
    idempotent(
      options.clientRequests,
      input as SetContextInclusionInput,
      "context-attachments.set-inclusion",
      () => options.contextAttachments.setInclusion(input as SetContextInclusionInput),
    ),
  );
  register(IPC_CHANNELS.removeContextAttachment, (input) =>
    idempotent(
      options.clientRequests,
      input as RemoveContextAttachmentInput,
      "context-attachments.remove",
      () => options.contextAttachments.remove(input as RemoveContextAttachmentInput),
    ),
  );
  register(IPC_CHANNELS.refreshLinkPreview, (input) =>
    idempotent(
      options.clientRequests,
      input as RefreshLinkPreviewInput,
      "context-attachments.refresh-link-preview",
      () => options.contextAttachments.refreshLinkPreview(
        (input as RefreshLinkPreviewInput).attachmentId,
      ),
    ),
  );
  register(IPC_CHANNELS.getContextAttachmentBytes, (input) =>
    options.contextAttachments.getBytes(input as ContextAttachmentBytesInput),
  );
  register(IPC_CHANNELS.subscribeContextAttachments, (input, event) =>
    options.contextAttachmentHub.subscribe({
      value: input as ListContextAttachmentsInput,
      webContents: event.sender,
    }),
  );
  register(IPC_CHANNELS.unsubscribeContextAttachments, (input, event) => {
    options.contextAttachmentHub.unsubscribe(
      (input as { subscriptionId: string }).subscriptionId,
      event.sender,
    );
    return { ok: true };
  });
  register(IPC_CHANNELS.openContextAttachment, async (input) => {
    await openStoredFile(
      await options.contextAttachments.getOriginalPath(
        (input as OpenContextAttachmentInput).attachmentId,
      ),
    );
    return { ok: true };
  });
  register(IPC_CHANNELS.listTodos, (input) =>
    options.todos.list(input as ListTodosInput),
  );
  register(IPC_CHANNELS.createTodo, (input) =>
    idempotent(
      options.clientRequests,
      input as CreateTodoInput,
      "todos.create",
      () => options.todos.create(input as CreateTodoInput),
    ),
  );
  register(IPC_CHANNELS.updateTodo, (input) =>
    idempotent(
      options.clientRequests,
      input as UpdateTodoInput,
      "todos.update",
      () => options.todos.update(input as UpdateTodoInput),
    ),
  );
  register(IPC_CHANNELS.reorderTodos, (input) =>
    idempotent(
      options.clientRequests,
      input as ReorderTodosInput,
      "todos.reorder",
      () => options.todos.reorder(input as ReorderTodosInput),
    ),
  );
  register(IPC_CHANNELS.deleteTodo, (input) =>
    idempotent(
      options.clientRequests,
      input as DeleteTodoInput,
      "todos.delete",
      () => options.todos.delete(input as DeleteTodoInput),
    ),
  );
  register(IPC_CHANNELS.addTodoFiles, (input) =>
    idempotent(
      options.clientRequests,
      input as AddTodoFilesInput,
      "todos.add-files",
      async () => {
        const value = input as AddTodoFilesInput;
        let paths = value.paths ?? [];
        if (paths.length === 0) {
          const result = await dialog.showOpenDialog(options.mainWindow, {
            title: "Dateien an dieses Todo anhängen",
            buttonLabel: "Anhängen",
            properties: ["openFile", "multiSelections"],
          });
          // An empty ingest is the cheapest way to answer with the todo's
          // current state without teaching this handler where it lives.
          if (result.canceled) return options.todos.addFiles({ ...value, paths: [] });
          paths = result.filePaths;
        }
        if (paths.some((filePath) => !path.isAbsolute(filePath))) {
          throw new Error("Anhangspfade müssen absolut sein.");
        }
        return options.todos.addFiles({ ...value, paths });
      },
    ),
  );
  register(IPC_CHANNELS.addTodoLink, (input) =>
    idempotent(
      options.clientRequests,
      input as AddTodoLinkInput,
      "todos.add-link",
      () => options.todos.addLink(input as AddTodoLinkInput),
    ),
  );
  register(IPC_CHANNELS.attachTodoAttachment, (input) =>
    idempotent(
      options.clientRequests,
      input as AttachTodoAttachmentInput,
      "todos.attach-attachment",
      () => options.todos.attachAttachment(input as AttachTodoAttachmentInput),
    ),
  );
  register(IPC_CHANNELS.detachTodoAttachment, (input) =>
    idempotent(
      options.clientRequests,
      input as DetachTodoAttachmentInput,
      "todos.detach-attachment",
      () => options.todos.detachAttachment(input as DetachTodoAttachmentInput),
    ),
  );
  register(IPC_CHANNELS.prepareTodoForSession, (input) =>
    idempotent(
      options.clientRequests,
      input as PrepareTodoForSessionInput,
      "todos.prepare-for-session",
      () => options.todos.prepareForSession(input as PrepareTodoForSessionInput),
    ),
  );
  register(IPC_CHANNELS.subscribeTodos, (input, event) =>
    options.todoHub.subscribe({
      value: input as ListTodosInput,
      webContents: event.sender,
    }),
  );
  register(IPC_CHANNELS.unsubscribeTodos, (input, event) => {
    options.todoHub.unsubscribe(
      (input as { subscriptionId: string }).subscriptionId,
      event.sender,
    );
    return { ok: true };
  });
  register(IPC_CHANNELS.openLinkPreviewView, (input) =>
    linkPreview.open(input as OpenLinkPreviewInput),
  );
  register(IPC_CHANNELS.setLinkPreviewBounds, (input) => {
    linkPreview.setBounds(input as SetLinkPreviewBoundsInput);
    return { ok: true };
  });
  register(IPC_CHANNELS.closeLinkPreviewView, () => {
    linkPreview.close();
    return { ok: true };
  });
  register(IPC_CHANNELS.clearLinkPreviewStorage, (input) =>
    idempotent(
      options.clientRequests,
      input as { clientRequestId: string },
      "link-preview.clear-storage",
      async () => {
        await linkPreview.clearStorage();
        return { ok: true as const };
      },
    ),
  );

  register(IPC_CHANNELS.subscribeSessionEvents, (input, event) => {
    const value = input as SubscribeSessionEventsInput;
    return options.eventHub.subscribe({
      ...value,
      webContents: event.sender,
    });
  });
  register(IPC_CHANNELS.unsubscribeSessionEvents, (input, event) => {
    options.eventHub.unsubscribe(
      (input as { subscriptionId: string }).subscriptionId,
      event.sender,
    );
    return { ok: true };
  });

  register(IPC_CHANNELS.listGitProjectRepositories, (input) =>
    options.git.listProjectRepositories(input as GetGitProjectStatusInput),
  );
  register(IPC_CHANNELS.getGitProjectStatus, (input, event) =>
    runLatestGitRequest(latestGitStatus, event.sender.id, (signal) =>
      options.git.getProjectStatus(input as GetGitProjectStatusInput, signal),
    ),
  );
  register(IPC_CHANNELS.getGitFileDiff, (input, event) =>
    runLatestGitRequest(latestGitDiff, event.sender.id, (signal) =>
      options.git.getFileDiff(input as GetGitFileDiffInput, signal),
    ),
  );
  register(IPC_CHANNELS.subscribeGitProjectStatus, (input, event) =>
    runLatestGitRequest(latestGitStatus, event.sender.id, (signal) =>
      options.gitStatusHub.subscribe({
        value: input as SubscribeGitProjectStatusInput,
        webContents: event.sender,
        signal,
      }),
    ),
  );
  register(IPC_CHANNELS.unsubscribeGitProjectStatus, (input, event) => {
    options.gitStatusHub.unsubscribe(
      (input as { subscriptionId: string }).subscriptionId,
      event.sender,
    );
    return { ok: true };
  });

  register(IPC_CHANNELS.listGeminiSkills, (input) =>
    options.agentExtensions.listSkills(input as ListAgentExtensionsInput),
  );
  register(IPC_CHANNELS.listMcpServers, (input) =>
    options.agentExtensions.listMcpServers(input as ListAgentExtensionsInput),
  );

  register(IPC_CHANNELS.openExternalHttpsUrl, async (input) => {
    await openExternalHttps((input as { url: string }).url);
    return { ok: true };
  });

  const updateService = options.updateService ?? new AppUpdateService();
  register(IPC_CHANNELS.checkForUpdates, () => updateService.checkForUpdates());
  register(IPC_CHANNELS.downloadUpdate, (input, event) =>
    updateService.downloadUpdate(
      (input as { downloadUrl: string }).downloadUrl,
      (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC_CHANNELS.appUpdateDownloadProgress, progress);
        }
      },
    ),
  );
  register(IPC_CHANNELS.installUpdate, async (input) => {
    await updateService.installUpdate((input as { filePath: string }).filePath);
    return { ok: true as const };
  });

  if (options.integrations) {
    register(IPC_CHANNELS.listProjectIntegrations, (input) =>
      options.integrations!.listProjectIntegrations(
        (input as { projectId: string }).projectId,
      ),
    );
  }

  if (options.gitlab) {
    const gitlab = options.gitlab;

    register(IPC_CHANNELS.listGitLabRepositoryCandidates, (input) =>
      gitlab.listRepositoryCandidates((input as { projectId: string }).projectId),
    );

    register(IPC_CHANNELS.listGitLabConnections, () =>
      gitlab.listConnections(),
    );

    register(IPC_CHANNELS.testGitLabConnection, (input) =>
      gitlab.testConnection(input as any),
    );

    register(IPC_CHANNELS.saveGitLabConnection, (input) =>
      idempotent(options.clientRequests, input as any, "gitlab.save-connection", () =>
        gitlab.saveConnection(input as any),
      ),
    );

    register(IPC_CHANNELS.replaceGitLabToken, (input) =>
      idempotent(options.clientRequests, input as any, "gitlab.replace-token", () =>
        gitlab.replaceToken(input as any),
      ),
    );

    register(IPC_CHANNELS.removeGitLabConnection, (input) =>
      idempotent(options.clientRequests, input as any, "gitlab.remove-connection", () => {
        gitlab.removeConnection(input as any);
        return { ok: true };
      }),
    );

    register(IPC_CHANNELS.enableGitLabBinding, (input) =>
      idempotent(options.clientRequests, input as any, "gitlab.enable-binding", () =>
        gitlab.enableBinding(input as any),
      ),
    );

    register(IPC_CHANNELS.disableGitLabBinding, (input) =>
      idempotent(options.clientRequests, input as any, "gitlab.disable-binding", async () => {
        const inp = input as { projectId: string; bindingId: string };
        await gitlab.disableBinding(inp.projectId, inp.bindingId);
        return { ok: true };
      }),
    );

    register(IPC_CHANNELS.listGitLabMergeRequests, (input) => {
      const inp = input as { projectId: string; bindingId: string };
      return gitlab.listMergeRequests(inp.projectId, inp.bindingId);
    });

    register(IPC_CHANNELS.selectGitLabMergeRequest, (input) =>
      idempotent(options.clientRequests, input as any, "gitlab.select-merge-request", () =>
        gitlab.selectMergeRequest(input as any),
      ),
    );

    register(IPC_CHANNELS.connectGitLabMergeRequestUrl, (input) =>
      idempotent(options.clientRequests, input as any, "gitlab.connect-merge-request-url", () =>
        gitlab.connectMergeRequestUrl(input as any),
      ),
    );

    register(IPC_CHANNELS.getGitLabReviewState, (input) => {
      const inp = input as { projectId: string; bindingId: string };
      return gitlab.getReviewState(inp.projectId, inp.bindingId);
    });

    register(IPC_CHANNELS.prepareGitLabReviewContext, (input) =>
      gitlab.prepareReviewContext(input as any),
    );

    register(IPC_CHANNELS.resolveGitLabDiscussion, (input) =>
      idempotent(options.clientRequests, input as any, "gitlab.resolve-discussion", () =>
        gitlab.resolveDiscussion(input as any),
      ),
    );

    register(IPC_CHANNELS.replyToGitLabDiscussion, (input) =>
      idempotent(options.clientRequests, input as any, "gitlab.reply-to-discussion", () =>
        gitlab.replyToDiscussion(input as any),
      ),
    );
  }

  if (options.gitlabSubscriptionHub) {
    const hub = options.gitlabSubscriptionHub;
    register(IPC_CHANNELS.subscribeGitLabReviewState, (input) => {
      const inp = input as { projectId: string; bindingId: string };
      return hub.subscribe(inp.projectId, inp.bindingId);
    });

    register(IPC_CHANNELS.unsubscribeGitLabReviewState, (input) => {
      const inp = input as { subscriptionId: string };
      hub.unsubscribe(inp.subscriptionId);
      return { ok: true };
    });
  }

  if (options.jira) {
    const jira = options.jira;

    register(IPC_CHANNELS.listJiraConfigs, () => jira.listConfigs());

    register(IPC_CHANNELS.saveJiraConfig, (input) =>
      idempotent(options.clientRequests, input as SaveJiraConfigInput & { clientRequestId: string }, "jira.save-config", () =>
        jira.saveConfig(input as SaveJiraConfigInput),
      ),
    );

    register(IPC_CHANNELS.deleteJiraConfig, (input) =>
      idempotent(options.clientRequests, input as DeleteJiraConfigInput & { clientRequestId: string }, "jira.delete-config", () =>
        jira.deleteConfig(input as DeleteJiraConfigInput),
      ),
    );

    register(IPC_CHANNELS.getJiraProjectIntegration, (input) =>
      jira.getProjectIntegration(input as GetJiraProjectIntegrationInput),
    );

    register(IPC_CHANNELS.activateJiraProjectIntegration, (input) =>
      idempotent(
        options.clientRequests,
        input as ActivateJiraProjectIntegrationInput & { clientRequestId: string },
        "jira.activate-project-integration",
        () => jira.activate(input as ActivateJiraProjectIntegrationInput),
      ),
    );

    register(IPC_CHANNELS.deactivateJiraProjectIntegration, (input) =>
      idempotent(
        options.clientRequests,
        input as DeactivateJiraProjectIntegrationInput & { clientRequestId: string },
        "jira.deactivate-project-integration",
        () => jira.deactivate(input as DeactivateJiraProjectIntegrationInput),
      ),
    );

    register(IPC_CHANNELS.attachJiraIssue, (input) =>
      idempotent(
        options.clientRequests,
        input as AttachJiraIssueInput & { clientRequestId: string },
        "jira.attach-issue",
        () => jira.attachIssue(input as AttachJiraIssueInput),
      ),
    );
  }

  return () => {
    linkPreview.dispose();
    for (const controller of latestGitStatus.values()) controller.abort();
    for (const controller of latestGitDiff.values()) controller.abort();
    latestGitStatus.clear();
    latestGitDiff.clear();
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}

async function runLatestGitRequest<TResult>(
  controllers: Map<number, AbortController>,
  senderId: number,
  action: (signal: AbortSignal) => Promise<TResult>,
): Promise<TResult> {
  controllers.get(senderId)?.abort();
  const controller = new AbortController();
  controllers.set(senderId, controller);
  try {
    return await action(controller.signal);
  } finally {
    if (controllers.get(senderId) === controller) controllers.delete(senderId);
  }
}

async function idempotent<
  TInput extends { clientRequestId: string },
  TResult,
>(
  repository: ClientRequestRepository,
  input: TInput,
  operation: string,
  action: () => TResult | Promise<TResult>,
): Promise<TResult> {
  const reservation = repository.reserve({
    clientRequestId: input.clientRequestId,
    operation,
  });
  if (!reservation.acquired) {
    if (reservation.existing.state === "pending") {
      throw new Error("Diese Aktion wird bereits ausgeführt.");
    }
    return reservation.existing.result as TResult;
  }

  try {
    const result = await action();
    repository.save({
      clientRequestId: input.clientRequestId,
      operation,
      result: JsonValueSchema.parse(result),
    });
    return result;
  } catch (error) {
    repository.removePending(input.clientRequestId, operation);
    throw error;
  }
}

async function stageFiles(
  attachments: AttachmentService,
  paths: string[],
  sessionId: string | null,
) {
  if (paths.length > 4) {
    throw new Error("Pro Nachricht sind maximal vier Bilder erlaubt.");
  }
  const staged: Awaited<ReturnType<AttachmentService["stageFile"]>>[] = [];
  try {
    for (const filePath of paths) {
      staged.push(await attachments.stageFile({ filePath, sessionId }));
    }
    return staged;
  } catch (error) {
    await Promise.allSettled(staged.map((attachment) => attachments.remove(attachment.id)));
    throw error;
  }
}
