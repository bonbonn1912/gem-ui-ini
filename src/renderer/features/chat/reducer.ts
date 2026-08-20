import type {
  Attachment,
  PermissionOption,
  StreamEnvelope,
} from "../../types";

type ToolPayload = {
  toolCallId: string;
  title?: string;
  kind?: string | null;
  status?: string;
  arguments?: unknown;
  update?: unknown;
  result?: unknown;
  error?: unknown;
  input?: unknown;
  output?: unknown;
  diff?: string;
  locations?: Array<{ path: string; line?: number }>;
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
};

export type MessageItem = TimelineBase & {
  kind: "message";
  role: "user" | "assistant";
  text: string;
  attachments: Array<{ id: string; name: string; mimeType?: string }>;
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
};

export type TimelineItem =
  | MessageItem
  | ThoughtItem
  | ToolItem
  | PermissionItem
  | NoticeItem;

export interface ChatState {
  sessionId: string | null;
  items: TimelineItem[];
  lastSeq: number;
  phase: TurnPhase;
  activeTurnId: string | null;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    used?: number;
    size?: number;
    cost?: {
      amount: number;
      currency: string;
    };
  } | null;
  modes: string[];
  models: string[];
  error: string | null;
}

export type ChatAction =
  | { type: "reset"; sessionId: string | null }
  | { type: "events"; events: StreamEnvelope[] }
  | {
      type: "optimistic-user";
      clientRequestId: string;
      text: string;
      attachments: Attachment[];
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
    lastSeq: 0,
    phase: "idle",
    activeTurnId: null,
    usage: null,
    modes: [],
    models: [],
    error: null,
  };
}

function eventText(event: { delta?: string; text?: string; content?: string }): string {
  return event.delta ?? event.text ?? event.content ?? "";
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
    input: tool.input ?? tool.arguments ?? existing?.input,
    output: tool.output ?? tool.result ?? tool.update ?? existing?.output,
    diff: tool.diff ?? existing?.diff,
    locations: tool.locations ?? existing?.locations,
    error: tool.error ? payloadError(tool.error, "Werkzeug fehlgeschlagen") : existing?.error,
    turnId: envelope.turnId,
    timestamp: existing?.timestamp ?? envelope.timestamp,
    seq: envelope.seq,
  };

  if (existingIndex < 0) {
    return { ...state, items: [...state.items, nextTool] };
  }

  const items = [...state.items];
  items[existingIndex] = nextTool;
  return { ...state, items };
}

function applyEnvelope(state: ChatState, envelope: StreamEnvelope): ChatState {
  if (state.sessionId && envelope.sessionId !== state.sessionId) return state;

  const event = envelope.event;
  let next = {
    ...state,
    lastSeq: envelope.seq,
  };

  switch (event.type) {
    case "session.started":
      return { ...next, phase: "running", error: null };
    case "session.ready":
      return {
        ...next,
        phase: "idle",
        modes: event.modes ?? next.modes,
        models: event.models ?? next.models,
        error: null,
      };
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
        clientRequestId: optimistic?.clientRequestId,
        turnId: envelope.turnId,
        timestamp: envelope.timestamp,
        seq: envelope.seq,
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
      const fallbackIndex = next.items.findLastIndex(
        (item) =>
          item.kind === "message" &&
          item.role === "assistant" &&
          item.turnId === envelope.turnId &&
          item.streaming,
      );
      const exactIndex = next.items.findIndex((item) => item.id === id);
      const index = exactIndex >= 0 ? exactIndex : fallbackIndex;
      const delta = eventText(event);
      if (index >= 0) {
        const items = [...next.items];
        const existing = items[index] as MessageItem;
        items[index] = { ...existing, text: existing.text + delta, seq: envelope.seq };
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
            attachments: [],
            streaming: true,
            turnId: envelope.turnId,
            timestamp: envelope.timestamp,
            seq: envelope.seq,
          },
        ],
        phase: "running",
        activeTurnId: envelope.turnId,
      };
    }
    case "message.thought.delta": {
      const id = itemId("thought", envelope, event.messageId);
      const fallbackIndex = next.items.findLastIndex(
        (item) =>
          item.kind === "thought" && item.turnId === envelope.turnId && item.streaming,
      );
      const exactIndex = next.items.findIndex((item) => item.id === id);
      const index = exactIndex >= 0 ? exactIndex : fallbackIndex;
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
          selectedOptionId: event.optionId,
          seq: envelope.seq,
        };
      });
      return { ...next, items, phase: "running" };
    }
    case "usage.updated": {
      // ACP reports context-window usage as used/size, while older persisted
      // envelopes only contain the token counters. Keeping both shapes here
      // lets the renderer show every value it actually receives without
      // guessing a context-window size.
      const usageEvent: {
        inputTokens?: number | null;
        outputTokens?: number | null;
        totalTokens?: number | null;
        used?: number | null;
        size?: number | null;
        cost?: { amount: number; currency: string } | null;
      } = event;
      return {
        ...next,
        usage: {
          inputTokens: usageEvent.inputTokens ?? undefined,
          outputTokens: usageEvent.outputTokens ?? undefined,
          totalTokens: usageEvent.totalTokens ?? usageEvent.used ?? undefined,
          used: usageEvent.used ?? usageEvent.totalTokens ?? undefined,
          size: usageEvent.size ?? undefined,
          cost: usageEvent.cost ?? undefined,
        },
      };
    }
    case "turn.completed":
      return {
        ...next,
        items: closeStreamingItems(next.items),
        phase: "idle",
        activeTurnId: null,
        error: null,
      };
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
          },
        ],
        phase: "idle",
        activeTurnId: null,
      };
    case "turn.failed": {
      const message = payloadError(event.error, "Der Turn ist fehlgeschlagen.");
      return {
        ...next,
        items: [
          ...closeStreamingItems(next.items),
          {
            id: `failed:${envelope.seq}`,
            kind: "notice",
            tone: "error",
            text: message,
            turnId: envelope.turnId,
            timestamp: envelope.timestamp,
            seq: envelope.seq,
          },
        ],
        phase: "error",
        activeTurnId: null,
        error: message,
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
          },
        ],
        phase: "disconnected",
        activeTurnId: null,
        error: message,
      };
    }
    case "commands.updated":
      return next;
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "reset":
      return createChatState(action.sessionId);
    case "events": {
      const events = [...action.events]
        .filter(
          (event) =>
            event.seq > state.lastSeq &&
            (!state.sessionId || event.sessionId === state.sessionId),
        )
        .sort((a, b) => a.seq - b.seq);
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
