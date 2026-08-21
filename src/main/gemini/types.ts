import type {
  UsageContextObservation,
  UsageTokenObservation,
} from "./usage.js";

export interface ProjectAccess {
  /** Canonical absolute path used as both process cwd and ACP session cwd. */
  readonly primaryRoot: string;
  /** Canonical absolute paths passed as repeated --include-directories flags. */
  readonly additionalRoots: readonly string[];
}

export interface GeminiCliFeatures {
  readonly acp: boolean;
  readonly includeDirectories: boolean;
  readonly resume: boolean;
  readonly listSessions: boolean;
  readonly deleteSession: boolean;
  readonly approvalMode: boolean;
}

export type GeminiBinaryProbeResult =
  | {
      readonly ok: true;
      /** Resolved path selected by the user (a .cmd npm shim on Windows). */
      readonly binaryPath: string;
      /** Shell-free executable used to start Gemini. */
      readonly executablePath: string;
      /** Arguments placed before Gemini CLI flags (the JS entry on Windows). */
      readonly executableArgs: readonly string[];
      readonly version: string;
      readonly rawVersion: string;
      readonly features: GeminiCliFeatures;
    }
  | {
      readonly ok: false;
      readonly candidate: string;
      readonly code:
        | "binary_not_found"
        | "binary_not_executable"
        | "binary_probe_failed"
        | "acp_unsupported";
      readonly message: string;
    };

export interface NormalizedAuthMethod {
  readonly id: string;
  readonly name: string;
  readonly type: "agent" | "env_var" | "terminal";
  readonly description?: string;
}

export interface NormalizedAcpCapabilities {
  readonly protocolVersion: number;
  readonly agent: {
    readonly name?: string;
    readonly title?: string;
    readonly version?: string;
  };
  readonly loadSession: boolean;
  readonly prompt: {
    readonly text: true;
    readonly resourceLink: true;
    readonly image: boolean;
    readonly audio: boolean;
    readonly embeddedContext: boolean;
  };
  readonly mcp: {
    readonly stdio: true;
    readonly http: boolean;
    readonly sse: boolean;
  };
  readonly session: {
    readonly list: boolean;
    readonly delete: boolean;
    readonly resume: boolean;
    readonly close: boolean;
    readonly additionalDirectories: boolean;
  };
  readonly authMethods: readonly NormalizedAuthMethod[];
}

export interface SessionMode {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface SessionModeSnapshot {
  readonly currentModeId: string;
  readonly availableModes: readonly SessionMode[];
}

export interface SessionModel {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/**
 * How the connected agent exposes its model list.
 *
 * `config_option` is stable ACP v1: models arrive as a `select` entry in
 * `configOptions` and are switched with `session/set_config_option`.
 *
 * `legacy_models` is the dedicated models API that ACP removed on the way to
 * v2 ("Remove dedicated session modes and models apis from v2"). Gemini CLI
 * still ships it: `session/new` and `session/load` answer with a `models`
 * object and the switch is `session/set_model`. Without this branch GeminUI
 * sees no models at all when talking to a real Gemini CLI.
 */
export type SessionModelTransport = "config_option" | "legacy_models";

interface SessionModelSnapshotBase {
  readonly currentModelId: string;
  readonly availableModels: readonly SessionModel[];
}

export type SessionModelSnapshot =
  | (SessionModelSnapshotBase & {
      readonly transport: "config_option";
      /** ACP config option ID used for session/set_config_option. */
      readonly configId: string;
    })
  | (SessionModelSnapshotBase & {
      readonly transport: "legacy_models";
      /** The legacy API addresses the model directly, without a config ID. */
      readonly configId: null;
    });

export type PromptPart =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "image";
      readonly mimeType: string;
      readonly data: string;
      readonly uri?: string;
    }
  | {
      readonly type: "audio";
      readonly mimeType: string;
      readonly data: string;
    }
  | {
      readonly type: "resource_link";
      readonly name: string;
      readonly uri: string;
      readonly mimeType?: string;
      readonly size?: number;
      readonly description?: string;
    };

export type NormalizedContent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly mimeType: string;
      readonly data: string;
      readonly uri?: string;
    }
  | {
      readonly type: "audio";
      readonly mimeType: string;
      readonly data: string;
    }
  | {
      readonly type: "resource_link";
      readonly name: string;
      readonly uri: string;
      readonly mimeType?: string;
      readonly size?: number;
      readonly description?: string;
    }
  | {
      readonly type: "resource";
      readonly resource: Readonly<Record<string, unknown>>;
    };

export interface NormalizedToolCall {
  readonly toolCallId: string;
  readonly title?: string;
  readonly name?: string;
  readonly kind?: string;
  readonly status?: "pending" | "in_progress" | "completed" | "failed";
  readonly content?: readonly unknown[];
  readonly locations?: readonly unknown[];
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
}

export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface PermissionRequest {
  readonly permissionId: string;
  readonly appSessionId: string;
  readonly providerSessionId: string;
  readonly toolCall: NormalizedToolCall;
  readonly options: readonly PermissionOption[];
}

export interface PermissionResponse {
  readonly appSessionId: string;
  readonly permissionId: string;
  /** Must be one of the exact optionIds supplied in PermissionRequest.options. */
  readonly optionId: string;
}

type Event<Type extends string, Payload> = {
  readonly type: Type;
  readonly appSessionId: string;
  readonly providerSessionId: string | null;
  readonly occurredAt: string;
  readonly payload: Payload;
};

export type NormalizedAgentEvent =
  | Event<"session.started", { readonly operation: "new" | "load" }>
  | Event<
      "session.ready",
      {
        readonly capabilities: NormalizedAcpCapabilities;
        readonly modes?: SessionModeSnapshot;
        readonly models?: SessionModelSnapshot;
      }
    >
  | Event<"session.failed", { readonly message: string }>
  | Event<"message.user", { readonly content: NormalizedContent; readonly messageId?: string }>
  | Event<
      "message.assistant.delta",
      { readonly content: NormalizedContent; readonly messageId?: string }
    >
  | Event<
      "message.thought.delta",
      { readonly content: NormalizedContent; readonly messageId?: string }
    >
  | Event<"tool.started", { readonly toolCall: NormalizedToolCall }>
  | Event<"tool.updated", { readonly toolCall: NormalizedToolCall }>
  | Event<"tool.completed", { readonly toolCall: NormalizedToolCall }>
  | Event<"tool.failed", { readonly toolCall: NormalizedToolCall }>
  | Event<"permission.requested", PermissionRequest>
  | Event<
      "permission.resolved",
      {
        readonly permissionId: string;
        readonly optionId?: string;
        readonly outcome: "selected" | "cancelled";
      }
    >
  | Event<"usage.tokens.observed", UsageTokenObservation>
  | Event<"usage.context.observed", UsageContextObservation>
  | Event<"commands.updated", { readonly commands: readonly unknown[] }>
  | Event<"mode.updated", { readonly currentModeId: string }>
  | Event<"config.updated", { readonly configOptions: readonly unknown[] }>
  | Event<"session.info.updated", { readonly title?: string | null; readonly updatedAt?: string | null }>
  | Event<"plan.updated", { readonly plan: unknown }>
  | Event<"plan.removed", { readonly planId: string }>
  | Event<
      "turn.completed",
      {
        readonly stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal";
      }
    >
  | Event<"turn.cancelled", Record<string, never>>
  | Event<"turn.failed", { readonly message: string }>
  | Event<
      "process.disconnected",
      {
        readonly exitCode: number | null;
        readonly signal: NodeJS.Signals | null;
        readonly stderr: string;
        readonly message?: string;
      }
    >;

export type AgentEventListener = (event: NormalizedAgentEvent) => void;

export interface GeminiSessionSnapshot {
  readonly appSessionId: string;
  readonly providerSessionId: string;
  readonly state:
    | "idle"
    | "running"
    | "awaiting_permission"
    | "cancelling"
    | "disconnected"
    | "disposed";
  readonly capabilities: NormalizedAcpCapabilities;
  readonly modes?: SessionModeSnapshot;
  readonly models?: SessionModelSnapshot;
  readonly pendingPermissionCount: number;
  readonly stderr: string;
}

export interface GeminiTurnResult {
  readonly stopReason:
    | "end_turn"
    | "max_tokens"
    | "max_turn_requests"
    | "refusal"
    | "cancelled";
  /** Present only when the agent actually reported token counters. */
  readonly usage?: UsageTokenObservation;
}
