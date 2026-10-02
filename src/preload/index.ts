import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  AppUpdateDownloadProgressSchema,
  EventSubscriptionResultSchema,
  ReplaySessionEventsResultSchema,
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

type EventCallback = (events: StreamEnvelope[], metadata?: { replay: boolean; error?: string }) => void;

const callbacks = new Map<string, EventCallback>();
const pendingWatermarks = new Map<string, { seq: number; at: number }>();
let subscribing = 0;
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

  if (!subscribing) return;
  const now = Date.now();
  for (const [id, entry] of pendingWatermarks) if (now - entry.at > 30_000) pendingWatermarks.delete(id);
  const seq = Math.max(pendingWatermarks.get(parsed.subscriptionId)?.seq ?? 0, ...parsed.events.map((event) => event.seq));
  pendingWatermarks.set(parsed.subscriptionId, { seq, at: now });
  while (pendingWatermarks.size > 32) pendingWatermarks.delete(pendingWatermarks.keys().next().value!);
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
  getResourceProfile: () => ipcRenderer.invoke(IPC_CHANNELS.getResourceProfile, {}),
  setResourceProfile: (input) => ipcRenderer.invoke(IPC_CHANNELS.setResourceProfile, input),

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
    setStatsEnabled: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.setProjectStatsEnabled, input),
    setLiveTokensEnabled: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.setProjectLiveTokensEnabled, input),
    delete: (input) => ipcRenderer.invoke(IPC_CHANNELS.deleteProject, input),
  },

  projectFiles: {
    search: (input) => ipcRenderer.invoke(IPC_CHANNELS.searchProjectFiles, input),
    listDirectory: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.listProjectDirectory, input),
    readFile: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.readProjectFile, input),
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
    getEventBlob: (input) => ipcRenderer.invoke(IPC_CHANNELS.getEventBlob, input),
    getTimelineSnapshot: (input) => ipcRenderer.invoke(IPC_CHANNELS.getTimelineSnapshot, input),
    setConfigOption: (input) => ipcRenderer.invoke(IPC_CHANNELS.setSessionConfigOption, input),
    setModel: (input) => ipcRenderer.invoke(IPC_CHANNELS.setSessionModel, input),
    getReconnectState: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.getSessionReconnectState, input),
    listElicitations: (input) => ipcRenderer.invoke(IPC_CHANNELS.listSessionElicitations, input),
    respondToElicitation: (input) => ipcRenderer.invoke(IPC_CHANNELS.respondToElicitation, input),
    search: (input) => ipcRenderer.invoke(IPC_CHANNELS.searchSessions, input),
    export: (input) => ipcRenderer.invoke(IPC_CHANNELS.exportSession, input),
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

  jira: {
    listConfigs: () => ipcRenderer.invoke(IPC_CHANNELS.listJiraConfigs, {}),
    saveConfig: (input) => ipcRenderer.invoke(IPC_CHANNELS.saveJiraConfig, input),
    deleteConfig: (input) => ipcRenderer.invoke(IPC_CHANNELS.deleteJiraConfig, input),
    getProjectIntegration: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.getJiraProjectIntegration, input),
    activate: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.activateJiraProjectIntegration, input),
    deactivate: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.deactivateJiraProjectIntegration, input),
    attachIssue: (input) => ipcRenderer.invoke(IPC_CHANNELS.attachJiraIssue, input),
    fetchIssueDetails: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.fetchJiraIssueDetails, input),
    syncAttachments: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.syncJiraAttachments, input),
    onLog: (callback) => {
      const listener = (_event: unknown, payload: unknown) => {
        if (payload && typeof payload === "object") {
          callback(payload as { level: "info" | "warn" | "error"; message: string; details?: unknown });
        }
      };
      ipcRenderer.on(IPC_CHANNELS.jiraLog, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.jiraLog, listener);
      };
    },
  },

  agentExtensions: {
    listSkills: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.listGeminiSkills, input),
    listMcpServers: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.listMcpServers, input),
  },

  stats: {
    get: (input) => ipcRenderer.invoke(IPC_CHANNELS.getStats, input),
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

  subscribeSessionEvents: async (input, callback, onUsageSnapshot) => {
    subscribing += 1;
    let result;
    try {
      result = EventSubscriptionResultSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.subscribeSessionEvents, input));
    } finally { subscribing -= 1; }
    const id = result.subscriptionId;
    let stopped = false;
    let pumping = true;
    let cursor = input.afterSeq;
    let target = Math.max(result.replayUntilSeq, pendingWatermarks.get(id)?.seq ?? 0);
    pendingWatermarks.delete(id);
    if (!subscribing) pendingWatermarks.clear();
    const close = () => {
      if (stopped) return;
      stopped = true;
      callbacks.delete(id);
      pendingWatermarks.delete(id);
      void ipcRenderer.invoke(IPC_CHANNELS.unsubscribeSessionEvents, { subscriptionId: id }).catch(() => undefined);
    };
    const deliver = (events: StreamEnvelope[], replay: boolean) => {
      const fresh = events.filter((event) => event.seq > cursor);
      for (let index = 0; index < fresh.length; index++) {
        if (fresh[index].seq !== cursor + index + 1) throw new Error("Lücke im Sessionverlauf. Bitte die Session erneut öffnen.");
      }
      if (fresh.length) { callback(fresh, { replay }); cursor = fresh.at(-1)!.seq; }
    };
    const catchUp = async (replay: boolean) => {
      while (!stopped && cursor < target) {
        const page = ReplaySessionEventsResultSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.replaySessionEvents, {
          subscriptionId: id, sessionId: input.sessionId, afterSeq: cursor, throughSeq: target, limit: 200,
        }));
        if (stopped) return;
        if (!page.events.length || page.nextAfterSeq <= cursor) throw new Error("Der Sessionverlauf konnte nicht vollständig geladen werden.");
        deliver(page.events, replay);
      }
    };
    callbacks.set(id, (events) => {
      target = events.reduce((max, event) => Math.max(max, event.seq), target);
      if (pumping || stopped) return;
      pumping = true;
      const process = async () => {
        const fresh = events.filter((event) => event.seq > cursor);
        if (fresh[0]?.seq === cursor + 1) deliver(fresh, false);
        await catchUp(false);
      };
      void process().catch((error) => {
        callback([], { replay: false, error: error instanceof Error ? error.message : "Die Live-Anzeige wurde unterbrochen." });
        close();
      }).finally(() => { pumping = false; });
    });
    try {
      onUsageSnapshot?.(result.usageSnapshot);
      deliver(result.replay, true);
      await catchUp(true);
      pumping = false;
      return close;
    } catch (error) { close(); throw error; }
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
Object.freeze(desktopApi.stats);
Object.freeze(desktopApi.integrations);
Object.freeze(desktopApi.gitlab);
Object.freeze(desktopApi.jira);
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
