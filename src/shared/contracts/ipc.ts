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
  AddContextFilesInputSchema,
  AddContextLinkInputSchema,
  ClearLinkPreviewStorageInputSchema,
  ContextAttachmentBytesInputSchema,
  ContextAttachmentListSchema,
  ContextAttachmentSubscriptionResultSchema,
  LinkPreviewViewStateSchema,
  ListContextAttachmentsInputSchema,
  OpenContextAttachmentInputSchema,
  OpenLinkPreviewInputSchema,
  RefreshLinkPreviewInputSchema,
  RemoveContextAttachmentInputSchema,
  SetContextInclusionInputSchema,
  SetLinkPreviewBoundsInputSchema,
  UnsubscribeContextAttachmentsInputSchema,
  UpdateContextAttachmentInputSchema,
  type AddContextFilesInput,
  type AddContextLinkInput,
  type ClearLinkPreviewStorageInput,
  type ContextAttachmentBytesInput,
  type ContextAttachmentList,
  type ContextTarget,
  type LinkPreviewViewState,
  type ListContextAttachmentsInput,
  type OpenContextAttachmentInput,
  type OpenLinkPreviewInput,
  type RefreshLinkPreviewInput,
  type RemoveContextAttachmentInput,
  type SetContextInclusionInput,
  type SetLinkPreviewBoundsInput,
  type UpdateContextAttachmentInput,
} from "./context-attachments";
import {
  EntityIdSchema,
  FileSystemPathSchema,
  VoidResultSchema,
  type VoidResult,
} from "./common";
import {
  StreamEnvelopeBatchSchema,
  UsageSnapshotSchema,
  type StreamEnvelope,
  type UsageSnapshot,
} from "./events";
import {
  GetGitFileDiffInputSchema,
  GetGitProjectStatusInputSchema,
  GitFileDiffSchema,
  GitProjectStatusSchema,
  GitRepositoryListSchema,
  GitStatusSubscriptionResultSchema,
  ListGitProjectRepositoriesInputSchema,
  SubscribeGitProjectStatusInputSchema,
  UnsubscribeGitProjectStatusInputSchema,
  type GetGitFileDiffInput,
  type GetGitProjectStatusInput,
  type GitFileDiff,
  type GitProjectStatus,
  type GitRepositorySummary,
  type ListGitProjectRepositoriesInput,
  type SubscribeGitProjectStatusInput,
} from "./git";
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
  ProjectFileSearchResultSchema,
  SearchProjectFilesInputSchema,
  type ProjectFileSearchResult,
  type SearchProjectFilesInput,
} from "./project-files";
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
    git: z
      .object({
        available: z.boolean(),
        binaryPath: FileSystemPathSchema.nullable(),
        version: z.string().trim().min(1).max(100).nullable(),
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
    /**
     * Authoritative usage state for this session. It is delivered separately
     * from the replay so the display does not depend on the last usage event
     * still being inside the replay window.
     */
    usageSnapshot: UsageSnapshotSchema.nullable().default(null),
  })
  .strict();

export const IPC_CHANNELS = {
  getCapabilities: "app:get-capabilities",
  listProjects: "projects:list",
  getProject: "projects:get",
  reauthorizeProjectRoot: "projects:reauthorize-root",
  getProjectApprovalPolicy: "projects:get-approval-policy",
  searchProjectFiles: "project-files:search",
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
  chooseGitBinary: "settings:choose-git-binary",
  pickImages: "attachments:pick-images",
  stageDroppedPaths: "attachments:stage-dropped-paths",
  stageClipboardImage: "attachments:stage-clipboard-image",
  getAttachmentPreview: "attachments:get-preview",
  removeAttachment: "attachments:remove",
  listContextAttachments: "context-attachments:list",
  addContextFiles: "context-attachments:add-files",
  addContextLink: "context-attachments:add-link",
  updateContextAttachment: "context-attachments:update",
  setContextInclusion: "context-attachments:set-inclusion",
  removeContextAttachment: "context-attachments:remove",
  refreshLinkPreview: "context-attachments:refresh-link-preview",
  getContextAttachmentBytes: "context-attachments:get-bytes",
  subscribeContextAttachments: "context-attachments:subscribe",
  unsubscribeContextAttachments: "context-attachments:unsubscribe",
  contextAttachmentsChanged: "context-attachments:changed",
  openContextAttachment: "context-attachments:open-file",
  openLinkPreviewView: "link-preview:open",
  setLinkPreviewBounds: "link-preview:set-bounds",
  closeLinkPreviewView: "link-preview:close",
  clearLinkPreviewStorage: "link-preview:clear-storage",
  subscribeSessionEvents: "events:subscribe-session",
  unsubscribeSessionEvents: "events:unsubscribe-session",
  sessionEventBatch: "events:session-batch",
  listGitProjectRepositories: "git:list-project-repositories",
  getGitProjectStatus: "git:get-project-status",
  getGitFileDiff: "git:get-file-diff",
  subscribeGitProjectStatus: "git:subscribe-project-status",
  unsubscribeGitProjectStatus: "git:unsubscribe-project-status",
  gitProjectStatusChanged: "git:project-status-changed",
  openExternalHttpsUrl: "external:open-https-url",
} as const;

export const IpcRequestSchemas = {
  [IPC_CHANNELS.getCapabilities]: EmptyInputSchema,
  [IPC_CHANNELS.listProjects]: ListProjectsInputSchema,
  [IPC_CHANNELS.getProject]: GetProjectInputSchema,
  [IPC_CHANNELS.reauthorizeProjectRoot]: ReauthorizeProjectRootInputSchema,
  [IPC_CHANNELS.getProjectApprovalPolicy]: GetProjectApprovalPolicyInputSchema,
  [IPC_CHANNELS.searchProjectFiles]: SearchProjectFilesInputSchema,
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
  [IPC_CHANNELS.chooseGitBinary]: EmptyInputSchema,
  [IPC_CHANNELS.pickImages]: PickImagesInputSchema,
  [IPC_CHANNELS.stageDroppedPaths]: StageDroppedPathInputSchema,
  [IPC_CHANNELS.stageClipboardImage]: ClipboardImageInputSchema,
  [IPC_CHANNELS.getAttachmentPreview]: AttachmentPreviewInputSchema,
  [IPC_CHANNELS.removeAttachment]: RemoveAttachmentInputSchema,
  [IPC_CHANNELS.listContextAttachments]: ListContextAttachmentsInputSchema,
  [IPC_CHANNELS.addContextFiles]: AddContextFilesInputSchema,
  [IPC_CHANNELS.addContextLink]: AddContextLinkInputSchema,
  [IPC_CHANNELS.updateContextAttachment]: UpdateContextAttachmentInputSchema,
  [IPC_CHANNELS.setContextInclusion]: SetContextInclusionInputSchema,
  [IPC_CHANNELS.removeContextAttachment]: RemoveContextAttachmentInputSchema,
  [IPC_CHANNELS.refreshLinkPreview]: RefreshLinkPreviewInputSchema,
  [IPC_CHANNELS.getContextAttachmentBytes]: ContextAttachmentBytesInputSchema,
  [IPC_CHANNELS.subscribeContextAttachments]: ListContextAttachmentsInputSchema,
  [IPC_CHANNELS.unsubscribeContextAttachments]: UnsubscribeContextAttachmentsInputSchema,
  [IPC_CHANNELS.openContextAttachment]: OpenContextAttachmentInputSchema,
  [IPC_CHANNELS.openLinkPreviewView]: OpenLinkPreviewInputSchema,
  [IPC_CHANNELS.setLinkPreviewBounds]: SetLinkPreviewBoundsInputSchema,
  [IPC_CHANNELS.closeLinkPreviewView]: EmptyInputSchema,
  [IPC_CHANNELS.clearLinkPreviewStorage]: ClearLinkPreviewStorageInputSchema,
  [IPC_CHANNELS.subscribeSessionEvents]: SubscribeSessionEventsInputSchema,
  [IPC_CHANNELS.unsubscribeSessionEvents]: UnsubscribeSessionEventsInputSchema,
  [IPC_CHANNELS.listGitProjectRepositories]: ListGitProjectRepositoriesInputSchema,
  [IPC_CHANNELS.getGitProjectStatus]: GetGitProjectStatusInputSchema,
  [IPC_CHANNELS.getGitFileDiff]: GetGitFileDiffInputSchema,
  [IPC_CHANNELS.subscribeGitProjectStatus]: SubscribeGitProjectStatusInputSchema,
  [IPC_CHANNELS.unsubscribeGitProjectStatus]: UnsubscribeGitProjectStatusInputSchema,
  [IPC_CHANNELS.openExternalHttpsUrl]: OpenExternalHttpsUrlInputSchema,
} as const;

export const IpcResponseSchemas = {
  [IPC_CHANNELS.getCapabilities]: AppCapabilitiesSchema,
  [IPC_CHANNELS.listProjects]: z.array(ProjectWithRootsSchema),
  [IPC_CHANNELS.getProject]: ProjectWithRootsSchema,
  [IPC_CHANNELS.reauthorizeProjectRoot]: ProjectRootReauthorizationResultSchema,
  [IPC_CHANNELS.getProjectApprovalPolicy]: ProjectApprovalPolicySchema,
  [IPC_CHANNELS.searchProjectFiles]: ProjectFileSearchResultSchema,
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
  [IPC_CHANNELS.chooseGitBinary]: AppCapabilitiesSchema,
  [IPC_CHANNELS.pickImages]: z.array(AttachmentSchema).max(4),
  [IPC_CHANNELS.stageDroppedPaths]: z.array(AttachmentSchema).max(4),
  [IPC_CHANNELS.stageClipboardImage]: AttachmentSchema,
  [IPC_CHANNELS.getAttachmentPreview]: z.instanceof(Uint8Array),
  [IPC_CHANNELS.removeAttachment]: VoidResultSchema,
  [IPC_CHANNELS.listContextAttachments]: ContextAttachmentListSchema,
  [IPC_CHANNELS.addContextFiles]: ContextAttachmentListSchema,
  [IPC_CHANNELS.addContextLink]: ContextAttachmentListSchema,
  [IPC_CHANNELS.updateContextAttachment]: ContextAttachmentListSchema,
  [IPC_CHANNELS.setContextInclusion]: ContextAttachmentListSchema,
  [IPC_CHANNELS.removeContextAttachment]: ContextAttachmentListSchema,
  [IPC_CHANNELS.refreshLinkPreview]: ContextAttachmentListSchema,
  [IPC_CHANNELS.getContextAttachmentBytes]: z.instanceof(Uint8Array),
  [IPC_CHANNELS.subscribeContextAttachments]: ContextAttachmentSubscriptionResultSchema,
  [IPC_CHANNELS.unsubscribeContextAttachments]: VoidResultSchema,
  [IPC_CHANNELS.openContextAttachment]: VoidResultSchema,
  [IPC_CHANNELS.openLinkPreviewView]: LinkPreviewViewStateSchema,
  [IPC_CHANNELS.setLinkPreviewBounds]: VoidResultSchema,
  [IPC_CHANNELS.closeLinkPreviewView]: VoidResultSchema,
  [IPC_CHANNELS.clearLinkPreviewStorage]: VoidResultSchema,
  [IPC_CHANNELS.subscribeSessionEvents]: EventSubscriptionResultSchema,
  [IPC_CHANNELS.unsubscribeSessionEvents]: VoidResultSchema,
  [IPC_CHANNELS.listGitProjectRepositories]: GitRepositoryListSchema,
  [IPC_CHANNELS.getGitProjectStatus]: GitProjectStatusSchema,
  [IPC_CHANNELS.getGitFileDiff]: GitFileDiffSchema,
  [IPC_CHANNELS.subscribeGitProjectStatus]: GitStatusSubscriptionResultSchema,
  [IPC_CHANNELS.unsubscribeGitProjectStatus]: VoidResultSchema,
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
  projectFiles: {
    search(input: SearchProjectFilesInput): Promise<ProjectFileSearchResult>;
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
    chooseGitBinary(): Promise<AppCapabilities>;
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
  contextAttachments: {
    list(input: ListContextAttachmentsInput): Promise<ContextAttachmentList>;
    addFiles(input: AddContextFilesInput): Promise<ContextAttachmentList>;
    addDroppedFiles(files: File[], target: ContextTarget): Promise<ContextAttachmentList>;
    addLink(input: AddContextLinkInput): Promise<ContextAttachmentList>;
    update(input: UpdateContextAttachmentInput): Promise<ContextAttachmentList>;
    setInclusion(input: SetContextInclusionInput): Promise<ContextAttachmentList>;
    remove(input: RemoveContextAttachmentInput): Promise<ContextAttachmentList>;
    refreshLinkPreview(input: RefreshLinkPreviewInput): Promise<ContextAttachmentList>;
    getBytes(input: ContextAttachmentBytesInput): Promise<Uint8Array>;
    openFile(input: OpenContextAttachmentInput): Promise<VoidResult>;
    subscribe(
      input: ListContextAttachmentsInput,
      callback: (list: ContextAttachmentList) => void,
    ): Promise<() => void>;
  };
  linkPreview: {
    open(input: OpenLinkPreviewInput): Promise<LinkPreviewViewState>;
    setBounds(input: SetLinkPreviewBoundsInput): Promise<VoidResult>;
    close(): Promise<VoidResult>;
    clearStorage(input: ClearLinkPreviewStorageInput): Promise<VoidResult>;
  };
  git: {
    listProjectRepositories(
      input: ListGitProjectRepositoriesInput,
    ): Promise<{
      projectId: string;
      rootRevision: number;
      repositories: GitRepositorySummary[];
    }>;
    getProjectStatus(input: GetGitProjectStatusInput): Promise<GitProjectStatus>;
    getFileDiff(input: GetGitFileDiffInput): Promise<GitFileDiff>;
    subscribeProjectStatus(
      input: SubscribeGitProjectStatusInput,
      callback: (status: GitProjectStatus) => void,
    ): Promise<() => void>;
  };
  subscribeSessionEvents(
    input: SubscribeSessionEventsInput,
    callback: (events: StreamEnvelope[]) => void,
    onUsageSnapshot?: (snapshot: UsageSnapshot | null) => void,
  ): Promise<() => void>;
  openExternalHttpsUrl(url: string): Promise<VoidResult>;
}
