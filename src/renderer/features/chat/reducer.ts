import type {
  Attachment,
  ModelTokenUsage,
  PermissionOption,
  StreamEnvelope,
  TokenCounters,
  UsageSnapshot,
} from "../../types";

type ToolPayload = {
  toolCallId: string;
  title?: string;
  kind?: string | null;
  status?: string;
  arguments?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown[];
  update?: unknown;
  result?: unknown;
  error?: unknown;
  input?: unknown;
  output?: unknown;
  diff?: string;
  // ACP location entries are JSON values; validate the path/line shape before
  // exposing them to the strongly typed timeline model.
  locations?: unknown[];
};

export type TurnPhase =
  | "idle"
  | "running"
  | "awaiting_permission"
  | "cancelling"
  | "error"
  | "disconnected";

type TimelineBase = {
  id: string;
  turnId: string | null;
  timestamp: string;
  seq?: number;
  /** Stable creation order; seq tracks the latest update for replay watermarks. */
  orderSeq?: number;
};

export type ProviderSessionHistoryEntry = {
  providerSessionId: string;
  startedAt: string;
  transferredContext: boolean;
};

export type MessageItem = TimelineBase & {
  kind: "message";
  role: "user" | "assistant";
  text: string;
  contentBlocks?: unknown[];
  model?: string | null;
  turnUsage?: {
    tokens: TokenCounters;
    byModel: ModelTokenUsage[];
  };
  attachments: Array<{ id: string; name: string; mimeType?: string }>;
  contextAttachments: Array<{ id: string; kind: "file" | "link"; title: string }>;
  projectFiles?: Array<{ rootId: string; relativePath: string; rootLabel?: string; displayName?: string; kind?: "file" | "directory" }>;
  externalContexts?: Array<{
    kind: "gitlab_review";
    id: string;
    title: string;
    repositoryLabel?: string;
    mergeRequestReference?: string;
    filePath?: string | null;
    startLine?: number | null;
    endLine?: number | null;
    contextMode?: string;
  }>;
  clientRequestId?: string;
  streaming?: boolean;
  failed?: boolean;
};

export type ThoughtItem = TimelineBase & {
  kind: "thought";
  text: string;
  streaming: boolean;
};

export type ToolItem = TimelineBase & {
  kind: "tool";
  toolCallId: string;
  title: string;
  toolKind?: string;
  status: "running" | "completed" | "failed";
  input?: unknown;
  output?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown[];
  diff?: string;
  locations?: Array<{ path: string; line?: number }>;
  error?: string;
};

export type PermissionItem = TimelineBase & {
  kind: "permission";
  requestId: string;
  toolCallId?: string | null;
  title: string;
  description?: string;
  details?: unknown;
  options: PermissionOption[];
  status: "pending" | "submitting" | "allowed" | "rejected" | "cancelled" | "error";
  selectedOptionId?: string;
};

export type NoticeItem = TimelineBase & {
  kind: "notice";
  tone: "neutral" | "warning" | "error";
  text: string;
  /** Technische Rohdaten zum Aufklappen, etwa der JSON-RPC-Fehlerrumpf. */
  detail?: string;
};

export type AgentPlanItem = TimelineBase & { kind: "plan"; plan: unknown; planId: string | null };

export type TimelineItem =
  | MessageItem
  | ThoughtItem
  | ToolItem
  | PermissionItem
  | NoticeItem
  | AgentPlanItem;

export interface ChatState {
  sessionId: string | null;
  items: TimelineItem[];
  providerSessions: ProviderSessionHistoryEntry[];
  imageSupported: boolean | null;
  lastSeq: number;
  phase: TurnPhase;
  activeTurnId: string | null;
  /**
   * Complete snapshot delivered by the main process. It is replaced as a whole;
   * the renderer never merges fields or uses one value as a fallback for
   * another, which is what used to turn consumption into context occupancy.
   */
  usage: UsageSnapshot | null;
  modes: string[];
  models: string[];
  currentModeId: string | null;
  configOptions: unknown[];
  commands: Array<{ name: string; description?: string | null }>;
  sessionInfo: { title?: string | null; updatedAt?: string | null };
  error: string | null;
}

export type ChatAction =
  | { type: "reset"; sessionId: string | null }
  | { type: "hydrated-snapshot"; sessionId: string; throughSeq: number; items: TimelineItem[]; state?: Partial<Pick<ChatState, "phase" | "activeTurnId" | "usage" | "modes" | "models" | "currentModeId" | "configOptions" | "commands" | "sessionInfo" | "error" | "providerSessions" | "imageSupported">> }
  | { type: "hydrated-page"; sessionId: string; throughSeq: number; items: TimelineItem[] }
  | { type: "usage-snapshot"; snapshot: UsageSnapshot | null }
  | { type: "provider-session-history"; entry: ProviderSessionHistoryEntry }
  | { type: "events"; events: StreamEnvelope[] }
  | {
      type: "optimistic-user";
      clientRequestId: string;
      text: string;
      attachments: Attachment[];
      contextAttachments: Array<{ id: string; kind: "file" | "link"; title: string }>;
      projectFiles: Array<{ rootId: string; rootLabel: string; relativePath: string; displayName: string; kind?: "file" | "directory" }>;
      timestamp: string;
    }
  | { type: "prompt-failed"; clientRequestId: string; message: string }
  | { type: "turn-started"; turnId: string }
  | { type: "cancelling" }
  | { type: "permission-submitting"; requestId: string; optionId: string }
  | { type: "permission-failed"; requestId: string };

export function createChatState(sessionId: string | null = null): ChatState {
  return {
    sessionId,
    items: [],
    providerSessions: [],
    imageSupported: null,
    lastSeq: 0,
    phase: "idle",
    activeTurnId: null,
    usage: null,
    modes: [],
    models: [],
    currentModeId: null,
    configOptions: [],
    commands: [],
    sessionInfo: {},
    error: null,
  };
}

function eventText(event: { delta?: string; text?: string; content?: unknown }): string {
  if (typeof event.delta === "string") return event.delta;
  if (typeof event.text === "string") return event.text;
  if (typeof event.content === "string") return event.content;
  if (
    event.content &&
    typeof event.content === "object" &&
    "text" in event.content &&
    typeof (event.content as { text?: unknown }).text === "string"
  ) {
    return (event.content as { text: string }).text;
  }
  return "";
}

function itemId(prefix: string, envelope: StreamEnvelope, explicit?: string): string {
  return `${prefix}:${explicit ?? envelope.turnId ?? envelope.seq}`;
}

function closeStreamingItems(items: TimelineItem[]): TimelineItem[] {
  return items.map((item) => {
    if (item.kind === "message" && item.role === "assistant" && item.streaming) {
      return { ...item, streaming: false };
    }
    if (item.kind === "thought" && item.streaming) {
      return { ...item, streaming: false };
    }
    return item;
  });
}

function payloadError(error: unknown, fallback: string): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return fallback;
}

/**
 * Die eigentliche Aussage eines ACP-Fehlers steckt oft nicht in `message`,
 * sondern in `details` — die Meldung selbst ist dann nur "Internal error".
 */
function payloadErrorDetail(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const details = (error as { details?: unknown }).details;
  if (details === undefined || details === null) return undefined;
  if (typeof details === "string") return details.trim() || undefined;
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return undefined;
  }
}

function planId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = record.planId ?? record.id;
  return typeof id === "string" && id.trim() ? id : null;
}

function normalizedLocations(value: unknown): Array<{ path: string; line?: number }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const locations = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || !("path" in entry)) return [];
    const record = entry as { path?: unknown; line?: unknown };
    if (typeof record.path !== "string") return [];
    return [{ path: record.path, ...(typeof record.line === "number" ? { line: record.line } : {}) }];
  });
  return locations.length ? locations : undefined;
}

function mergeTool(
  state: ChatState,
  envelope: StreamEnvelope,
  tool: ToolPayload,
  status: ToolItem["status"],
): ChatState {
  const existingIndex = state.items.findIndex(
    (item) => item.kind === "tool" && item.toolCallId === tool.toolCallId,
  );
  const existing = existingIndex >= 0 ? (state.items[existingIndex] as ToolItem) : undefined;
  const nextTool: ToolItem = {
    id: existing?.id ?? `tool:${tool.toolCallId}`,
    kind: "tool",
    toolCallId: tool.toolCallId,
    title: tool.title ?? existing?.title ?? "Werkzeug",
    toolKind: tool.kind ?? existing?.toolKind,
    status,
    input: tool.input ?? tool.rawInput ?? tool.arguments ?? existing?.input,
    output: tool.output ?? tool.rawOutput ?? tool.result ?? tool.update ?? tool.content ?? existing?.output,
    rawInput: tool.rawInput ?? existing?.rawInput,
    rawOutput: tool.rawOutput ?? existing?.rawOutput,
    content: tool.content ?? existing?.content,
    diff: tool.diff ?? existing?.diff,
    locations: normalizedLocations(tool.locations) ?? existing?.locations,
    error: tool.error ? payloadError(tool.error, "Werkzeug fehlgeschlagen") : existing?.error,
    turnId: envelope.turnId,
    timestamp: existing?.timestamp ?? envelope.timestamp,
    seq: envelope.seq,
    orderSeq: existing?.orderSeq ?? envelope.seq,
  };

  if (existingIndex < 0) {
    return { ...state, items: [...state.items, nextTool] };
  }

  const items = [...state.items];
  items[existingIndex] = nextTool;
  return { ...state, items };
}

function recordProviderSession(
  current: ProviderSessionHistoryEntry[],
  pid: string | null | undefined,
  timestamp: string,
  hasPriorConversation: boolean,
): ProviderSessionHistoryEntry[] {
  if (!pid) return current;
  const isFirst = current.length === 0;
  const exists = current.some((s) => s.providerSessionId === pid);
  if (exists) return current;
  return [
    ...current,
    {
      providerSessionId: pid,
      startedAt: timestamp,
      transferredContext: !isFirst || hasPriorConversation,
    },
  ];
}

function applyEnvelope(state: ChatState, envelope: StreamEnvelope): ChatState {
  if (state.sessionId && envelope.sessionId !== state.sessionId) return state;

  const event = envelope.event;
  let next = {
    ...state,
    lastSeq: envelope.seq,
  };

  switch (event.type) {
    case "session.started": {
      const hasPriorConversation = next.items.some(
        (item) => item.kind === "message" && item.role === "user",
      );
      const providerSessions = recordProviderSession(
        next.providerSessions,
        event.providerSessionId,
        envelope.timestamp,
        hasPriorConversation,
      );
      return { ...next, providerSessions, phase: "running", error: null };
    }
    case "session.ready": {
      const hasPriorConversation = next.items.some(
        (item) => item.kind === "message" && item.role === "user",
      );
      const providerSessions = recordProviderSession(
        next.providerSessions,
        event.providerSessionId,
        envelope.timestamp,
        hasPriorConversation,
      );
      return {
        ...next,
        providerSessions,
        phase: "idle",
        modes: event.modes ?? next.modes,
        models: event.models ?? next.models,
        imageSupported: event.capabilities?.images ?? next.imageSupported,
        configOptions: event.configOptions ?? next.configOptions,
        currentModeId: event.currentModeId ?? next.currentModeId,
        error: null,
      };
    }
    case "message.user": {
      const optimisticIndex = next.items.findLastIndex(
        (item) =>
          item.kind === "message" &&
          item.role === "user" &&
          item.seq === undefined &&
          item.text === eventText(event),
      );
      const optimistic = optimisticIndex >= 0
        ? (next.items[optimisticIndex] as MessageItem)
        : undefined;
      const eventAttachments = event.attachmentIds.map((id, index) => ({
        id,
        name: optimistic?.attachments[index]?.name ?? `Bild ${index + 1}`,
        mimeType: optimistic?.attachments[index]?.mimeType,
      }));
      const message: MessageItem = {
        id: itemId("user", envelope, event.messageId),
        kind: "message",
        role: "user",
        text: eventText(event),
        attachments: eventAttachments,
        contextAttachments: event.contextAttachments,
        projectFiles: event.projectFiles,
        externalContexts: event.externalContexts,
        clientRequestId: optimistic?.clientRequestId,
        turnId: envelope.turnId,
      timestamp: envelope.timestamp,
      seq: envelope.seq,
      orderSeq: optimistic?.orderSeq ?? envelope.seq,
      };
      if (optimisticIndex >= 0) {
        const items = [...next.items];
        const optimisticMessage = items[optimisticIndex] as MessageItem;
        items[optimisticIndex] = {
          ...message,
          text: message.text || optimisticMessage.text,
          attachments: message.attachments.length
            ? message.attachments
            : optimisticMessage.attachments,
          contextAttachments: message.contextAttachments.length
            ? message.contextAttachments
            : optimisticMessage.contextAttachments,
          projectFiles: message.projectFiles?.length
            ? message.projectFiles
            : optimisticMessage.projectFiles,
          externalContexts: message.externalContexts?.length
            ? message.externalContexts
            : optimisticMessage.externalContexts,
        };
        return {
          ...next,
          items,
          phase: "running",
          activeTurnId: envelope.turnId,
          error: null,
        };
      }
      return {
        ...next,
        items: [...next.items, message],
        phase: "running",
        activeTurnId: envelope.turnId,
        error: null,
      };
    }
    case "message.assistant.delta": {
      const id = itemId("assistant", envelope, event.messageId);
      const tailIndex = next.items.length - 1;
      const tail = next.items[tailIndex];
      if (tail?.kind === "message" && tail.role === "assistant" && tail.id === id && tail.streaming) {
        const items = [...next.items];
        items[tailIndex] = {
          ...tail,
          text: tail.text + eventText(event),
          ...(event.contentBlocks ? { contentBlocks: [...(tail.contentBlocks ?? []), ...event.contentBlocks] } : {}),
          seq: envelope.seq,
        };
        return { ...next, items, phase: "running", activeTurnId: envelope.turnId };
      }
      const exactIndex = next.items.findIndex((item) => item.id === id);
      const index = exactIndex;
      const delta = eventText(event);
      if (index >= 0) {
        const items = [...next.items];
        const existing = items[index] as MessageItem;
        items[index] = {
          ...existing,
          text: existing.text + delta,
          ...(event.contentBlocks ? { contentBlocks: [...(existing.contentBlocks ?? []), ...event.contentBlocks] } : {}),
          seq: envelope.seq,
        };
        return { ...next, items, phase: "running", activeTurnId: envelope.turnId };
      }
      return {
        ...next,
        items: [
          ...next.items,
          {
            id,
            kind: "message",
            role: "assistant",
            text: delta,
            ...(event.contentBlocks ? { contentBlocks: event.contentBlocks } : {}),
            attachments: [],
            contextAttachments: [],
            projectFiles: [],
            streaming: true,
            turnId: envelope.turnId,
            timestamp: envelope.timestamp,
            seq: envelope.seq,
            orderSeq: envelope.seq,
          },
        ],
        phase: "running",
        activeTurnId: envelope.turnId,
      };
    }
    case "message.thought.delta": {
      const id = itemId("thought", envelope, event.messageId);
      const tailIndex = next.items.length - 1;
      const tail = next.items[tailIndex];
      if (tail?.kind === "thought" && tail.id === id && tail.streaming) {
        const items = [...next.items];
        items[tailIndex] = { ...tail, text: tail.text + eventText(event), seq: envelope.seq };
        return { ...next, items };
      }
      const exactIndex = next.items.findIndex((item) => item.id === id);
      const index = exactIndex;
      const delta = eventText(event);
      if (index >= 0) {
        const items = [...next.items];
        const existing = items[index] as ThoughtItem;
        items[index] = { ...existing, text: existing.text + delta, seq: envelope.seq };
        return { ...next, items };
      }
      return {
        ...next,
        items: [
          ...next.items,
          {
            id,
            kind: "thought",
            text: delta,
            streaming: true,
            turnId: envelope.turnId,
            timestamp: envelope.timestamp,
            seq: envelope.seq,
            orderSeq: envelope.seq,
          },
        ],
      };
    }
    case "tool.started":
      return mergeTool({ ...next, phase: "running" }, envelope, event, "running");
    case "tool.updated":
      return mergeTool(next, envelope, event, "running");
    case "tool.completed":
      return mergeTool(next, envelope, event, "completed");
    case "tool.failed":
      return mergeTool(next, envelope, event, "failed");
    case "permission.requested":
      return {
        ...next,
        phase: "awaiting_permission",
        items: [
          ...next.items,
          {
            id: `permission:${event.requestId}`,
            kind: "permission",
            requestId: event.requestId,
            toolCallId: event.toolCallId,
            title: event.title ?? "Freigabe erforderlich",
            options: event.options,
            status: "pending",
            turnId: envelope.turnId,
            timestamp: envelope.timestamp,
            seq: envelope.seq,
            orderSeq: envelope.seq,
          },
        ],
      };
    case "permission.resolved": {
      const items = next.items.map((item): TimelineItem => {
        if (item.kind !== "permission" || item.requestId !== event.requestId) return item;
        const selected = item.options.find((option) => option.optionId === event.optionId);
        const inferredOutcome = selected?.kind?.startsWith("allow") ? "allowed" : "rejected";
        return {
          ...item,
          status: inferredOutcome,
          selectedOptionId: event.optionId ?? undefined,
          seq: envelope.seq,
        };
      });
      return { ...next, items, phase: "running" };
    }
    case "usage.updated": {
      const lastTurn = event.snapshot.lastTurn;
      let items = next.items;
      if (lastTurn) {
        items = next.items.map((item) => {
          if (
            item.kind === "message" &&
            item.role === "assistant" &&
            (item.turnId === lastTurn.turnId || (!item.turnId && !item.turnUsage))
          ) {
            return {
              ...item,
              model: lastTurn.byModel[0]?.model ?? item.model,
              turnUsage: {
                tokens: lastTurn.tokens,
                byModel: lastTurn.byModel,
              },
            };
          }
          return item;
        });
      }
      return next.usage && next.usage.revision > event.snapshot.revision
        ? { ...next, items }
        : { ...next, items, usage: event.snapshot };
    }
    case "turn.completed": {
      let items = closeStreamingItems(next.items);
      const lastTurn = next.usage?.lastTurn;
      if (lastTurn) {
        const lastIdx = items.findLastIndex(
          (item) => item.kind === "message" && item.role === "assistant",
        );
        if (lastIdx >= 0) {
          const target = items[lastIdx] as MessageItem;
          if (!target.turnUsage || target.turnId === lastTurn.turnId) {
            items = [...items];
            items[lastIdx] = {
              ...target,
              model: lastTurn.byModel[0]?.model ?? target.model,
              turnUsage: {
                tokens: lastTurn.tokens,
                byModel: lastTurn.byModel,
              },
            };
          }
        }
      }
      return {
        ...next,
        items,
        phase: "idle",
        activeTurnId: null,
        error: null,
      };
    }
    case "turn.cancelled":
      return {
        ...next,
        items: [
          ...closeStreamingItems(next.items),
          {
            id: `cancelled:${envelope.seq}`,
            kind: "notice",
            tone: "neutral",
            text: event.reason ?? "Antwort wurde gestoppt.",
            turnId: envelope.turnId,
            timestamp: envelope.timestamp,
            seq: envelope.seq,
            orderSeq: envelope.seq,
          },
        ],
        phase: "idle",
        activeTurnId: null,
      };
    case "turn.failed": {
      const message = payloadError(event.error, "Der Turn ist fehlgeschlagen.");
      const detail = payloadErrorDetail(event.error);
      /**
       * "warning" heißt: Die Antwort steht bereits vollständig darüber, der
       * Fehler kam erst beim Abschluss des Turns. Dann bleibt die Session
       * benutzbar, und die Meldung ist ein Hinweis statt eines Fehlschlags.
       */
      const afterAnswer = event.severity === "warning";
      return {
        ...next,
        items: [
          ...closeStreamingItems(next.items),
          {
            id: `failed:${envelope.seq}`,
            kind: "notice",
            tone: afterAnswer ? "warning" : "error",
            text: afterAnswer
              ? `Gemini hat den Turn mit einer Fehlermeldung abgeschlossen; die Antwort oben ist vollständig angekommen. ${message}`
              : message,
            ...(detail ? { detail } : {}),
            turnId: envelope.turnId,
            timestamp: envelope.timestamp,
            seq: envelope.seq,
            orderSeq: envelope.seq,
          },
        ],
        phase: afterAnswer ? "idle" : "error",
        activeTurnId: null,
        error: afterAnswer ? next.error : message,
      };
    }
    case "process.disconnected": {
      const message = event.reason || "Die Verbindung zu Gemini CLI wurde getrennt.";
      return {
        ...next,
        items: [
          ...closeStreamingItems(next.items),
          {
            id: `disconnected:${envelope.seq}`,
            kind: "notice",
            tone: "error",
            text: message,
            turnId: envelope.turnId,
            timestamp: envelope.timestamp,
            seq: envelope.seq,
            orderSeq: envelope.seq,
          },
        ],
        phase: "disconnected",
        activeTurnId: null,
        error: message,
      };
    }
    case "commands.updated":
      return { ...next, commands: event.commands };
    case "mode.updated":
      return { ...next, currentModeId: event.currentModeId };
    case "config.updated":
      return { ...next, configOptions: event.configOptions };
    case "session.info.updated":
      return { ...next, sessionInfo: { ...next.sessionInfo, ...event } };
    case "plan.updated": {
      const index = next.items.findIndex((item) => item.kind === "plan");
      const planItem: AgentPlanItem = {
        id: `plan:${planId(event.plan) ?? "default"}`,
        kind: "plan",
        plan: event.plan,
        planId: planId(event.plan),
        turnId: envelope.turnId,
        timestamp: envelope.timestamp,
        seq: envelope.seq,
        orderSeq: index >= 0 ? next.items[index]!.orderSeq ?? next.items[index]!.seq : envelope.seq,
      };
      const items = [...next.items];
      if (index < 0) items.push(planItem);
      else items[index] = planItem;
      return { ...next, items };
    }
    case "plan.removed":
      return {
        ...next,
        items: next.items.filter((item) => item.kind !== "plan" || item.planId !== event.planId),
      };
  }
}

/** Merge events received after a replay watermark over an older materialized
 * item. Assistant text is fragment based, so the live tail extends the
 * snapshot text; tool fields are a patch and retain snapshot values omitted by
 * a partial update. */
function mergeHydratedItem(base: TimelineItem, live: TimelineItem): TimelineItem {
  if (base.kind === "message" && live.kind === "message" && base.role === "assistant" && live.role === "assistant") {
    return {
      ...base,
      ...live,
      orderSeq: base.orderSeq ?? base.seq,
      text: `${base.text}${live.text}`,
      contentBlocks: [...(base.contentBlocks ?? []), ...(live.contentBlocks ?? [])],
      attachments: live.attachments.length ? live.attachments : base.attachments,
      contextAttachments: live.contextAttachments.length ? live.contextAttachments : base.contextAttachments,
      projectFiles: live.projectFiles?.length ? live.projectFiles : base.projectFiles,
    };
  }
  if (base.kind === "thought" && live.kind === "thought") {
    return { ...base, ...live, orderSeq: base.orderSeq ?? base.seq, text: `${base.text}${live.text}` };
  }
  if (base.kind === "tool" && live.kind === "tool") {
    return {
      ...base,
      ...live,
      orderSeq: base.orderSeq ?? base.seq,
      input: live.input ?? base.input,
      output: live.output ?? base.output,
      rawInput: live.rawInput ?? base.rawInput,
      rawOutput: live.rawOutput ?? base.rawOutput,
      content: live.content ?? base.content,
      locations: live.locations ?? base.locations,
      error: live.error ?? base.error,
    };
  }
  return { ...base, ...live, orderSeq: base.orderSeq ?? base.seq } as TimelineItem;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "reset":
      return createChatState(action.sessionId);
    case "hydrated-snapshot":
      if (state.sessionId !== action.sessionId) return state;
      {
        const existingById = new Map(state.items.map((item) => [item.id, item]));
        const mergedSnapshot = action.items.map((item) => {
          const live = existingById.get(item.id);
          return live && live.seq !== undefined && live.seq > action.throughSeq
            ? mergeHydratedItem(item, live)
            : item;
        });
        const snapshotIds = new Set(action.items.map((item) => item.id));
        const newerItems = state.items.filter((item) =>
          item.seq === undefined || (item.seq > action.throughSeq && !snapshotIds.has(item.id)),
        );
      return {
      ...state,
          ...(action.state ?? {}),
          items: [...mergedSnapshot, ...newerItems].sort((a, b) => (a.orderSeq ?? a.seq ?? Number.MAX_SAFE_INTEGER) - (b.orderSeq ?? b.seq ?? Number.MAX_SAFE_INTEGER)),
          lastSeq: Math.max(state.lastSeq, action.throughSeq),
          ...(state.lastSeq <= action.throughSeq
            ? { phase: action.state?.phase ?? "idle", activeTurnId: action.state?.activeTurnId ?? null }
            : {}),
      };
      }
    case "hydrated-page":
      if (state.sessionId !== action.sessionId) return state;
      {
        const currentById = new Map(state.items.map((item) => [item.id, item]));
        const older = action.items.map((item) => {
          const live = currentById.get(item.id);
          if (!live || live.seq === undefined || live.seq <= action.throughSeq) return item;
          return mergeHydratedItem(item, live);
        });
        const ids = new Set(older.map((item) => item.id));
        const merged = [...older, ...state.items.filter((item) => !ids.has(item.id))];
        merged.sort((a, b) => (a.orderSeq ?? a.seq ?? Number.MIN_SAFE_INTEGER) - (b.orderSeq ?? b.seq ?? Number.MIN_SAFE_INTEGER));
        return { ...state, items: merged };
      }
    case "usage-snapshot":
      // Restart path: the persisted snapshot must not overwrite a newer live
      // value that already arrived through the replay.
      if (!action.snapshot) return state;
      return state.usage && state.usage.revision >= action.snapshot.revision
        ? state
        : { ...state, usage: action.snapshot };
    case "provider-session-history": {
      const exists = state.providerSessions.some(
        (s) => s.providerSessionId === action.entry.providerSessionId,
      );
      if (exists) return state;
      return {
        ...state,
        providerSessions: [...state.providerSessions, action.entry],
      };
    }
    case "events": {
      const ordered = [...action.events]
        .filter(
          (event) =>
            event.seq > state.lastSeq &&
            (!state.sessionId || event.sessionId === state.sessionId),
        )
        .sort((a, b) => a.seq - b.seq);
      // Persisted IPC batches frequently contain dozens of adjacent deltas for
      // the same provider message. Fold each contiguous run before reducing so
      // we copy the timeline once per batch instead of once per token fragment.
      const events: StreamEnvelope[] = [];
      for (const envelope of ordered) {
        const previous = events.at(-1);
        const event = envelope.event;
        const priorEvent = previous?.event;
        if (
          previous && priorEvent &&
          (event.type === "message.assistant.delta" || event.type === "message.thought.delta") &&
          priorEvent.type === event.type &&
          "messageId" in priorEvent && priorEvent.messageId === event.messageId &&
          previous.turnId === envelope.turnId
        ) {
          const delta = eventText(priorEvent) + eventText(event);
          events[events.length - 1] = {
            ...envelope,
            timestamp: previous.timestamp,
            event: {
              ...event,
              delta,
              ...("contentBlocks" in event || "contentBlocks" in priorEvent
                ? {
                    contentBlocks: [
                      ...("contentBlocks" in priorEvent ? priorEvent.contentBlocks ?? [] : []),
                      ...("contentBlocks" in event ? event.contentBlocks ?? [] : []),
                    ],
                  }
                : {}),
            },
          };
        } else {
          events.push(envelope);
        }
      }
      return events.reduce(applyEnvelope, state);
    }
    case "optimistic-user":
      return {
        ...state,
        phase: "running",
        error: null,
        items: [
          ...state.items,
          {
            id: `optimistic:${action.clientRequestId}`,
            kind: "message",
            role: "user",
            text: action.text,
            attachments: action.attachments.map(({ id, displayName, mimeType }) => ({
              id,
              name: displayName,
              mimeType,
            })),
            contextAttachments: action.contextAttachments,
            projectFiles: action.projectFiles,
            clientRequestId: action.clientRequestId,
            timestamp: action.timestamp,
            turnId: null,
          },
        ],
      };
    case "prompt-failed":
      return {
        ...state,
        phase: "error",
        error: action.message,
        items: state.items.map((item) =>
          item.kind === "message" && item.clientRequestId === action.clientRequestId
            ? { ...item, failed: true }
            : item,
        ),
      };
    case "turn-started":
      return { ...state, activeTurnId: action.turnId, phase: "running" };
    case "cancelling":
      return { ...state, phase: "cancelling" };
    case "permission-submitting":
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === "permission" && item.requestId === action.requestId
            ? {
                ...item,
                status: "submitting" as const,
                selectedOptionId: action.optionId,
              }
            : item,
        ),
      };
    case "permission-failed":
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === "permission" && item.requestId === action.requestId
            ? { ...item, status: "error" as const }
            : item,
        ),
      };
  }
}
