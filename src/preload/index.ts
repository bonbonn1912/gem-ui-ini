import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  EventSubscriptionResultSchema,
  GitStatusPushSchema,
  GitStatusSubscriptionResultSchema,
  IPC_CHANNELS,
  StreamEnvelopeBatchSchema,
  type GemUiDesktopApi,
  type GitProjectStatus,
  type StreamEnvelope,
  type UsageSnapshot,
} from "../shared/contracts";

type EventBatch = {
  subscriptionId: string;
  events: StreamEnvelope[];
};

type EventCallback = (events: StreamEnvelope[]) => void;

const callbacks = new Map<string, EventCallback>();
const pendingBatches = new Map<string, StreamEnvelope[][]>();
const gitCallbacks = new Map<string, (status: GitProjectStatus) => void>();
const pendingGitStatuses = new Map<string, GitProjectStatus[]>();

ipcRenderer.on(IPC_CHANNELS.sessionEventBatch, (_event, payload: unknown) => {
  const parsed = parseEventBatch(payload);
  if (!parsed) return;
  const callback = callbacks.get(parsed.subscriptionId);
  if (callback) {
    callback(parsed.events);
    return;
  }

  const queued = pendingBatches.get(parsed.subscriptionId) ?? [];
  if (queued.length < 50) queued.push(parsed.events);
  pendingBatches.set(parsed.subscriptionId, queued);
});

ipcRenderer.on(
  IPC_CHANNELS.gitProjectStatusChanged,
  (_event, payload: unknown) => {
    const parsed = GitStatusPushSchema.safeParse(payload);
    if (!parsed.success) return;
    const callback = gitCallbacks.get(parsed.data.subscriptionId);
    if (callback) {
      callback(parsed.data.status);
      return;
    }
    const queued = pendingGitStatuses.get(parsed.data.subscriptionId) ?? [];
    if (queued.length < 10) queued.push(parsed.data.status);
    pendingGitStatuses.set(parsed.data.subscriptionId, queued);
  },
);

const desktopApi: GemUiDesktopApi = {
  getCapabilities: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getCapabilities, {}),

  settings: {
    chooseGeminiBinary: () =>
      ipcRenderer.invoke(IPC_CHANNELS.chooseGeminiBinary, {}),
    chooseGitBinary: () =>
      ipcRenderer.invoke(IPC_CHANNELS.chooseGitBinary, {}),
  },

  projects: {
    list: (input = {}) => ipcRenderer.invoke(IPC_CHANNELS.listProjects, input),
    get: (input) => ipcRenderer.invoke(IPC_CHANNELS.getProject, input),
    reauthorizeRoot: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.reauthorizeProjectRoot, input),
    getApprovalPolicy: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.getProjectApprovalPolicy, input),
    pickFolders: () =>
      ipcRenderer.invoke(IPC_CHANNELS.pickProjectFolders, {
        allowMultiple: true,
      }),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.createProject, input),
    rename: (input) => ipcRenderer.invoke(IPC_CHANNELS.renameProject, input),
    setArchived: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.archiveProject, input),
    setAdditionalRoots: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.setProjectRoots, input),
    setApprovalPolicy: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.setProjectApprovalPolicy, input),
    delete: (input) => ipcRenderer.invoke(IPC_CHANNELS.deleteProject, input),
  },

  sessions: {
    list: (input) => ipcRenderer.invoke(IPC_CHANNELS.listSessions, input),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.createSession, input),
    update: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateSession, input),
    delete: (input) => ipcRenderer.invoke(IPC_CHANNELS.deleteSession, input),
    sendPrompt: (input) => ipcRenderer.invoke(IPC_CHANNELS.sendPrompt, input),
    cancel: (input) => ipcRenderer.invoke(IPC_CHANNELS.cancelTurn, input),
    respondToPermission: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.respondToPermission, input),
    setMode: (input) => ipcRenderer.invoke(IPC_CHANNELS.setSessionMode, input),
    setModel: (input) => ipcRenderer.invoke(IPC_CHANNELS.setSessionModel, input),
  },

  attachments: {
    pickImages: (input) => ipcRenderer.invoke(IPC_CHANNELS.pickImages, input),
    stageDroppedFiles: (files, sessionId = null) => {
      const paths = files
        .map((file) => webUtils.getPathForFile(file))
        .filter((filePath) => filePath.length > 0);
      return ipcRenderer.invoke(IPC_CHANNELS.stageDroppedPaths, {
        clientRequestId: globalThis.crypto.randomUUID(),
        sessionId,
        paths,
      });
    },
    stageClipboardImage: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.stageClipboardImage, input),
    getPreviewBytes: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.getAttachmentPreview, input),
    remove: (input) => ipcRenderer.invoke(IPC_CHANNELS.removeAttachment, input),
  },

  git: {
    listProjectRepositories: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.listGitProjectRepositories, input),
    getProjectStatus: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.getGitProjectStatus, input),
    getFileDiff: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.getGitFileDiff, input),
    subscribeProjectStatus: async (input, callback) => {
      const result = GitStatusSubscriptionResultSchema.parse(
        await ipcRenderer.invoke(IPC_CHANNELS.subscribeGitProjectStatus, input),
      );
      gitCallbacks.set(result.subscriptionId, callback);
      callback(result.status);
      const queued = pendingGitStatuses.get(result.subscriptionId) ?? [];
      pendingGitStatuses.delete(result.subscriptionId);
      for (const status of queued) callback(status);
      return () => {
        gitCallbacks.delete(result.subscriptionId);
        pendingGitStatuses.delete(result.subscriptionId);
        void ipcRenderer.invoke(IPC_CHANNELS.unsubscribeGitProjectStatus, {
          subscriptionId: result.subscriptionId,
        });
      };
    },
  },

  subscribeSessionEvents: async (
    input: unknown,
    callback: EventCallback,
    onUsageSnapshot?: (snapshot: UsageSnapshot | null) => void,
  ): Promise<() => void> => {
    const result = EventSubscriptionResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.subscribeSessionEvents, input),
    );

    callbacks.set(result.subscriptionId, callback);
    // The snapshot is applied before the replay so a usage event inside the
    // replay window still wins, and a session outside it is not left empty.
    onUsageSnapshot?.(result.usageSnapshot);
    if (result.replay.length > 0) callback(result.replay);
    const queued = pendingBatches.get(result.subscriptionId) ?? [];
    pendingBatches.delete(result.subscriptionId);
    for (const events of queued) callback(events);

    return () => {
      callbacks.delete(result.subscriptionId);
      pendingBatches.delete(result.subscriptionId);
      void ipcRenderer.invoke(IPC_CHANNELS.unsubscribeSessionEvents, {
        subscriptionId: result.subscriptionId,
      });
    };
  },

  openExternalHttpsUrl: (url) =>
    ipcRenderer.invoke(IPC_CHANNELS.openExternalHttpsUrl, { url }),
};

Object.freeze(desktopApi.projects);
Object.freeze(desktopApi.sessions);
Object.freeze(desktopApi.attachments);
Object.freeze(desktopApi.git);
Object.freeze(desktopApi.settings);
contextBridge.exposeInMainWorld("gemUi", Object.freeze(desktopApi));

function parseEventBatch(value: unknown): EventBatch | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<EventBatch>;
  if (typeof candidate.subscriptionId !== "string") return null;
  const events = StreamEnvelopeBatchSchema.safeParse(candidate.events);
  if (!events.success) return null;
  return { subscriptionId: candidate.subscriptionId, events: events.data };
}
