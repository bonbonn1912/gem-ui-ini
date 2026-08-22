import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { z, type ZodType } from "zod";
import {
  AppUpdateDownloadProgressSchema,
  ContextAttachmentListSchema,
  ContextAttachmentSubscriptionResultSchema,
  EventSubscriptionResultSchema,
  GitLabReviewStateSchema,
  GitLabReviewStateSubscriptionResultSchema,
  GitProjectStatusSchema,
  GitStatusSubscriptionResultSchema,
  IpcRequestSchemas,
  IpcResponseSchemas,
  IPC_CHANNELS,
  StreamEnvelopeBatchSchema,
  TodoListSchema,
  TodoSubscriptionResultSchema,
  type StreamEnvelope,
  type UsageSnapshot,
} from "../shared/contracts";
import type { GemUiDesktopApi } from "./types";

/**
 * Renderer-side Tauri adapter.
 *
 * Rust command arguments are deliberately kept behind this module. The Rust
 * contracts use `serde(rename_all = "camelCase")` for input structs, so the
 * old renderer payload is passed as the `input` command argument unchanged.
 * Subscription commands are the one exception: their explicit Rust
 * parameters are converted in `commandArgs` below.
 */

type IpcChannel = keyof typeof IpcRequestSchemas;
type RequestFor<C extends IpcChannel> = z.input<(typeof IpcRequestSchemas)[C]>;
type ResponseFor<C extends keyof typeof IpcResponseSchemas> = z.output<
  (typeof IpcResponseSchemas)[C]
>;

export class TauriCommandUnavailableError extends Error {
  readonly code = "tauri_command_unavailable";
  readonly command: string;

  constructor(command: string) {
    super(`Tauri command "${command}" is not implemented by the Rust backend yet.`);
    this.name = "TauriCommandUnavailableError";
    this.command = command;
  }
}

const PUSH_EVENTS = {
  appUpdateDownloadProgress: IPC_CHANNELS.appUpdateDownloadProgress,
} as const;

const COMMAND_OVERRIDES: Partial<Record<IpcChannel, string>> = {
  // This command is application-wide, not in the `app:` IPC namespace.
  [IPC_CHANNELS.getCapabilities]: "get_capabilities",
  [IPC_CHANNELS.listProjects]: "projects_list",
  [IPC_CHANNELS.getProject]: "projects_get",
  [IPC_CHANNELS.pickProjectFolders]: "projects_pick_folders",
  [IPC_CHANNELS.createProject]: "projects_create",
  [IPC_CHANNELS.renameProject]: "projects_rename",
  [IPC_CHANNELS.archiveProject]: "projects_set_archived",
  [IPC_CHANNELS.setProjectRoots]: "projects_set_additional_roots",
  [IPC_CHANNELS.deleteProject]: "projects_delete",
  [IPC_CHANNELS.reauthorizeProjectRoot]: "projects_reauthorize_root",
};

/** The migration plan's canonical `domain:verb-object` -> Rust command map. */
export const TAURI_COMMANDS = Object.freeze(
  Object.fromEntries(
    Object.values(IPC_CHANNELS)
      .filter((channel) => !Object.values(PUSH_EVENTS).includes(channel as never))
      .map((channel) => [channel, COMMAND_OVERRIDES[channel as IpcChannel] ?? channelToCommand(channel)]),
  ) as Record<IpcChannel, string>,
);

/** Every mapped request command is registered by the Rust invoke handler. */
const PORTED_COMMANDS = new Set<string>(Object.values(TAURI_COMMANDS));

const EMPTY = {};

function channelToCommand(channel: string): string {
  const [domain, action = ""] = channel.split(":", 2);
  return `${domain.replaceAll("-", "_")}_${action.replaceAll("-", "_")}`;
}
function commandFor(channel: IpcChannel): string {
  return TAURI_COMMANDS[channel];
}

function isTauriRuntime(target: Window = window): boolean {
  return Boolean(
    (target as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
}

function inputFor<C extends IpcChannel>(channel: C, input: RequestFor<C>): unknown {
  const schema = IpcRequestSchemas[channel] as ZodType;
  return schema.parse(input);
}

function responseFor<C extends keyof typeof IpcResponseSchemas>(
  channel: C,
  value: unknown,
): ResponseFor<C> {
  if (
    channel === IPC_CHANNELS.getAttachmentPreview ||
    channel === IPC_CHANNELS.getContextAttachmentBytes
  ) {
    return byteResponse(value) as ResponseFor<C>;
  }
  const schema = IpcResponseSchemas[channel] as ZodType;
  return schema.parse(value) as ResponseFor<C>;
}

function commandArgs<C extends IpcChannel>(channel: C, input: RequestFor<C>): Record<string, unknown> {
  const normalized = inputFor(channel, input) as Record<string, unknown>;
  // Commands whose IPC contract is `EmptyInputSchema` have no `input`
  // parameter on their Rust command. Passing `{ input: {} }` makes Tauri
  // reject those invocations before the command is called (notably settings,
  // update checks, the link-preview close command and integration listings).
  // Checking the normalized payload also keeps this list in sync when a new
  // empty-input command is added to the shared contract.
  if (Object.keys(normalized).length === 0) return {};
  if (channel === IPC_CHANNELS.subscribeSessionEvents) {
    return {
      input: normalized,
      onBatch: (normalized as { onBatch?: unknown }).onBatch,
    };
  }
  if (
    channel === IPC_CHANNELS.subscribeContextAttachments ||
    channel === IPC_CHANNELS.subscribeTodos ||
    channel === IPC_CHANNELS.subscribeGitProjectStatus ||
    channel === IPC_CHANNELS.subscribeGitLabReviewState
  ) {
    return { input: normalized, onChange: (normalized as { onChange?: unknown }).onChange };
  }
  if (
    channel === IPC_CHANNELS.unsubscribeSessionEvents ||
    channel === IPC_CHANNELS.unsubscribeContextAttachments ||
    channel === IPC_CHANNELS.unsubscribeTodos ||
    channel === IPC_CHANNELS.unsubscribeGitProjectStatus ||
    channel === IPC_CHANNELS.unsubscribeGitLabReviewState
  ) {
    return { input: normalized };
  }
  return { input: normalized };
}

async function invokeChannel<C extends IpcChannel>(
  channel: C,
  input: RequestFor<C>,
): Promise<C extends keyof typeof IpcResponseSchemas ? ResponseFor<C> : never> {
  const command = commandFor(channel);
  if (!PORTED_COMMANDS.has(command)) {
    throw new TauriCommandUnavailableError(command);
  }
  try {
    const result = await invoke<unknown>(command, commandArgs(channel, input));
    return responseFor(channel as keyof typeof IpcResponseSchemas, result) as C extends keyof typeof IpcResponseSchemas
      ? ResponseFor<C>
      : never;
  } catch (error) {
    if (error instanceof Error) throw error;
    if (error && typeof error === "object") {
      const errObj = error as Record<string, unknown>;
      const message = typeof errObj.message === "string" ? errObj.message : JSON.stringify(error);
      const customErr = new Error(message);
      if (typeof errObj.code === "string") {
        (customErr as Error & { code?: string }).code = errObj.code;
      }
      throw customErr;
    }
    if (typeof error === "string") {
      throw new Error(error);
    }
    throw new Error(String(error));
  }
}

function clientRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function absolutePath(file: File): string {
  const path = (file as File & { path?: unknown }).path;
  if (typeof path === "string" && path.length > 0) return path;
  throw new TauriCommandUnavailableError(
    "file-drop-path (Tauri native drag-drop integration is not ported yet)",
  );
}

function byteResponse(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every((entry) => Number.isInteger(entry))) {
    return Uint8Array.from(value);
  }
  throw new TypeError("Tauri byte response was not a Uint8Array or ArrayBuffer");
}

type SubscriptionResult = { subscriptionId: string };

async function subscribeChannel<T>(options: {
  subscribe: IpcChannel;
  unsubscribe: IpcChannel;
  input: RequestFor<IpcChannel>;
  onMessage: (message: unknown) => void;
  parseResult: (value: unknown) => SubscriptionResult;
}): Promise<() => void> {
  const subscribeCommand = commandFor(options.subscribe);
  if (!PORTED_COMMANDS.has(subscribeCommand)) {
    throw new TauriCommandUnavailableError(subscribeCommand);
  }

  const channel = new Channel<unknown>(options.onMessage);
  const result = await invoke<unknown>(subscribeCommand, {
    ...commandArgs(options.subscribe, options.input),
    onBatch: channel,
    onChange: channel,
  });
  const subscription = options.parseResult(result);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const unsubscribeCommand = commandFor(options.unsubscribe);
    if (!PORTED_COMMANDS.has(unsubscribeCommand)) {
      console.error(new TauriCommandUnavailableError(unsubscribeCommand));
      return;
    }
    void invoke(unsubscribeCommand, {
      input: { subscriptionId: subscription.subscriptionId },
    });
  };
}

function parseSubscription<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

function pushValue(value: unknown, key: "list" | "status" | "state"): unknown {
  if (typeof value === "object" && value !== null && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return value;
}

export function createTauriBridge(): GemUiDesktopApi {
  const progressCallbacks = new Set<(progress: z.output<typeof AppUpdateDownloadProgressSchema>) => void>();
  let progressUnlisten: UnlistenFn | undefined;
  let progressListen: Promise<UnlistenFn> | undefined;

  const ensureProgressListener = (): void => {
    if (progressListen) return;
    progressListen = listen(PUSH_EVENTS.appUpdateDownloadProgress, (event) => {
      const progress = AppUpdateDownloadProgressSchema.safeParse(event.payload);
      if (!progress.success) {
        console.error("Invalid Tauri update-progress payload", progress.error);
        return;
      }
      for (const callback of progressCallbacks) callback(progress.data);
    }).then((unlisten) => {
      progressUnlisten = unlisten;
      return unlisten;
    });
    void progressListen.catch((error) => {
      console.error("Unable to subscribe to Tauri update progress", error);
      progressListen = undefined;
    });
  };

  const api: GemUiDesktopApi = {
    getCapabilities: () => invokeChannel(IPC_CHANNELS.getCapabilities, EMPTY),
    app: {
      checkForUpdates: () => invokeChannel(IPC_CHANNELS.checkForUpdates, EMPTY),
      downloadUpdate: (input) => invokeChannel(IPC_CHANNELS.downloadUpdate, input),
      installUpdate: (input) => invokeChannel(IPC_CHANNELS.installUpdate, input),
      onDownloadProgress: (callback) => {
        progressCallbacks.add(callback);
        ensureProgressListener();
        return () => {
          progressCallbacks.delete(callback);
          if (progressCallbacks.size === 0 && progressUnlisten) {
            progressUnlisten();
            progressUnlisten = undefined;
            progressListen = undefined;
          }
        };
      },
    },
    settings: {
      chooseGeminiBinary: () => invokeChannel(IPC_CHANNELS.chooseGeminiBinary, EMPTY),
      chooseGitBinary: () => invokeChannel(IPC_CHANNELS.chooseGitBinary, EMPTY),
      pickGeminiBinary: () => invokeChannel(IPC_CHANNELS.chooseGeminiBinary, EMPTY),
    },
    projects: {
      list: (input = {}) => invokeChannel(IPC_CHANNELS.listProjects, input),
      get: (input) => invokeChannel(IPC_CHANNELS.getProject, input),
      reauthorizeRoot: (input) => invokeChannel(IPC_CHANNELS.reauthorizeProjectRoot, input),
      getApprovalPolicy: (input) => invokeChannel(IPC_CHANNELS.getProjectApprovalPolicy, input),
      pickFolders: () => invokeChannel(IPC_CHANNELS.pickProjectFolders, { allowMultiple: true }),
      create: (input) => invokeChannel(IPC_CHANNELS.createProject, input),
      rename: (input) => invokeChannel(IPC_CHANNELS.renameProject, input),
      setArchived: (input) => invokeChannel(IPC_CHANNELS.archiveProject, input),
      setAdditionalRoots: (input) => invokeChannel(IPC_CHANNELS.setProjectRoots, input),
      setApprovalPolicy: (input) => invokeChannel(IPC_CHANNELS.setProjectApprovalPolicy, input),
      delete: (input) => invokeChannel(IPC_CHANNELS.deleteProject, input),
    },
    projectFiles: {
      search: (input) => invokeChannel(IPC_CHANNELS.searchProjectFiles, input),
    },
    sessions: {
      list: (input) => invokeChannel(IPC_CHANNELS.listSessions, input),
      create: (input) => invokeChannel(IPC_CHANNELS.createSession, input),
      update: (input) => invokeChannel(IPC_CHANNELS.updateSession, input),
      delete: (input) => invokeChannel(IPC_CHANNELS.deleteSession, input),
      sendPrompt: (input) => invokeChannel(IPC_CHANNELS.sendPrompt, input),
      cancel: (input) => invokeChannel(IPC_CHANNELS.cancelTurn, input),
      respondToPermission: (input) => invokeChannel(IPC_CHANNELS.respondToPermission, input),
      setMode: (input) => invokeChannel(IPC_CHANNELS.setSessionMode, input),
      setModel: (input) => invokeChannel(IPC_CHANNELS.setSessionModel, input),
      getReconnectState: (input) => invokeChannel(IPC_CHANNELS.getSessionReconnectState, input),
      search: (input) => invokeChannel(IPC_CHANNELS.searchSessions, input),
    },
    attachments: {
      pickImages: (input) => invokeChannel(IPC_CHANNELS.pickImages, input),
      stageDroppedFiles: (files, sessionId = null) => {
        try {
          return invokeChannel(IPC_CHANNELS.stageDroppedPaths, {
            clientRequestId: clientRequestId(),
            paths: files.map(absolutePath),
            sessionId,
          });
        } catch (error) {
          return Promise.reject(error);
        }
      },
      stageClipboardImage: (input) => invokeChannel(IPC_CHANNELS.stageClipboardImage, input),
      getPreviewBytes: async (input) => byteResponse(await invokeChannel(IPC_CHANNELS.getAttachmentPreview, input)),
      remove: (input) => invokeChannel(IPC_CHANNELS.removeAttachment, input),
    },
    contextAttachments: {
      list: (input) => invokeChannel(IPC_CHANNELS.listContextAttachments, input),
      addFiles: (input) => invokeChannel(IPC_CHANNELS.addContextFiles, input),
      addDroppedFiles: (files, target, options) => {
        try {
          const paths = files.map(absolutePath);
          return invokeChannel(IPC_CHANNELS.addContextFiles, {
            ...target,
            clientRequestId: clientRequestId(),
            paths,
            origin: options?.origin ?? "manual",
          });
        } catch (error) {
          return Promise.reject(error);
        }
      },
      addLink: (input) => invokeChannel(IPC_CHANNELS.addContextLink, input),
      update: (input) => invokeChannel(IPC_CHANNELS.updateContextAttachment, input),
      setInclusion: (input) => invokeChannel(IPC_CHANNELS.setContextInclusion, input),
      remove: (input) => invokeChannel(IPC_CHANNELS.removeContextAttachment, input),
      refreshLinkPreview: (input) => invokeChannel(IPC_CHANNELS.refreshLinkPreview, input),
      getBytes: async (input) => byteResponse(await invokeChannel(IPC_CHANNELS.getContextAttachmentBytes, input)),
      openFile: (input) => invokeChannel(IPC_CHANNELS.openContextAttachment, input),
      subscribe: async (input, callback) => subscribeChannel({
        subscribe: IPC_CHANNELS.subscribeContextAttachments,
        unsubscribe: IPC_CHANNELS.unsubscribeContextAttachments,
        input,
        onMessage: (message) => callback(parseSubscription(
          ContextAttachmentListSchema,
          pushValue(message, "list"),
        )),
        parseResult: (value) => {
          const result = parseSubscription(ContextAttachmentSubscriptionResultSchema, value);
          callback(result.list);
          return result;
        },
      }),
    },
    todos: {
      list: (input) => invokeChannel(IPC_CHANNELS.listTodos, input),
      create: (input) => invokeChannel(IPC_CHANNELS.createTodo, input),
      update: (input) => invokeChannel(IPC_CHANNELS.updateTodo, input),
      reorder: (input) => invokeChannel(IPC_CHANNELS.reorderTodos, input),
      delete: (input) => invokeChannel(IPC_CHANNELS.deleteTodo, input),
      addFiles: (input) => invokeChannel(IPC_CHANNELS.addTodoFiles, input),
      addDroppedFiles: (files, target) => {
        try {
          return invokeChannel(IPC_CHANNELS.addTodoFiles, {
            todoId: target.todoId,
            clientRequestId: clientRequestId(),
            paths: files.map(absolutePath),
          });
        } catch (error) {
          return Promise.reject(error);
        }
      },
      addLink: (input) => invokeChannel(IPC_CHANNELS.addTodoLink, input),
      attachAttachment: (input) => invokeChannel(IPC_CHANNELS.attachTodoAttachment, input),
      detachAttachment: (input) => invokeChannel(IPC_CHANNELS.detachTodoAttachment, input),
      prepareForSession: (input) => invokeChannel(IPC_CHANNELS.prepareTodoForSession, input),
      subscribe: async (input, callback) => subscribeChannel({
        subscribe: IPC_CHANNELS.subscribeTodos,
        unsubscribe: IPC_CHANNELS.unsubscribeTodos,
        input,
        onMessage: (message) => callback(parseSubscription(
          TodoListSchema,
          pushValue(message, "list"),
        )),
        parseResult: (value) => {
          const result = parseSubscription(TodoSubscriptionResultSchema, value);
          callback(result.list);
          return result;
        },
      }),
    },
    linkPreview: {
      open: (input) => invokeChannel(IPC_CHANNELS.openLinkPreviewView, input),
      setBounds: (input) => invokeChannel(IPC_CHANNELS.setLinkPreviewBounds, input),
      close: () => invokeChannel(IPC_CHANNELS.closeLinkPreviewView, EMPTY),
      clearStorage: (input) => invokeChannel(IPC_CHANNELS.clearLinkPreviewStorage, input),
    },
    git: {
      listProjectRepositories: (input) => invokeChannel(IPC_CHANNELS.listGitProjectRepositories, input),
      getProjectStatus: (input) => invokeChannel(IPC_CHANNELS.getGitProjectStatus, input),
      getFileDiff: (input) => invokeChannel(IPC_CHANNELS.getGitFileDiff, input),
      subscribeProjectStatus: async (input, callback) => subscribeChannel({
        subscribe: IPC_CHANNELS.subscribeGitProjectStatus,
        unsubscribe: IPC_CHANNELS.unsubscribeGitProjectStatus,
        input,
        onMessage: (message) => callback(parseSubscription(
          GitProjectStatusSchema,
          pushValue(message, "status"),
        )),
        parseResult: (value) => {
          const result = parseSubscription(GitStatusSubscriptionResultSchema, value);
          callback(result.status);
          return result;
        },
      }),
    },
    integrations: {
      listProject: (input) => invokeChannel(IPC_CHANNELS.listProjectIntegrations, input),
    },
    gitlab: {
      listRepositoryCandidates: (input) => invokeChannel(IPC_CHANNELS.listGitLabRepositoryCandidates, input),
      listConnections: () => invokeChannel(IPC_CHANNELS.listGitLabConnections, EMPTY),
      testConnection: (input) => invokeChannel(IPC_CHANNELS.testGitLabConnection, input),
      saveConnection: (input) => invokeChannel(IPC_CHANNELS.saveGitLabConnection, input),
      replaceToken: (input) => invokeChannel(IPC_CHANNELS.replaceGitLabToken, input),
      removeConnection: (input) => invokeChannel(IPC_CHANNELS.removeGitLabConnection, input),
      enableBinding: (input) => invokeChannel(IPC_CHANNELS.enableGitLabBinding, input),
      disableBinding: (input) => invokeChannel(IPC_CHANNELS.disableGitLabBinding, input),
      listMergeRequests: (input) => invokeChannel(IPC_CHANNELS.listGitLabMergeRequests, input),
      selectMergeRequest: (input) => invokeChannel(IPC_CHANNELS.selectGitLabMergeRequest, input),
      connectMergeRequestUrl: (input) => invokeChannel(IPC_CHANNELS.connectGitLabMergeRequestUrl, input),
      getReviewState: (input) => invokeChannel(IPC_CHANNELS.getGitLabReviewState, input),
      subscribeReviewState: async (input, callback) => subscribeChannel({
        subscribe: IPC_CHANNELS.subscribeGitLabReviewState,
        unsubscribe: IPC_CHANNELS.unsubscribeGitLabReviewState,
        input,
        onMessage: (message) => callback(parseSubscription(
          GitLabReviewStateSchema,
          pushValue(message, "state"),
        )),
        parseResult: (value) => {
          const result = parseSubscription(GitLabReviewStateSubscriptionResultSchema, value);
          callback(result.initial);
          return result;
        },
      }),
      prepareReviewContext: (input) => invokeChannel(IPC_CHANNELS.prepareGitLabReviewContext, input),
      resolveDiscussion: (input) => invokeChannel(IPC_CHANNELS.resolveGitLabDiscussion, input),
      replyToDiscussion: (input) => invokeChannel(IPC_CHANNELS.replyToGitLabDiscussion, input),
    },
    jira: {
      listConfigs: () => invokeChannel(IPC_CHANNELS.listJiraConfigs, EMPTY),
      saveConfig: (input) => invokeChannel(IPC_CHANNELS.saveJiraConfig, input),
      deleteConfig: (input) => invokeChannel(IPC_CHANNELS.deleteJiraConfig, input),
      getProjectIntegration: (input) => invokeChannel(IPC_CHANNELS.getJiraProjectIntegration, input),
      activate: (input) => invokeChannel(IPC_CHANNELS.activateJiraProjectIntegration, input),
      deactivate: (input) => invokeChannel(IPC_CHANNELS.deactivateJiraProjectIntegration, input),
      attachIssue: (input) => invokeChannel(IPC_CHANNELS.attachJiraIssue, input),
    },
    agentExtensions: {
      listSkills: (input) => invokeChannel(IPC_CHANNELS.listGeminiSkills, input),
      listMcpServers: (input) => invokeChannel(IPC_CHANNELS.listMcpServers, input),
    },
    subscribeSessionEvents: async (input, callback, onUsageSnapshot) => {
      const command = commandFor(IPC_CHANNELS.subscribeSessionEvents);
      if (!PORTED_COMMANDS.has(command)) throw new TauriCommandUnavailableError(command);
      const channel = new Channel<unknown>((message) => {
        const payload = typeof message === "object" && message !== null && "events" in message
          ? (message as { events: unknown }).events
          : message;
        const events = StreamEnvelopeBatchSchema.parse(payload) as StreamEnvelope[];
        callback(events);
      });
      const result = parseSubscription(EventSubscriptionResultSchema, await invoke(command, {
        input,
        onBatch: channel,
      }));
      onUsageSnapshot?.(result.usageSnapshot as UsageSnapshot | null);
      if (result.replay.length > 0) callback(result.replay);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const unsubscribe = commandFor(IPC_CHANNELS.unsubscribeSessionEvents);
        if (!PORTED_COMMANDS.has(unsubscribe)) {
          console.error(new TauriCommandUnavailableError(unsubscribe));
          return;
        }
        void invoke(unsubscribe, { input: { subscriptionId: result.subscriptionId } });
      };
    },
    openExternalHttpsUrl: (url) => invokeChannel(IPC_CHANNELS.openExternalHttpsUrl, { url }),
  };

  return freezeApi(api);
}

function freezeApi(api: GemUiDesktopApi): GemUiDesktopApi {
  for (const value of Object.values(api)) {
    if (value && typeof value === "object") Object.freeze(value);
  }
  return Object.freeze(api);
}

/** Installs the bridge before Solid is mounted. */
export function installTauriBridge(target: Window = window): GemUiDesktopApi | null {
  if (!isTauriRuntime(target)) return null;
  const api = createTauriBridge();
  target.gemUi = api;
  return api;
}
