#!/usr/bin/env node

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("0.56.0\n");
  process.exit(0);
}

if (args.includes("--help")) {
  process.stdout.write(`Usage: gemini [options]\n
  --acp
  --skip-trust
  --include-directories <path>
  --resume <session>
  --list-sessions
  --delete-session <session>
  --approval-mode <mode>\n`);
  process.exit(0);
}

if (!args.includes("--acp")) {
  process.stderr.write("fake agent requires --acp\n");
  process.exit(2);
}

trace({
  kind: "spawn",
  argv: args,
  cwd: process.cwd(),
  noRelaunch: process.env.GEMINI_CLI_NO_RELAUNCH,
});

if (process.env.FAKE_ACP_EXIT_BEFORE_INIT === "1") {
  process.stderr.write("authentication is required\n");
  process.exit(19);
}

let inputBuffer = "";
let nextPermissionId = 1;
const pendingClientResponses = new Map();
const pendingCancelledPrompts = new Map();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  for (;;) {
    const newline = inputBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = inputBuffer.slice(0, newline).replace(/\r$/, "");
    inputBuffer = inputBuffer.slice(newline + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      process.stderr.write(`invalid json from client: ${String(error)}\n`);
      process.exit(3);
    }
    trace({ kind: "inbound", message });
    void handleMessage(message);
  }
});

process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

async function handleMessage(message) {
  if (!("method" in message)) {
    const pending = pendingClientResponses.get(String(message.id));
    if (pending) {
      pendingClientResponses.delete(String(message.id));
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
    return;
  }

  const params = message.params ?? {};
  switch (message.method) {
    case "initialize": {
      respond(message.id, {
        protocolVersion: Number(process.env.FAKE_ACP_PROTOCOL_VERSION ?? 1),
        agentCapabilities: {
          loadSession: process.env.FAKE_ACP_NO_LOAD !== "1",
          promptCapabilities: {
            image: process.env.FAKE_ACP_NO_IMAGE !== "1",
            audio: true,
            embeddedContext: true,
          },
          mcpCapabilities: { http: true, sse: true },
        },
        authMethods: [
          { id: "fake-google", name: "Sign in with Google", type: "agent" },
        ],
        agentInfo: { name: "fake-gemini", title: "Fake Gemini", version: "0.56.0" },
      });
      return;
    }
    case "session/new": {
      respond(message.id, {
        sessionId: process.env.FAKE_ACP_SESSION_ID ?? "fake-session-1",
        modes: modes("default"),
        configOptions: modelOptions("gemini-2.5-pro"),
      });
      return;
    }
    case "session/load": {
      notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "restored question" },
          messageId: "history-user-1",
        },
      });
      notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "restored answer" },
          messageId: "history-agent-1",
        },
      });
      respond(message.id, {
        modes: modes("default"),
        configOptions: modelOptions("gemini-2.5-pro"),
      });
      return;
    }
    case "session/prompt": {
      const text = params.prompt
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (text.includes("crash")) {
        process.stderr.write(
          `before-crash GEMINI_API_KEY=${process.env.GEMINI_API_KEY ?? "super-secret"}\n`,
        );
        setTimeout(() => process.exit(17), 5);
        return;
      }
      if (text.includes("cancel")) {
        notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "working" },
            messageId: "cancel-message",
          },
        });
        pendingCancelledPrompts.set(params.sessionId, message.id);
        return;
      }
      if (text.includes("stream")) {
        await streamPermissionTurn(message.id, params.sessionId);
        return;
      }

      const imageCount = params.prompt.filter((part) => part.type === "image").length;
      notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: imageCount ? `received ${imageCount} image` : `echo: ${text}`,
          },
          messageId: "echo-message",
        },
      });
      respond(message.id, { stopReason: "end_turn", ...promptUsagePayload() });
      return;
    }
    case "session/cancel": {
      const promptId = pendingCancelledPrompts.get(params.sessionId);
      if (promptId !== undefined) {
        pendingCancelledPrompts.delete(params.sessionId);
        respond(promptId, { stopReason: "cancelled" });
      }
      return;
    }
    case "session/set_mode": {
      respond(message.id, {});
      notify("session/update", {
        sessionId: params.sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId },
      });
      return;
    }
    case "session/set_config_option": {
      if (params.configId !== "model") {
        respond(message.id, { configOptions: modelOptions("gemini-2.5-pro") });
        return;
      }
      respond(message.id, { configOptions: modelOptions(params.value) });
      notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: modelOptions(params.value),
        },
      });
      return;
    }
    case "authenticate": {
      respond(message.id, {});
      return;
    }
    default:
      if (message.id !== undefined) {
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Unknown method ${message.method}` },
        });
      }
  }
}

function modelOptions(currentValue) {
  return [{
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue,
    options: [
      { value: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { value: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    ],
  }];
}

async function streamPermissionTurn(promptId, sessionId) {
  await notify(
    "session/update",
    {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "first " },
        messageId: "stream-message",
      },
    },
    true,
  );
  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "considering edit" },
      messageId: "thought-message",
    },
  });
  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Edit example.txt",
      name: "replace",
      kind: "edit",
      status: "pending",
      content: [
        {
          type: "diff",
          path: "example.txt",
          oldText: "old",
          newText: "new",
        },
      ],
      rawInput: { path: "example.txt" },
    },
  });

  const permission = await requestClient("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: "tool-1",
      title: "Edit example.txt",
      kind: "edit",
      status: "pending",
      content: [
        {
          type: "diff",
          path: "example.txt",
          oldText: "old",
          newText: "new",
        },
      ],
    },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });

  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: permission,
    },
  });
  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "second" },
      messageId: "stream-message",
    },
  });
  if (usageMode() === "acp_full") {
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: 10,
        size: 100,
      },
    });
  }
  respond(promptId, { stopReason: "end_turn", ...promptUsagePayload() });
}

/**
 * Which usage dialect this fake agent speaks.
 *
 * `gemini_056` is the default because it is what the currently supported
 * Gemini CLI actually sends: no usage_update, no PromptResponse.usage, only the
 * proprietary `_meta.quota` block. Tests that rely on a fully implemented ACP
 * agent must opt into `acp_full` explicitly.
 */
function usageMode() {
  return process.env.FAKE_ACP_USAGE_MODE ?? "gemini_056";
}

function promptUsagePayload() {
  switch (usageMode()) {
    case "acp_full":
      return { usage: { totalTokens: 10, inputTokens: 4, outputTokens: 6 } };
    case "none":
      return {};
    default:
      return {
        _meta: {
          quota: {
            token_count: { input_tokens: 4, output_tokens: 6 },
            model_usage: [
              {
                model: "gemini-2.5-pro",
                token_count: { input_tokens: 4, output_tokens: 6 },
              },
            ],
          },
        },
      };
  }
}

function modes(currentModeId) {
  return {
    currentModeId,
    availableModes: [
      { id: "default", name: "Default", description: "Ask before changes" },
      { id: "auto_edit", name: "Auto Edit" },
    ],
  };
}

function requestClient(method, params) {
  const id = `fake-permission-${nextPermissionId++}`;
  write({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    pendingClientResponses.set(id, { resolve, reject });
  });
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function notify(method, params, split = false) {
  return write({ jsonrpc: "2.0", method, params }, split);
}

function write(message, split = false) {
  trace({ kind: "outbound", message });
  const line = `${JSON.stringify(message)}\n`;
  if (!split) {
    process.stdout.write(line);
    return Promise.resolve();
  }
  const splitAt = Math.max(1, Math.floor(line.length / 2));
  process.stdout.write(line.slice(0, splitAt));
  return new Promise((resolveWrite) => {
    setImmediate(() => {
      process.stdout.write(line.slice(splitAt));
      resolveWrite();
    });
  });
}

function trace(entry) {
  const traceFile = process.env.FAKE_ACP_TRACE_FILE;
  if (traceFile) appendFileSync(traceFile, `${JSON.stringify(entry)}\n`, "utf8");
}
