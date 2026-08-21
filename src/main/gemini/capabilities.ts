import type {
  InitializeResponse,
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";

import type {
  NormalizedAcpCapabilities,
  NormalizedAuthMethod,
  SessionModel,
  SessionModeSnapshot,
  SessionModelSnapshot,
} from "./types.js";

export function normalizeCapabilities(
  response: InitializeResponse,
): NormalizedAcpCapabilities {
  const capabilities = response.agentCapabilities;
  const session = capabilities?.sessionCapabilities;

  return {
    protocolVersion: response.protocolVersion,
    agent: {
      ...(response.agentInfo?.name ? { name: response.agentInfo.name } : {}),
      ...(response.agentInfo?.title ? { title: response.agentInfo.title } : {}),
      ...(response.agentInfo?.version ? { version: response.agentInfo.version } : {}),
    },
    loadSession: capabilities?.loadSession === true,
    prompt: {
      text: true,
      resourceLink: true,
      image: capabilities?.promptCapabilities?.image === true,
      audio: capabilities?.promptCapabilities?.audio === true,
      embeddedContext: capabilities?.promptCapabilities?.embeddedContext === true,
    },
    mcp: {
      stdio: true,
      http: capabilities?.mcpCapabilities?.http === true,
      sse: capabilities?.mcpCapabilities?.sse === true,
    },
    session: {
      list: session?.list != null,
      delete: session?.delete != null,
      resume: session?.resume != null,
      close: session?.close != null,
      additionalDirectories: session?.additionalDirectories != null,
    },
    authMethods: (response.authMethods ?? []).map(normalizeAuthMethod),
  };
}

export function normalizeModes(
  modes: SessionModeState | null | undefined,
): SessionModeSnapshot | undefined {
  if (!modes) return undefined;
  return {
    currentModeId: modes.currentModeId,
    availableModes: modes.availableModes.map((mode) => ({
      id: mode.id,
      name: mode.name,
      ...(mode.description ? { description: mode.description } : {}),
    })),
  };
}

export function normalizeModels(
  configOptions: readonly SessionConfigOption[] | null | undefined,
): SessionModelSnapshot | undefined {
  const modelOption = configOptions?.find(
    (option) =>
      option.type === "select" &&
      (option.category === "model" || option.id === "model"),
  );
  if (!modelOption || modelOption.type !== "select") return undefined;

  const availableModels = modelOption.options.flatMap((option) =>
    "options" in option ? option.options : [option],
  ).map((option) => ({
    id: option.value,
    name: option.name,
    ...(option.description ? { description: option.description } : {}),
  }));
  if (availableModels.length === 0) {
    return undefined;
  }
  return {
    transport: "config_option",
    configId: modelOption.id,
    currentModelId: modelOption.currentValue ?? availableModels[0]?.id ?? "",
    availableModels,
  };
}

/**
 * The pre-configOptions models payload of `session/new` and `session/load`.
 * Not part of the SDK's typed surface any more, so it is read structurally
 * from the raw response.
 */
export function normalizeLegacyModels(
  models: unknown,
): SessionModelSnapshot | undefined {
  if (!isRecord(models)) return undefined;
  const currentModelId = models["currentModelId"];
  const entries = models["availableModels"];
  if (!Array.isArray(entries)) return undefined;

  const availableModels: SessionModel[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    // Gemini CLI keys the identifier `modelId`; `id` is accepted so an agent
    // that follows the newer naming is not rejected over a field name.
    const id = firstString(entry["modelId"], entry["id"]);
    const name = firstString(entry["name"], entry["title"]) ?? id;
    if (!id || !name) continue;
    const description = firstString(entry["description"]);
    availableModels.push({
      id,
      name,
      ...(description ? { description } : {}),
    });
  }

  if (availableModels.length === 0) {
    return undefined;
  }
  return {
    transport: "legacy_models",
    configId: null,
    currentModelId:
      typeof currentModelId === "string" && currentModelId
        ? currentModelId
        : (availableModels[0]?.id ?? ""),
    availableModels,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function normalizeAuthMethod(
  method: NonNullable<InitializeResponse["authMethods"]>[number],
): NormalizedAuthMethod {
  const type = "type" in method && method.type ? method.type : "agent";
  return {
    id: method.id,
    name: method.name,
    type,
    ...(method.description ? { description: method.description } : {}),
  };
}
