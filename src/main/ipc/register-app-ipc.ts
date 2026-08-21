import { dialog, type BrowserWindow } from "electron";
import path from "node:path";
import {
  IPC_CHANNELS,
  JsonValueSchema,
  type ArchiveProjectInput,
  type AddContextFilesInput,
  type AddContextLinkInput,
  type AttachmentPreviewInput,
  type CancelTurnInput,
  type ClipboardImageInput,
  type CreateProjectInput,
  type CreateSessionInput,
  type DeleteProjectInput,
  type DeleteSessionInput,
  type ContextAttachmentBytesInput,
  type GetProjectInput,
  type GetProjectApprovalPolicyInput,
  type GetGitFileDiffInput,
  type GetGitProjectStatusInput,
  type ListProjectsInput,
  type ListSessionsInput,
  type ListContextAttachmentsInput,
  type OpenContextAttachmentInput,
  type OpenLinkPreviewInput,
  type PermissionResponse,
  type PickImagesInput,
  type RemoveAttachmentInput,
  type RemoveContextAttachmentInput,
  type RefreshLinkPreviewInput,
  type ReauthorizeProjectRootInput,
  type RenameProjectInput,
  type SendPromptInput,
  type SetProjectRootsInput,
  type SetProjectApprovalPolicyInput,
  type SetSessionModeInput,
  type SetSessionModelInput,
  type SetContextInclusionInput,
  type SetLinkPreviewBoundsInput,
  type StageDroppedPathInput,
  type SubscribeSessionEventsInput,
  type SubscribeGitProjectStatusInput,
  type UpdateSessionInput,
  type UpdateContextAttachmentInput,
} from "../../shared/contracts";
import type { AppController } from "../app-controller";
import type { AttachmentService } from "../attachments/attachment-service";
import type {
  ContextAttachmentService,
  ContextAttachmentSubscriptionHub,
} from "../context-attachments";
import type { GeminiCapabilityService } from "../capability-service";
import type { GitService, GitStatusSubscriptionHub } from "../git";
import type { ProjectService } from "../projects";
import { LinkPreviewViewHost, type LinkMetadataFetcher } from "../links";
import type { ClientRequestRepository } from "../storage";
import { openExternalHttps, openStoredFile } from "../security/main-window";
import type { SessionEventHub } from "./event-hub";
import { registerValidatedIpcHandler } from "./register-handler";

export type RegisterAppIpcOptions = {
  mainWindow: BrowserWindow;
  projects: ProjectService;
  controller: AppController;
  capabilities: GeminiCapabilityService;
  attachments: AttachmentService;
  contextAttachments: ContextAttachmentService;
  contextAttachmentHub: ContextAttachmentSubscriptionHub;
  linkMetadataFetcher: LinkMetadataFetcher;
  clientRequests: ClientRequestRepository;
  eventHub: SessionEventHub;
  git: GitService;
  gitStatusHub: GitStatusSubscriptionHub;
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
  register(IPC_CHANNELS.openLinkPreviewView, (input) =>
    linkPreview.open((input as OpenLinkPreviewInput).attachmentId),
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

  register(IPC_CHANNELS.openExternalHttpsUrl, async (input) => {
    await openExternalHttps((input as { url: string }).url);
    return { ok: true };
  });

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
