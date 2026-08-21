// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/app/App";
import type {
  AppCapabilities,
  AppProject,
  AppSession,
  GemUiDesktopApi,
  StreamEnvelope,
} from "../../src/renderer/types";

const capabilities: AppCapabilities = {
  appVersion: "0.1.0",
  platform: "darwin",
  gemini: {
    available: true,
    binaryPath: "/usr/local/bin/gemini",
    version: "0.56.0",
    acp: true,
    images: true,
    sessionLoad: true,
    modes: true,
    models: false,
    maxAdditionalRoots: 5,
  },
  git: {
    available: true,
    binaryPath: "/usr/bin/git",
    version: "2.50.1",
  },
};

const project: AppProject = {
  id: "project-1",
  name: "Portal",
  primaryRootId: "root-1",
  rootRevision: 1,
  rootFingerprint: "0".repeat(64),
  approvalModeId: null,
  approvalModeState: "gemini_default",
  archived: false,
  roots: [
    { id: "root-1", projectId: "project-1", kind: "primary", path: "/work/portal", realPath: "/work/portal", label: "portal", sortOrder: 0, createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-20T10:00:00.000Z" },
    { id: "root-2", projectId: "project-1", kind: "additional", path: "/shared/design", realPath: "/shared/design", label: "design", sortOrder: 1, createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-20T10:00:00.000Z" },
  ],
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:00.000Z",
};

const session: AppSession = {
  id: "session-1",
  provider: "gemini-cli",
  providerSessionId: "provider-session-1",
  projectId: project.id,
  lastRootRevision: 1,
  lastRootFingerprint: "0".repeat(64),
  title: "Login reparieren",
  status: "idle",
  model: null,
  mode: "default",
  availableModes: [{ id: "default", name: "Default" }, { id: "auto_edit", name: "Auto Edit" }],
  pinned: false,
  archived: false,
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:00.000Z",
};

function createApi(options: { projects?: AppProject[]; sessions?: AppSession[] } = {}) {
  let subscriber: ((events: StreamEnvelope[]) => void) | undefined;
  const api: GemUiDesktopApi = {
    getCapabilities: vi.fn().mockResolvedValue(capabilities),
    projects: {
      list: vi.fn().mockResolvedValue(options.projects ?? [project]),
      get: vi.fn().mockResolvedValue(project),
      reauthorizeRoot: vi.fn().mockResolvedValue({ status: "cancelled" }),
      getApprovalPolicy: vi.fn().mockResolvedValue({
        projectId: project.id,
        modeId: null,
        state: "gemini_default",
        currentModeId: null,
        availableModes: [],
        message: null,
      }),
      pickFolders: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(async (input) => ({
        ...project,
        id: "created-project",
        name: input.name,
        roots: [
          { id: "created-root-1", kind: "primary", path: input.primaryRootPath, label: "app" },
          ...input.additionalRootPaths.map((path: string, index: number) => ({ id: `created-root-${index + 2}`, kind: "additional" as const, path, label: "root" })),
        ],
      })),
      rename: vi.fn().mockResolvedValue(project),
      setArchived: vi.fn().mockResolvedValue(project),
      setAdditionalRoots: vi.fn().mockResolvedValue(project),
      setApprovalPolicy: vi.fn().mockResolvedValue({
        projectId: project.id,
        modeId: null,
        state: "gemini_default",
        currentModeId: null,
        availableModes: [],
        message: null,
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    sessions: {
      list: vi.fn().mockResolvedValue(options.sessions ?? [session]),
      create: vi.fn().mockResolvedValue(session),
      update: vi.fn().mockImplementation(async (input) => ({ ...session, ...input })),
      delete: vi.fn().mockResolvedValue(undefined),
      sendPrompt: vi.fn().mockResolvedValue({ turnId: "turn-1" }),
      cancel: vi.fn().mockResolvedValue(undefined),
      respondToPermission: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn().mockImplementation(async (input) => ({ ...session, mode: input.modeId })),
      setModel: vi.fn().mockImplementation(async (input) => ({ ...session, model: input.modelId })),
    },
    attachments: {
      pickImages: vi.fn().mockResolvedValue([]),
      stageDroppedFiles: vi.fn().mockResolvedValue([]),
      stageClipboardImage: vi.fn(),
      getPreviewBytes: vi.fn().mockResolvedValue(new Uint8Array()),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    git: {
      listProjectRepositories: vi.fn().mockResolvedValue({
        projectId: project.id,
        rootRevision: project.rootRevision,
        repositories: [],
      }),
      getProjectStatus: vi.fn().mockResolvedValue({
        projectId: project.id,
        rootRevision: project.rootRevision,
        refreshedAt: "2026-08-20T12:00:00.000Z",
        repositories: [],
        changes: [],
      }),
      getFileDiff: vi.fn(),
      subscribeProjectStatus: vi.fn().mockResolvedValue(() => undefined),
    },
    settings: {
      chooseGeminiBinary: vi.fn().mockResolvedValue(capabilities),
      chooseGitBinary: vi.fn().mockResolvedValue(capabilities),
    },
    subscribeSessionEvents: vi.fn().mockImplementation(async (_input, callback) => {
      subscriber = callback;
      return () => { subscriber = undefined; };
    }),
    openExternalHttpsUrl: vi.fn().mockResolvedValue(undefined),
  };
  return { api, emit: (events: StreamEnvelope[]) => subscriber?.(events) };
}

afterEach(() => cleanup());

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("confirm", vi.fn(() => true));
});

describe("Renderer UI", () => {
  it("macht Git-Änderungen auch ohne angelegte Chat-Session erreichbar", async () => {
    const user = userEvent.setup();
    const { api } = createApi({ sessions: [] });
    vi.mocked(api.git.subscribeProjectStatus).mockImplementation(async (_input, callback) => {
      callback({
        projectId: project.id,
        rootRevision: project.rootRevision,
        refreshedAt: "2026-08-21T12:00:00.000Z",
        repositories: [{
          repositoryId: "10000000-0000-4000-8000-000000000001",
          rootIds: [project.roots[0]!.id],
          displayName: "portal",
          worktreeLabel: "portal",
          branch: "main",
          headOid: "a".repeat(40),
          upstream: null,
          ahead: 0,
          behind: 0,
          state: "ready",
          message: null,
        }],
        changes: [],
      });
      return () => undefined;
    });
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Starte eine neue Session" });
    await user.click(screen.getByRole("button", { name: "Änderungen" }));
    expect(await screen.findByText("Arbeitsverzeichnis sauber")).toBeVisible();
  });

  it("öffnet den read-only Changes-Viewer, trennt staged/unstaged und hält den Composer sichtbar", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    const repositoryId = "10000000-0000-4000-8000-000000000001";
    const fileId = "20000000-0000-4000-8000-000000000002";
    const gitStatus = {
      projectId: project.id,
      rootRevision: project.rootRevision,
      refreshedAt: "2026-08-21T12:00:00.000Z",
      repositories: [{
        repositoryId,
        rootIds: [project.roots[0]!.id],
        displayName: "portal",
        worktreeLabel: "portal",
        branch: "main",
        headOid: "a".repeat(40),
        upstream: "origin/main",
        ahead: 1,
        behind: 0,
        state: "ready" as const,
        message: null,
      }],
      changes: [{
        fileId,
        repositoryId,
        path: "src/auth.ts",
        previousPath: null,
        indexStatus: "M",
        worktreeStatus: "M",
        conflict: false,
        untracked: false,
        submodule: false,
        renameScore: null,
      }],
    };
    vi.mocked(api.git.subscribeProjectStatus).mockImplementation(async (_input, callback) => {
      callback(gitStatus);
      return () => undefined;
    });
    vi.mocked(api.git.getFileDiff).mockResolvedValue({
      snapshotId: "30000000-0000-4000-8000-000000000003",
      repositoryId,
      fileId,
      area: "unstaged",
      path: "src/auth.ts",
      previousPath: null,
      state: "text",
      message: null,
      additions: 1,
      deletions: 1,
      metadata: ["index 1234567..7654321 100644"],
      hunks: [{
        hunkId: "d".repeat(64),
        header: "@@ -1,2 +1,2 @@",
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [
          { kind: "deletion", content: "const oldValue = 1;", oldLine: 1, newLine: null },
          { kind: "addition", content: "const newValue = 2;", oldLine: null, newLine: 1 },
        ],
      }],
    });
    window.gemUi = api;

    render(<App />);
    const composer = await screen.findByRole("textbox", { name: "Nachricht an Gemini" });
    await user.click(screen.getByRole("button", { name: "Änderungen öffnen" }));

    expect(await screen.findByRole("complementary", { name: "Git-Änderungen" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Vorgemerkt: Diff für src/auth.ts" })).toBeVisible();
    const unstaged = screen.getByRole("button", { name: "Änderungen: Diff für src/auth.ts" });
    await user.click(unstaged);

    expect(await screen.findByText("const newValue = 2;")).toBeVisible();
    expect(screen.getByText("const oldValue = 1;")).toBeVisible();
    expect(composer).toBeVisible();
    expect(api.git.getFileDiff).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId,
      fileId,
      area: "unstaged",
    }));
  });

  it("legt ein Multi-Root-Projekt über den nativen Ordner-Picker an", async () => {
    const user = userEvent.setup();
    const { api } = createApi({ projects: [], sessions: [] });
    vi.mocked(api.projects.pickFolders)
      .mockResolvedValueOnce([
        { path: "/work/app", label: "app" },
        { path: "/elsewhere/shared", label: "shared" },
      ]);
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Dein erster Workspace" });
    await user.click(within(screen.getByRole("main")).getByRole("button", { name: "Projekt anlegen" }));
    const dialog = await screen.findByRole("dialog", { name: "Neues Projekt" });
    await user.click(within(dialog).getByRole("button", { name: /Hauptordner auswählen/ }));

    expect(within(dialog).getByDisplayValue("app")).toBeVisible();
    expect(within(dialog).getByText("shared")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Projekt anlegen" }));

    await waitFor(() => expect(api.projects.create).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.projects.create).mock.calls[0]?.[0]).toMatchObject({
      name: "app",
      primaryRootPath: "/work/app",
      additionalRootPaths: ["/elsewhere/shared"],
    });
  });

  it("sendet per Enter, rendert Stream-Markdown und beantwortet die exakte Permission-optionId", async () => {
    const user = userEvent.setup();
    const { api, emit } = createApi();
    window.gemUi = api;
    render(<App />);

    const composer = await screen.findByRole("textbox", { name: "Nachricht an Gemini" });
    await user.type(composer, "Bitte prüfe den Login{Enter}");
    await waitFor(() => expect(api.sessions.sendPrompt).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.sessions.sendPrompt).mock.calls[0]?.[0]).toMatchObject({
      sessionId: "session-1",
      text: "Bitte prüfe den Login",
      attachmentIds: [],
    });
    expect(composer).toBeVisible();
    expect(composer).toBeEnabled();
    expect(screen.getByRole("button", { name: "Antwort stoppen" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Nachricht senden" })).not.toBeInTheDocument();
    await user.type(composer, "Nächsten Schritt vorbereiten");
    expect(composer).toHaveValue("Nächsten Schritt vorbereiten");

    act(() => {
      emit([
        {
          seq: 1,
          sessionId: "session-1",
          turnId: "turn-1",
          timestamp: "2026-08-20T12:00:01.000Z",
          event: { type: "message.assistant.delta", messageId: "assistant-1", delta: "**Gefunden:** ein Fehler." },
        },
        {
          seq: 2,
          sessionId: "session-1",
          turnId: "turn-1",
          timestamp: "2026-08-20T12:00:02.000Z",
          event: {
            type: "permission.requested",
            requestId: "permission-7",
            toolCallId: null,
            title: "auth.ts ändern",
            options: [
              { optionId: "allow-option-42", label: "Einmal erlauben", kind: "allow_once" },
              { optionId: "reject-option-9", label: "Ablehnen", kind: "reject_once" },
            ],
          },
        },
      ]);
    });

    expect(await screen.findByText("Gefunden:")).toBeVisible();
    expect(screen.getByText("ein Fehler.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Einmal erlauben" }));
    expect(api.sessions.respondToPermission).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      requestId: "permission-7",
      optionId: "allow-option-42",
    }));

    await user.click(screen.getByRole("button", { name: "Antwort stoppen" }));
    expect(api.sessions.cancel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1" }));

    act(() => {
      emit([{
        seq: 3,
        sessionId: "session-1",
        turnId: "turn-1",
        timestamp: "2026-08-20T12:00:03.000Z",
        event: { type: "turn.cancelled", reason: null },
      }]);
    });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Nachricht an Gemini" })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: "Nachricht an Gemini" })).toHaveValue("Nächsten Schritt vorbereiten");
  });

  it("zeigt das gemeldete Modell, erlaubt capability-gated Wechsel und aktualisiert Kontextnutzung live", async () => {
    const user = userEvent.setup();
    const modelSession: AppSession = { ...session, model: "gemini-2.5-flash" };
    const { api, emit } = createApi({ sessions: [modelSession] });
    vi.mocked(api.getCapabilities).mockResolvedValue({
      ...capabilities,
      gemini: { ...capabilities.gemini, models: true },
    });
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Login reparieren" });

    act(() => {
      emit([
        {
          seq: 1,
          sessionId: "session-1",
          turnId: null,
          timestamp: "2026-08-20T12:00:01.000Z",
          event: {
            type: "session.ready",
            modes: ["default", "auto_edit"],
            models: ["gemini-2.5-flash", "gemini-2.5-pro"],
          },
        },
        {
          seq: 2,
          sessionId: "session-1",
          turnId: "turn-1",
          timestamp: "2026-08-20T12:00:02.000Z",
          event: {
            type: "usage.updated",
            snapshot: {
              revision: 3,
              lastTurn: null,
              session: null,
              context: { used: 2_048, size: 8_192, source: "acp_usage_update" },
              cost: { amount: 0.01, currency: "USD", source: "acp_usage_update" },
              updatedAt: "2026-08-20T12:00:02.000Z",
            },
          },
        } satisfies StreamEnvelope,
      ]);
    });

    const modelSelect = await screen.findByRole("combobox", { name: "Gemini-Modell" });
    expect(modelSelect).toHaveValue("gemini-2.5-flash");
    expect(screen.getByText("25 %")).toBeVisible();
    expect(screen.getByText("25 %").closest(".usage-pill")?.getAttribute("title")).toContain(
      "2.048 von 8.192 Token belegt",
    );

    await user.selectOptions(modelSelect, "gemini-2.5-pro");
    await waitFor(() => expect(api.sessions.setModel).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      modelId: "gemini-2.5-pro",
    })));
  });

  it("zeigt einen ehrlichen Platzhalter, solange Gemini keine Nutzung gemeldet hat", async () => {
    const { api } = createApi();
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Login reparieren" });

    // The pill stays visible: nothing reported is not the same as broken.
    expect(screen.getByText("Token: –")).toBeVisible();
    expect(screen.getByTitle(/noch keine Nutzung gemeldet/)).toBeVisible();
  });

  it("zeigt Sessionverbrauch ohne erfundene Kontextgröße und markiert Teilerfassung", async () => {
    const { api, emit } = createApi();
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Login reparieren" });

    act(() => {
      emit([
        {
          seq: 1,
          sessionId: "session-1",
          turnId: "turn-1",
          timestamp: "2026-08-20T12:00:02.000Z",
          event: {
            type: "usage.updated",
            snapshot: {
              revision: 1,
              lastTurn: {
                turnId: "turn-1",
                tokens: {
                  input: 1_234,
                  output: 567,
                  total: 1_801,
                  thought: null,
                  cachedRead: null,
                  cachedWrite: null,
                  tool: null,
                  totalKind: "derived_input_plus_output",
                },
                byModel: [{ model: "gemini-2.5-pro", input: 1_234, output: 567 }],
                source: "gemini_meta_quota",
              },
              session: {
                tokens: {
                  input: 12_000,
                  output: 6_400,
                  total: 18_400,
                  thought: null,
                  cachedRead: null,
                  cachedWrite: null,
                  tool: null,
                  totalKind: "derived_input_plus_output",
                },
                coverage: "partial",
                source: "geminui_aggregate",
              },
              context: null,
              cost: null,
              updatedAt: "2026-08-20T12:00:02.000Z",
            },
          },
        } satisfies StreamEnvelope,
      ]);
    });

    // Input, output and cache are readable straight from the header.
    const pill = (await screen.findByText("In")).closest(".usage-pill");
    expect(pill).toBeVisible();
    expect(within(pill as HTMLElement).getByText("≥ 12.000")).toBeVisible();
    expect(within(pill as HTMLElement).getByText("≥ 6.400")).toBeVisible();
    // Gemini reports no cache tokens, so a dash appears instead of a fake zero.
    expect(within(pill as HTMLElement).getByText("Cache").nextElementSibling).toHaveTextContent("–");
    // No context window was reported, so no percentage is shown at all.
    expect(within(pill as HTMLElement).queryByText("Kontext")).not.toBeInTheDocument();

    const title = pill?.getAttribute("title") ?? "";
    expect(title).toContain("keinen Prozentwert");
    expect(title).toContain("Cache gelesen: nicht gemeldet");
    expect(title).toContain("≥ bedeutet: erfasst seit Aktivierung der Zählung");
    expect(title).toContain("aus Eingabe + Ausgabe berechnet");
    expect(title).not.toContain("Kosten");
  });

  it("zeigt bei fehlender Modell-Capability ehrlich an, dass kein Modell gemeldet wurde", async () => {
    const { api } = createApi();
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Login reparieren" });

    expect(screen.getByText("GeminUI")).toBeVisible();
    expect(screen.getByText("nicht gemeldet")).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Gemini-Modell" })).not.toBeInTheDocument();
  });

  it("zeigt lange IPC-Fehler vollständig, umbrechbar und fokussierbar", async () => {
    const user = userEvent.setup();
    const longMessage = [
      "Gemini-Prozess konnte nicht gestartet werden.",
      "Error: spawn /Applications/Gemini CLI/bin/gemini ENOENT",
      "Require stack: /ein/sehr/langer/pfad/der/nicht/abgeschnitten/werden/darf/main.cjs",
    ].join("\n");
    const { api } = createApi();
    vi.mocked(api.sessions.create).mockRejectedValue(new Error(longMessage));
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Login reparieren" });
    await user.click(screen.getByRole("button", { name: /Neue Session/ }));

    const alert = await screen.findByRole("alert");
    const details = alert.querySelector(".error-details");
    expect(details).not.toBeNull();
    expect(details).toHaveClass("error-details");
    expect(details).toHaveAttribute("tabindex", "0");
    expect(details).toHaveTextContent("Require stack: /ein/sehr/langer/pfad/der/nicht/abgeschnitten/werden/darf/main.cjs");
  });

  it("verwaltet Projektname und zusätzliche Roots über die sichere Bridge", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    vi.mocked(api.projects.pickFolders).mockResolvedValue([
      { path: "/elsewhere/api", label: "api" },
    ]);
    vi.mocked(api.projects.rename).mockResolvedValue({
      ...project,
      name: "Portal Neu",
    });
    vi.mocked(api.projects.setAdditionalRoots).mockResolvedValue({
      ...project,
      name: "Portal Neu",
      rootRevision: 2,
    });
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Login reparieren" });
    await user.click(screen.getByRole("button", { name: "Projekt bearbeiten" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Projekt bearbeiten",
    });
    const name = within(dialog).getByDisplayValue("Portal");
    await user.clear(name);
    await user.type(name, "Portal Neu");
    await user.click(within(dialog).getByRole("button", { name: "design entfernen" }));
    await user.click(within(dialog).getByRole("button", { name: /Hinzufügen/ }));
    expect(await within(dialog).findByText("api")).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", { name: "Änderungen speichern" }),
    );

    await waitFor(() => expect(api.projects.rename).toHaveBeenCalledTimes(1));
    expect(api.projects.rename).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", name: "Portal Neu" }),
    );
    expect(api.projects.setAdditionalRoots).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        expectedRootRevision: 1,
        additionalRootPaths: ["/elsewhere/api"],
      }),
    );
  });

  it("erteilt einem gespeicherten Projekt-Root den macOS-Zugriff erneut", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    vi.mocked(api.projects.reauthorizeRoot).mockResolvedValue({
      status: "authorized",
      root: project.roots[0]!,
    });
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Login reparieren" });
    await user.click(screen.getByRole("button", { name: "Projekt bearbeiten" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Projekt bearbeiten",
    });
    await user.click(
      within(dialog).getByRole("button", {
        name: "Zugriff auf portal erneut erteilen",
      }),
    );

    await waitFor(() =>
      expect(api.projects.reauthorizeRoot).toHaveBeenCalledWith({
        projectId: "project-1",
        rootId: "root-1",
      }),
    );
    expect(within(dialog).getByText("Erlaubt")).toBeVisible();
  });
});
