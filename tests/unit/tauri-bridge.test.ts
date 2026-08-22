import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class Channel {},
  invoke: invokeMock,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import {
  createTauriBridge,
  TAURI_COMMANDS,
} from "../../frontend/renderer/tauri-bridge";
import { IPC_CHANNELS } from "../../frontend/shared/contracts";

describe("Tauri IPC bridge", () => {
  it("normalizes hyphenated domains and actions to Rust command names", () => {
    expect(TAURI_COMMANDS[IPC_CHANNELS.listContextAttachments]).toBe(
      "context_attachments_list",
    );
    expect(TAURI_COMMANDS[IPC_CHANNELS.closeLinkPreviewView]).toBe(
      "link_preview_close",
    );
    expect(Object.values(TAURI_COMMANDS)).not.toContainEqual(
      expect.stringContaining("-"),
    );
    expect(new Set(Object.values(TAURI_COMMANDS)).size).toBe(
      Object.values(TAURI_COMMANDS).length,
    );
  });

  it("keeps all 96 invoke commands, Rust manifest and capability commands identical", () => {
    const buildSource = readFileSync(
      resolve(process.cwd(), "src/build.rs"),
      "utf8",
    );
    const manifestBlock = buildSource.match(
      /const APP_COMMANDS:.*?= &\[(.*?)\];/s,
    )?.[1];
    const manifestCommands = [...(manifestBlock?.matchAll(/"([a-z0-9_]+)"/g) ?? [])]
      .map((match) => match[1]);

    const permissionSource = readFileSync(
      resolve(process.cwd(), "src/permissions/main.toml"),
      "utf8",
    );
    const permissionBlock = permissionSource.match(
      /commands\.allow = \[(.*?)\]/s,
    )?.[1];
    const permissionCommands = [...(permissionBlock?.matchAll(/"([a-z0-9_]+)"/g) ?? [])]
      .map((match) => match[1]);
    const pushEvents = new Set([
      "context_attachments_changed",
      "events_session_batch",
      "git_project_status_changed",
      "gitlab_review_state_changed",
      "todos_changed",
    ]);
    const bridgeCommands = Object.values(TAURI_COMMANDS)
      .filter((command) => !pushEvents.has(command))
      .sort();

    expect(Object.values(TAURI_COMMANDS)).toHaveLength(101);
    expect(bridgeCommands).toHaveLength(96);
    expect(manifestCommands.sort()).toEqual(bridgeCommands);
    expect(permissionCommands.sort()).toEqual(bridgeCommands);
  });

  it("omits input for commands with an empty request contract", async () => {
    invokeMock.mockImplementation(async (command: unknown) => {
      switch (command) {
        case "get_capabilities":
        case "settings_choose_gemini_binary":
        case "settings_choose_git_binary":
          return {
            appVersion: "0.11.0",
            platform: "darwin",
            gemini: {
              available: false,
              binaryPath: null,
              version: null,
              acp: false,
              sessionLoad: false,
              images: false,
              modes: false,
              models: false,
              maxAdditionalRoots: 5,
            },
            git: { available: false, binaryPath: null, version: null },
          };
        case "app_check_for_updates":
          return {
            currentVersion: "0.11.0",
            latestVersion: null,
            updateAvailable: false,
          };
        case "link_preview_close":
          return { ok: true };
        case "gitlab_list_connections":
        case "jira_list_configs":
          return [];
        default:
          throw new Error(`unexpected command ${String(command)}`);
      }
    });

    const api = createTauriBridge();
    await api.getCapabilities();
    await api.app.checkForUpdates();
    await api.settings.chooseGeminiBinary();
    await api.settings.chooseGitBinary();
    await api.linkPreview.close();
    await api.gitlab.listConnections();
    await api.jira.listConfigs();

    expect(invokeMock.mock.calls.map(([, args]) => args)).toEqual([
      {},
      {},
      {},
      {},
      {},
      {},
      {},
    ]);
  });
});
