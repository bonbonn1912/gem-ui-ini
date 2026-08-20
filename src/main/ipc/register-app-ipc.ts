import { dialog, type BrowserWindow } from "electron";
import path from "node:path";
import {
  IPC_CHANNELS,
  JsonValueSchema,
  type ArchiveProjectInput,
  type AttachmentPreviewInput,
  type CancelTurnInput,
  type ClipboardImageInput,
  type CreateProjectInput,
  type CreateSessionInput,
  type DeleteProjectInput,
  type DeleteSessionInput,
  type GetProjectInput,
  type GetProjectApprovalPolicyInput,
  type ListProjectsInput,
  type ListSessionsInput,
  type PermissionResponse,
  type PickImagesInput,
  type RemoveAttachmentInput,
  type ReauthorizeProjectRootInput,
  type RenameProjectInput,
  type SendPromptInput,
  type SetProjectRootsInput,
  type SetProjectApprovalPolicyInput,
  type SetSessionModeInput,
  type SetSessionModelInput,
  type StageDroppedPathInput,
  type SubscribeSessionEventsInput,
  type UpdateSessionInput,
} from "../../shared/contracts";
import type { AppController } from "../app-controller";
import type { AttachmentService } from "../attachments/attachment-service";
import type { GeminiCapabilityService } from "../capability-service";
import type { ProjectService } from "../projects";
import type { ClientRequestRepository } from "../storage";
import { openExternalHttps } from "../security/main-window";
import type { SessionEventHub } from "./event-hub";
import { registerValidatedIpcHandler } from "./register-handler";

export type RegisterAppIpcOptions = {
  mainWindow: BrowserWindow;
  projects: ProjectService;
  controller: AppController;
  capabilities: GeminiCapabilityService;
  attachments: AttachmentService;
  clientRequests: ClientRequestRepository;
  eventHub: SessionEventHub;
};

export function registerAppIpc(options: RegisterAppIpcOptions): () => void {
  const cleanups: Array<() => void> = [];
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

  register(IPC_CHANNELS.openExternalHttpsUrl, async (input) => {
    await openExternalHttps((input as { url: string }).url);
    return { ok: true };
  });

  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
  };
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
