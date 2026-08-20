import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  EventSubscriptionResultSchema,
  IPC_CHANNELS,
  StreamEnvelopeBatchSchema,
  type GemUiDesktopApi,
  type StreamEnvelope,
} from "../shared/contracts";

type EventBatch = {
  subscriptionId: string;
  events: StreamEnvelope[];
};

type EventCallback = (events: StreamEnvelope[]) => void;

const callbacks = new Map<string, EventCallback>();
const pendingBatches = new Map<string, StreamEnvelope[][]>();

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

const desktopApi: GemUiDesktopApi = {
  getCapabilities: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getCapabilities, {}),

  settings: {
    chooseGeminiBinary: () =>
      ipcRenderer.invoke(IPC_CHANNELS.chooseGeminiBinary, {}),
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

  subscribeSessionEvents: async (
    input: unknown,
    callback: EventCallback,
  ): Promise<() => void> => {
    const result = EventSubscriptionResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.subscribeSessionEvents, input),
    );

    callbacks.set(result.subscriptionId, callback);
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
