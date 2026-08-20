import type {
  InitializeResponse,
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";

import type {
  NormalizedAcpCapabilities,
  NormalizedAuthMethod,
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
  if (!availableModels.some((model) => model.id === modelOption.currentValue)) {
    return undefined;
  }
  return {
    configId: modelOption.id,
    currentModelId: modelOption.currentValue,
    availableModels,
  };
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
