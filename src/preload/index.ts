import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  AppUpdateDownloadProgressSchema,
  EventSubscriptionResultSchema,
  ContextAttachmentPushSchema,
  ContextAttachmentSubscriptionResultSchema,
  GitLabReviewStatePushSchema,
  GitLabReviewStateSubscriptionResultSchema,
  GitStatusPushSchema,
  GitStatusSubscriptionResultSchema,
  IPC_CHANNELS,
  StreamEnvelopeBatchSchema,
  TodoPushSchema,
  TodoSubscriptionResultSchema,
  type GemUiDesktopApi,
  type AppUpdateDownloadProgress,
  type ContextAttachmentList,
  type TodoList,
  type GitLabReviewState,
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
const gitlabCallbacks = new Map<string, (state: GitLabReviewState) => void>();
const pendingGitlabStates = new Map<string, GitLabReviewState[]>();
const contextAttachmentCallbacks = new Map<string, (list: ContextAttachmentList) => void>();
const pendingContextAttachmentLists = new Map<string, ContextAttachmentList[]>();
const todoCallbacks = new Map<string, (list: TodoList) => void>();
const pendingTodoLists = new Map<string, TodoList[]>();

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

ipcRenderer.on(
  IPC_CHANNELS.gitlabReviewStateChanged,
  (_event, payload: unknown) => {
    const parsed = GitLabReviewStatePushSchema.safeParse(payload);
    if (!parsed.success) return;
    const callback = gitlabCallbacks.get(parsed.data.subscriptionId);
    if (callback) {
      callback(parsed.data.state);
      return;
    }
    const queued = pendingGitlabStates.get(parsed.data.subscriptionId) ?? [];
    if (queued.length < 10) queued.push(parsed.data.state);
    pendingGitlabStates.set(parsed.data.subscriptionId, queued);
  },
);

ipcRenderer.on(
  IPC_CHANNELS.contextAttachmentsChanged,
  (_event, payload: unknown) => {
    const parsed = ContextAttachmentPushSchema.safeParse(payload);
    if (!parsed.success) return;
    const callback = contextAttachmentCallbacks.get(parsed.data.subscriptionId);
    if (callback) {
      callback(parsed.data.list);
      return;
    }
    const queued = pendingContextAttachmentLists.get(parsed.data.subscriptionId) ?? [];
    if (queued.length < 10) queued.push(parsed.data.list);
    pendingContextAttachmentLists.set(parsed.data.subscriptionId, queued);
  },
);

ipcRenderer.on(IPC_CHANNELS.todosChanged, (_event, payload: unknown) => {
  const parsed = TodoPushSchema.safeParse(payload);
  if (!parsed.success) return;
  const callback = todoCallbacks.get(parsed.data.subscriptionId);
  if (callback) {
    callback(parsed.data.list);
    return;
  }
  const queued = pendingTodoLists.get(parsed.data.subscriptionId) ?? [];
  if (queued.length < 10) queued.push(parsed.data.list);
  pendingTodoLists.set(parsed.data.subscriptionId, queued);
});

const updateProgressCallbacks = new Set<(progress: AppUpdateDownloadProgress) => void>();

ipcRenderer.on(IPC_CHANNELS.appUpdateDownloadProgress, (_event, payload: unknown) => {
  const parsed = AppUpdateDownloadProgressSchema.safeParse(payload);
  if (!parsed.success) return;
  for (const cb of updateProgressCallbacks) {
    cb(parsed.data);
  }
});

const desktopApi: GemUiDesktopApi = {
  getCapabilities: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getCapabilities, {}),

  app: {
    checkForUpdates: () =>
      ipcRenderer.invoke(IPC_CHANNELS.checkForUpdates, {}),
    downloadUpdate: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.downloadUpdate, input),
    installUpdate: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.installUpdate, input),
    onDownloadProgress: (callback) => {
      updateProgressCallbacks.add(callback);
      return () => {
        updateProgressCallbacks.delete(callback);
      };
    },
  },

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
      ipcRenderer.invoke(IPC_CHANNELS.pickProjectFolders, {}),
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

  projectFiles: {
    search: (input) => ipcRenderer.invoke(IPC_CHANNELS.searchProjectFiles, input),
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
    getReconnectState: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.getSessionReconnectState, input),
  },

  attachments: {
    pickImages: (input) => ipcRenderer.invoke(IPC_CHANNELS.pickImages, input),
    stageDroppedFiles: async (files, sessionId = null) => {
      const paths = files
        .map((file) => webUtils.getPathForFile(file))
        .filter((filePath): filePath is string => Boolean(filePath));
      if (paths.length === 0) return [];
      return ipcRenderer.invoke(IPC_CHANNELS.stageDroppedPaths, {
        paths,
        sessionId,
      });
    },
    stageClipboardImage: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.stageClipboardImage, input),
    getPreviewBytes: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.getAttachmentPreview, input),
    remove: (input) => ipcRenderer.invoke(IPC_CHANNELS.removeAttachment, input),
  },

  contextAttachments: {
    list: (input) => ipcRenderer.invoke(IPC_CHANNELS.listContextAttachments, input),
    addFiles: (input) => ipcRenderer.invoke(IPC_CHANNELS.addContextFiles, input),
    addDroppedFiles: async (files, target, options) => {
      const paths = files
        .map((file) => webUtils.getPathForFile(file))
        .filter((filePath): filePath is string => Boolean(filePath));
      if (paths.length === 0) {
        return ipcRenderer.invoke(IPC_CHANNELS.listContextAttachments, {
          projectId: target.projectId,
          sessionId: target.scope === "session" ? target.sessionId : null,
        });
      }
      return ipcRenderer.invoke(IPC_CHANNELS.addContextFiles, {
        ...target,
        clientRequestId: createClientRequestId(),
        paths,
        origin: options?.origin ?? "manual",
      });
    },
    addLink: (input) => ipcRenderer.invoke(IPC_CHANNELS.addContextLink, input),
    update: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateContextAttachment, input),
    setInclusion: (input) => ipcRenderer.invoke(IPC_CHANNELS.setContextInclusion, input),
    remove: (input) => ipcRenderer.invoke(IPC_CHANNELS.removeContextAttachment, input),
    refreshLinkPreview: (input) => ipcRenderer.invoke(IPC_CHANNELS.refreshLinkPreview, input),
    getBytes: (input) => ipcRenderer.invoke(IPC_CHANNELS.getContextAttachmentBytes, input),
    openFile: (input) => ipcRenderer.invoke(IPC_CHANNELS.openContextAttachment, input),
    subscribe: async (input, callback) => {
      const result = ContextAttachmentSubscriptionResultSchema.parse(
        await ipcRenderer.invoke(IPC_CHANNELS.subscribeContextAttachments, input),
      );
      contextAttachmentCallbacks.set(result.subscriptionId, callback);
      callback(result.list);
      const queued = pendingContextAttachmentLists.get(result.subscriptionId) ?? [];
      pendingContextAttachmentLists.delete(result.subscriptionId);
      for (const list of queued) callback(list);
      return () => {
        contextAttachmentCallbacks.delete(result.subscriptionId);
        pendingContextAttachmentLists.delete(result.subscriptionId);
        void ipcRenderer.invoke(IPC_CHANNELS.unsubscribeContextAttachments, {
          subscriptionId: result.subscriptionId,
        });
      };
    },
  },

  todos: {
    list: (input) => ipcRenderer.invoke(IPC_CHANNELS.listTodos, input),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.createTodo, input),
    update: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateTodo, input),
    reorder: (input) => ipcRenderer.invoke(IPC_CHANNELS.reorderTodos, input),
    delete: (input) => ipcRenderer.invoke(IPC_CHANNELS.deleteTodo, input),
    addFiles: (input) => ipcRenderer.invoke(IPC_CHANNELS.addTodoFiles, input),
    addDroppedFiles: async (files, target) => {
      const paths = files
        .map((file) => webUtils.getPathForFile(file))
        .filter((filePath): filePath is string => Boolean(filePath));
      // Dropping something Electron cannot resolve to a path must not open the
      // file dialog that an empty `paths` array triggers in the main process.
      if (paths.length === 0) {
        return ipcRenderer.invoke(IPC_CHANNELS.listTodos, { projectId: target.projectId });
      }
      return ipcRenderer.invoke(IPC_CHANNELS.addTodoFiles, {
        todoId: target.todoId,
        clientRequestId: createClientRequestId(),
        paths,
      });
    },
    addLink: (input) => ipcRenderer.invoke(IPC_CHANNELS.addTodoLink, input),
    attachAttachment: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.attachTodoAttachment, input),
    detachAttachment: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.detachTodoAttachment, input),
    prepareForSession: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.prepareTodoForSession, input),
    subscribe: async (input, callback) => {
      const result = TodoSubscriptionResultSchema.parse(
        await ipcRenderer.invoke(IPC_CHANNELS.subscribeTodos, input),
      );
      todoCallbacks.set(result.subscriptionId, callback);
      callback(result.list);
      const queued = pendingTodoLists.get(result.subscriptionId) ?? [];
      pendingTodoLists.delete(result.subscriptionId);
      for (const list of queued) callback(list);
      return () => {
        todoCallbacks.delete(result.subscriptionId);
        pendingTodoLists.delete(result.subscriptionId);
        void ipcRenderer.invoke(IPC_CHANNELS.unsubscribeTodos, {
          subscriptionId: result.subscriptionId,
        });
      };
    },
  },

  linkPreview: {
    open: (input) => ipcRenderer.invoke(IPC_CHANNELS.openLinkPreviewView, input),
    setBounds: (input) => ipcRenderer.invoke(IPC_CHANNELS.setLinkPreviewBounds, input),
    close: () => ipcRenderer.invoke(IPC_CHANNELS.closeLinkPreviewView, {}),
    clearStorage: (input) => ipcRenderer.invoke(IPC_CHANNELS.clearLinkPreviewStorage, input),
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

  agentExtensions: {
    listSkills: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.listGeminiSkills, input),
    listMcpServers: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.listMcpServers, input),
  },

  integrations: {
    listProject: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.listProjectIntegrations, input),
  },

  gitlab: {
    listRepositoryCandidates: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.listGitLabRepositoryCandidates, input),
    listConnections: () =>
      ipcRenderer.invoke(IPC_CHANNELS.listGitLabConnections, {}),
    testConnection: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.testGitLabConnection, input),
    saveConnection: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.saveGitLabConnection, input),
    replaceToken: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.replaceGitLabToken, input),
    removeConnection: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.removeGitLabConnection, input),
    enableBinding: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.enableGitLabBinding, input),
    disableBinding: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.disableGitLabBinding, input),
    listMergeRequests: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.listGitLabMergeRequests, input),
    selectMergeRequest: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.selectGitLabMergeRequest, input),
    connectMergeRequestUrl: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.connectGitLabMergeRequestUrl, input),
    getReviewState: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.getGitLabReviewState, input),
    subscribeReviewState: async (input, callback) => {
      const result = GitLabReviewStateSubscriptionResultSchema.parse(
        await ipcRenderer.invoke(IPC_CHANNELS.subscribeGitLabReviewState, input),
      );
      gitlabCallbacks.set(result.subscriptionId, callback);
      callback(result.initial);
      const queued = pendingGitlabStates.get(result.subscriptionId) ?? [];
      pendingGitlabStates.delete(result.subscriptionId);
      for (const state of queued) callback(state);
      return () => {
        gitlabCallbacks.delete(result.subscriptionId);
        pendingGitlabStates.delete(result.subscriptionId);
        void ipcRenderer.invoke(IPC_CHANNELS.unsubscribeGitLabReviewState, {
          subscriptionId: result.subscriptionId,
        });
      };
    },
    prepareReviewContext: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.prepareGitLabReviewContext, input),
    resolveDiscussion: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.resolveGitLabDiscussion, input),
    replyToDiscussion: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.replyToGitLabDiscussion, input),
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
Object.freeze(desktopApi.projectFiles);
Object.freeze(desktopApi.sessions);
Object.freeze(desktopApi.attachments);
Object.freeze(desktopApi.contextAttachments);
Object.freeze(desktopApi.todos);
Object.freeze(desktopApi.git);
Object.freeze(desktopApi.linkPreview);
Object.freeze(desktopApi.settings);
Object.freeze(desktopApi.agentExtensions);
Object.freeze(desktopApi.integrations);
Object.freeze(desktopApi.gitlab);
contextBridge.exposeInMainWorld("gemUi", Object.freeze(desktopApi));

function createClientRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseEventBatch(value: unknown): EventBatch | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<EventBatch>;
  if (typeof candidate.subscriptionId !== "string") return null;
  const events = StreamEnvelopeBatchSchema.safeParse(candidate.events);
  if (!events.success) return null;
  return { subscriptionId: candidate.subscriptionId, events: events.data };
}
