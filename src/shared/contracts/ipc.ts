import { z } from "zod";

import {
  AttachmentPreviewInputSchema,
  AttachmentSchema,
  ClipboardImageInputSchema,
  PickImagesInputSchema,
  RemoveAttachmentInputSchema,
  StageDroppedPathInputSchema,
  type Attachment,
  type AttachmentPreviewInput,
  type ClipboardImageInput,
  type PickImagesInput,
  type RemoveAttachmentInput,
  type StageDroppedPathInput,
} from "./attachments";
import {
  EntityIdSchema,
  FileSystemPathSchema,
  VoidResultSchema,
  type VoidResult,
} from "./common";
import { StreamEnvelopeBatchSchema, type StreamEnvelope } from "./events";
import {
  ArchiveProjectInputSchema,
  CreateProjectInputSchema,
  DeleteProjectInputSchema,
  GetProjectInputSchema,
  GetProjectApprovalPolicyInputSchema,
  ListProjectsInputSchema,
  ProjectApprovalPolicySchema,
  ProjectRootCandidateSchema,
  ProjectRootReauthorizationResultSchema,
  ProjectWithRootsSchema,
  ReauthorizeProjectRootInputSchema,
  RenameProjectInputSchema,
  SetProjectRootsInputSchema,
  SetProjectApprovalPolicyInputSchema,
  type ArchiveProjectInput,
  type CreateProjectInput,
  type DeleteProjectInput,
  type GetProjectInput,
  type GetProjectApprovalPolicyInput,
  type ListProjectsInput,
  type ProjectRootCandidate,
  type ProjectWithRoots,
  type ProjectApprovalPolicy,
  type ProjectRootReauthorizationResult,
  type ReauthorizeProjectRootInput,
  type RenameProjectInput,
  type SetProjectRootsInput,
  type SetProjectApprovalPolicyInput,
} from "./projects";
import {
  AppSessionSchema,
  CancelTurnInputSchema,
  CreateSessionInputSchema,
  DeleteSessionInputSchema,
  ListSessionsInputSchema,
  PermissionResponseSchema,
  SendPromptInputSchema,
  SetSessionModeInputSchema,
  SetSessionModelInputSchema,
  UpdateSessionInputSchema,
  type AppSession,
  type CancelTurnInput,
  type CreateSessionInput,
  type DeleteSessionInput,
  type ListSessionsInput,
  type PermissionResponse,
  type SendPromptInput,
  type SetSessionModeInput,
  type SetSessionModelInput,
  type UpdateSessionInput,
} from "./sessions";

export const AppCapabilitiesSchema = z
  .object({
    appVersion: z.string().trim().min(1).max(100),
    platform: z.enum(["darwin", "linux", "win32"]),
    gemini: z
      .object({
        available: z.boolean(),
        binaryPath: FileSystemPathSchema.nullable(),
        version: z.string().trim().min(1).max(100).nullable(),
        acp: z.boolean(),
        sessionLoad: z.boolean(),
        images: z.boolean(),
        modes: z.boolean(),
        models: z.boolean(),
        maxAdditionalRoots: z.int().min(0).max(5),
      })
      .strict(),
  })
  .strict();

export const EmptyInputSchema = z.object({}).strict();

export const PickProjectFoldersInputSchema = z
  .object({
    allowMultiple: z.boolean().default(true),
  })
  .strict();

export const SubscribeSessionEventsInputSchema = z
  .object({
    sessionId: EntityIdSchema,
    afterSeq: z.int().nonnegative(),
  })
  .strict();

export const UnsubscribeSessionEventsInputSchema = z
  .object({
    subscriptionId: EntityIdSchema,
  })
  .strict();

export const OpenExternalHttpsUrlInputSchema = z
  .object({
    url: z.url().refine((url) => new URL(url).protocol === "https:", {
      message: "Only HTTPS URLs may be opened externally",
    }),
  })
  .strict();

export const SendPromptResultSchema = z
  .object({
    turnId: EntityIdSchema,
  })
  .strict();

export const EventSubscriptionResultSchema = z
  .object({
    subscriptionId: EntityIdSchema,
    replay: StreamEnvelopeBatchSchema,
  })
  .strict();

export const IPC_CHANNELS = {
  getCapabilities: "app:get-capabilities",
  listProjects: "projects:list",
  getProject: "projects:get",
  reauthorizeProjectRoot: "projects:reauthorize-root",
  getProjectApprovalPolicy: "projects:get-approval-policy",
  pickProjectFolders: "projects:pick-folders",
  createProject: "projects:create",
  renameProject: "projects:rename",
  archiveProject: "projects:set-archived",
  setProjectRoots: "projects:set-additional-roots",
  setProjectApprovalPolicy: "projects:set-approval-policy",
  deleteProject: "projects:delete",
  listSessions: "sessions:list",
  createSession: "sessions:create",
  updateSession: "sessions:update",
  deleteSession: "sessions:delete",
  sendPrompt: "sessions:send-prompt",
  cancelTurn: "sessions:cancel-turn",
  respondToPermission: "sessions:respond-to-permission",
  setSessionMode: "sessions:set-mode",
  setSessionModel: "sessions:set-model",
  chooseGeminiBinary: "settings:choose-gemini-binary",
  pickImages: "attachments:pick-images",
  stageDroppedPaths: "attachments:stage-dropped-paths",
  stageClipboardImage: "attachments:stage-clipboard-image",
  getAttachmentPreview: "attachments:get-preview",
  removeAttachment: "attachments:remove",
  subscribeSessionEvents: "events:subscribe-session",
  unsubscribeSessionEvents: "events:unsubscribe-session",
  sessionEventBatch: "events:session-batch",
  openExternalHttpsUrl: "external:open-https-url",
} as const;

export const IpcRequestSchemas = {
  [IPC_CHANNELS.getCapabilities]: EmptyInputSchema,
  [IPC_CHANNELS.listProjects]: ListProjectsInputSchema,
  [IPC_CHANNELS.getProject]: GetProjectInputSchema,
  [IPC_CHANNELS.reauthorizeProjectRoot]: ReauthorizeProjectRootInputSchema,
  [IPC_CHANNELS.getProjectApprovalPolicy]: GetProjectApprovalPolicyInputSchema,
  [IPC_CHANNELS.pickProjectFolders]: PickProjectFoldersInputSchema,
  [IPC_CHANNELS.createProject]: CreateProjectInputSchema,
  [IPC_CHANNELS.renameProject]: RenameProjectInputSchema,
  [IPC_CHANNELS.archiveProject]: ArchiveProjectInputSchema,
  [IPC_CHANNELS.setProjectRoots]: SetProjectRootsInputSchema,
  [IPC_CHANNELS.setProjectApprovalPolicy]: SetProjectApprovalPolicyInputSchema,
  [IPC_CHANNELS.deleteProject]: DeleteProjectInputSchema,
  [IPC_CHANNELS.listSessions]: ListSessionsInputSchema,
  [IPC_CHANNELS.createSession]: CreateSessionInputSchema,
  [IPC_CHANNELS.updateSession]: UpdateSessionInputSchema,
  [IPC_CHANNELS.deleteSession]: DeleteSessionInputSchema,
  [IPC_CHANNELS.sendPrompt]: SendPromptInputSchema,
  [IPC_CHANNELS.cancelTurn]: CancelTurnInputSchema,
  [IPC_CHANNELS.respondToPermission]: PermissionResponseSchema,
  [IPC_CHANNELS.setSessionMode]: SetSessionModeInputSchema,
  [IPC_CHANNELS.setSessionModel]: SetSessionModelInputSchema,
  [IPC_CHANNELS.chooseGeminiBinary]: EmptyInputSchema,
  [IPC_CHANNELS.pickImages]: PickImagesInputSchema,
  [IPC_CHANNELS.stageDroppedPaths]: StageDroppedPathInputSchema,
  [IPC_CHANNELS.stageClipboardImage]: ClipboardImageInputSchema,
  [IPC_CHANNELS.getAttachmentPreview]: AttachmentPreviewInputSchema,
  [IPC_CHANNELS.removeAttachment]: RemoveAttachmentInputSchema,
  [IPC_CHANNELS.subscribeSessionEvents]: SubscribeSessionEventsInputSchema,
  [IPC_CHANNELS.unsubscribeSessionEvents]: UnsubscribeSessionEventsInputSchema,
  [IPC_CHANNELS.openExternalHttpsUrl]: OpenExternalHttpsUrlInputSchema,
} as const;

export const IpcResponseSchemas = {
  [IPC_CHANNELS.getCapabilities]: AppCapabilitiesSchema,
  [IPC_CHANNELS.listProjects]: z.array(ProjectWithRootsSchema),
  [IPC_CHANNELS.getProject]: ProjectWithRootsSchema,
  [IPC_CHANNELS.reauthorizeProjectRoot]: ProjectRootReauthorizationResultSchema,
  [IPC_CHANNELS.getProjectApprovalPolicy]: ProjectApprovalPolicySchema,
  [IPC_CHANNELS.pickProjectFolders]: z.array(ProjectRootCandidateSchema).max(6),
  [IPC_CHANNELS.createProject]: ProjectWithRootsSchema,
  [IPC_CHANNELS.renameProject]: ProjectWithRootsSchema,
  [IPC_CHANNELS.archiveProject]: ProjectWithRootsSchema,
  [IPC_CHANNELS.setProjectRoots]: ProjectWithRootsSchema,
  [IPC_CHANNELS.setProjectApprovalPolicy]: ProjectApprovalPolicySchema,
  [IPC_CHANNELS.deleteProject]: VoidResultSchema,
  [IPC_CHANNELS.listSessions]: z.array(AppSessionSchema),
  [IPC_CHANNELS.createSession]: AppSessionSchema,
  [IPC_CHANNELS.updateSession]: AppSessionSchema,
  [IPC_CHANNELS.deleteSession]: VoidResultSchema,
  [IPC_CHANNELS.sendPrompt]: SendPromptResultSchema,
  [IPC_CHANNELS.cancelTurn]: VoidResultSchema,
  [IPC_CHANNELS.respondToPermission]: VoidResultSchema,
  [IPC_CHANNELS.setSessionMode]: AppSessionSchema,
  [IPC_CHANNELS.setSessionModel]: AppSessionSchema,
  [IPC_CHANNELS.chooseGeminiBinary]: AppCapabilitiesSchema,
  [IPC_CHANNELS.pickImages]: z.array(AttachmentSchema).max(4),
  [IPC_CHANNELS.stageDroppedPaths]: z.array(AttachmentSchema).max(4),
  [IPC_CHANNELS.stageClipboardImage]: AttachmentSchema,
  [IPC_CHANNELS.getAttachmentPreview]: z.instanceof(Uint8Array),
  [IPC_CHANNELS.removeAttachment]: VoidResultSchema,
  [IPC_CHANNELS.subscribeSessionEvents]: EventSubscriptionResultSchema,
  [IPC_CHANNELS.unsubscribeSessionEvents]: VoidResultSchema,
  [IPC_CHANNELS.openExternalHttpsUrl]: VoidResultSchema,
} as const;

export type IpcRequestChannel = keyof typeof IpcRequestSchemas;
export type IpcResponseChannel = keyof typeof IpcResponseSchemas;
export type AppCapabilities = z.infer<typeof AppCapabilitiesSchema>;
export type SubscribeSessionEventsInput = z.input<
  typeof SubscribeSessionEventsInputSchema
>;
export type OpenExternalHttpsUrlInput = z.input<
  typeof OpenExternalHttpsUrlInputSchema
>;

export interface GemUiDesktopApi {
  getCapabilities(): Promise<AppCapabilities>;
  projects: {
    list(input?: ListProjectsInput): Promise<ProjectWithRoots[]>;
    get(input: GetProjectInput): Promise<ProjectWithRoots>;
    reauthorizeRoot(
      input: ReauthorizeProjectRootInput,
    ): Promise<ProjectRootReauthorizationResult>;
    getApprovalPolicy(
      input: GetProjectApprovalPolicyInput,
    ): Promise<ProjectApprovalPolicy>;
    pickFolders(): Promise<ProjectRootCandidate[]>;
    create(input: CreateProjectInput): Promise<ProjectWithRoots>;
    rename(input: RenameProjectInput): Promise<ProjectWithRoots>;
    setArchived(input: ArchiveProjectInput): Promise<ProjectWithRoots>;
    setAdditionalRoots(input: SetProjectRootsInput): Promise<ProjectWithRoots>;
    setApprovalPolicy(
      input: SetProjectApprovalPolicyInput,
    ): Promise<ProjectApprovalPolicy>;
    delete(input: DeleteProjectInput): Promise<VoidResult>;
  };
  sessions: {
    list(input: ListSessionsInput): Promise<AppSession[]>;
    create(input: CreateSessionInput): Promise<AppSession>;
    update(input: UpdateSessionInput): Promise<AppSession>;
    delete(input: DeleteSessionInput): Promise<VoidResult>;
    sendPrompt(input: SendPromptInput): Promise<{ turnId: string }>;
    cancel(input: CancelTurnInput): Promise<VoidResult>;
    respondToPermission(input: PermissionResponse): Promise<VoidResult>;
    setMode(input: SetSessionModeInput): Promise<AppSession>;
    setModel(input: SetSessionModelInput): Promise<AppSession>;
  };
  settings: {
    chooseGeminiBinary(): Promise<AppCapabilities>;
  };
  attachments: {
    pickImages(input: PickImagesInput): Promise<Attachment[]>;
    stageDroppedFiles(
      files: File[],
      sessionId?: string | null,
    ): Promise<Attachment[]>;
    stageClipboardImage(input: ClipboardImageInput): Promise<Attachment>;
    getPreviewBytes(input: AttachmentPreviewInput): Promise<Uint8Array>;
    remove(input: RemoveAttachmentInput): Promise<VoidResult>;
  };
  subscribeSessionEvents(
    input: SubscribeSessionEventsInput,
    callback: (events: StreamEnvelope[]) => void,
  ): Promise<() => void>;
  openExternalHttpsUrl(url: string): Promise<VoidResult>;
}
