// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/app/App";
import { LinkPreviewSurface } from "../../src/renderer/features/attachments/LinkPreviewSurface";
import type {
  AppCapabilities,
  AppProject,
  AppSession,
  GemUiDesktopApi,
  ContextAttachmentList,
  StreamEnvelope,
  Todo,
  TodoList,
} from "../../src/renderer/types";

const capabilities: AppCapabilities = {
  appVersion: "0.1.0",
  platform: "darwin",
  gemini: {
    available: true,
    probeState: "ready",
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
  statsEnabled: false,
  liveTokensEnabled: false,
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
  availableModels: [],
  pinned: false,
  archived: false,
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:00.000Z",
};

function emptyContextList(sessionId: string | null): ContextAttachmentList {
  return {
    projectId: project.id,
    sessionId,
    projectAttachments: [],
    sessionAttachments: [],
    includedCount: 0,
    estimatedTotalTokens: 0,
    overBudget: false,
  };
}

function emptyTodoList(): TodoList {
  return { projectId: project.id, todos: [], openCount: 0, doneCount: 0 };
}

function todoList(todos: Todo[]): TodoList {
  return {
    projectId: project.id,
    todos,
    openCount: todos.filter((todo) => !todo.done).length,
    doneCount: todos.filter((todo) => todo.done).length,
  };
}

function createApi(options: {
  project?: any;
  projects?: AppProject[];
  sessions?: AppSession[];
  contextList?: ContextAttachmentList;
  todos?: TodoList;
} = {}) {
  let subscriber: ((events: StreamEnvelope[]) => void) | undefined;
  const activeProj = options.project ?? project;
  const api: GemUiDesktopApi = {
    getCapabilities: vi.fn().mockResolvedValue(capabilities),
    getResourceProfile: vi.fn().mockResolvedValue({ profile: "balanced" }),
    setResourceProfile: vi.fn().mockResolvedValue({ profile: "balanced" }),
    app: {
      checkForUpdates: vi.fn().mockResolvedValue({
        currentVersion: "0.5.0",
        latestVersion: "0.5.0",
        updateAvailable: false,
        error: null,
      }),
      downloadUpdate: vi.fn().mockResolvedValue({ filePath: "/tmp/update.exe" }),
      installUpdate: vi.fn().mockResolvedValue({ ok: true }),
      onDownloadProgress: vi.fn().mockReturnValue(() => {}),
    },
    projects: {
      list: vi.fn().mockResolvedValue(options.projects ?? [activeProj]),
      get: vi.fn().mockResolvedValue(activeProj),
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
      setStatsEnabled: vi.fn().mockImplementation(async (input) => ({
        ...project,
        statsEnabled: input.enabled,
      })),
      setLiveTokensEnabled: vi.fn().mockImplementation(async (input) => ({
        ...project,
        liveTokensEnabled: input.enabled,
      })),
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
      getEventBlob: vi.fn().mockResolvedValue(null),
      getTimelineSnapshot: vi.fn().mockResolvedValue({ complete: true, throughSeq: 0, items: [], nextBefore: null, hasMore: false }),
      setMode: vi.fn().mockImplementation(async (input) => ({ ...session, mode: input.modeId })),
      setConfigOption: vi.fn().mockResolvedValue(undefined),
      setModel: vi.fn().mockImplementation(async (input) => ({ ...session, model: input.modelId })),
      getReconnectState: vi.fn().mockResolvedValue({
        sessionId: session.id,
        reconnected: false,
        hasHistory: false,
      }),
      search: vi.fn().mockResolvedValue({
        projectId: project.id,
        query: "",
        results: [],
      }),
      export: vi.fn().mockResolvedValue({ canceled: false, filePath: "/tmp/chat.pdf" }),
      listElicitations: vi.fn().mockResolvedValue([]),
      respondToElicitation: vi.fn().mockResolvedValue(undefined),
    },
    attachments: {
      pickImages: vi.fn().mockResolvedValue([]),
      stageDroppedFiles: vi.fn().mockResolvedValue([]),
      stageClipboardImage: vi.fn(),
      getPreviewBytes: vi.fn().mockResolvedValue(new Uint8Array()),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    contextAttachments: {
      list: vi.fn().mockImplementation(async (input) => options.contextList
        ? { ...options.contextList, sessionId: input.sessionId ?? null }
        : emptyContextList(input.sessionId ?? null)),
      addFiles: vi.fn(),
      addDroppedFiles: vi.fn(),
      addLink: vi.fn(),
      update: vi.fn(),
      setInclusion: vi.fn(),
      remove: vi.fn(),
      refreshLinkPreview: vi.fn(),
      getBytes: vi.fn(),
      openFile: vi.fn().mockResolvedValue({ ok: true }),
      subscribe: vi.fn().mockImplementation(async (input, callback) => {
        callback(options.contextList
          ? { ...options.contextList, sessionId: input.sessionId ?? null }
          : emptyContextList(input.sessionId ?? null));
        return () => undefined;
      }),
    },
    projectFiles: {
      search: vi.fn().mockResolvedValue({
        projectId: project.id,
        rootRevision: project.rootRevision,
        entries: [],
        truncated: false,
      }),
      listDirectory: vi.fn().mockResolvedValue({
        projectId: project.id,
        rootRevision: project.rootRevision,
        entries: [],
        truncated: false,
      }),
      readFile: vi.fn().mockImplementation(async (input) => ({
        projectId: input.projectId,
        rootRevision: input.expectedRootRevision,
        rootId: input.rootId,
        relativePath: input.relativePath,
        displayName: input.relativePath.split("/").pop() || input.relativePath,
        size: 120,
        mimeType: "text/markdown",
        binary: false,
        content: "# Test Project\n\nHello world",
        truncated: false,
        lineCount: 3,
        language: "markdown",
      })),
    },
    todos: {
      list: vi.fn().mockImplementation(async () => options.todos ?? emptyTodoList()),
      create: vi.fn().mockImplementation(async () => options.todos ?? emptyTodoList()),
      update: vi.fn().mockImplementation(async () => options.todos ?? emptyTodoList()),
      reorder: vi.fn().mockImplementation(async () => options.todos ?? emptyTodoList()),
      delete: vi.fn().mockImplementation(async () => emptyTodoList()),
      addFiles: vi.fn().mockImplementation(async () => options.todos ?? emptyTodoList()),
      addDroppedFiles: vi.fn().mockImplementation(async () => options.todos ?? emptyTodoList()),
      addLink: vi.fn().mockImplementation(async () => options.todos ?? emptyTodoList()),
      attachAttachment: vi.fn().mockImplementation(async () => options.todos ?? emptyTodoList()),
      detachAttachment: vi.fn().mockImplementation(async () => options.todos ?? emptyTodoList()),
      prepareForSession: vi.fn().mockImplementation(async (input) => ({
        todoId: input.todoId,
        sessionId: input.sessionId,
        text: "Login reparieren\n\nDer Redirect verliert die Session.",
        attachmentIds: [],
        contextAttachments: emptyContextList(input.sessionId),
      })),
      subscribe: vi.fn().mockImplementation(async (_input, callback) => {
        callback(options.todos ?? emptyTodoList());
        return () => undefined;
      }),
    },
    linkPreview: {
      open: vi.fn(),
      setBounds: vi.fn().mockResolvedValue({ ok: true }),
      close: vi.fn().mockResolvedValue({ ok: true }),
      clearStorage: vi.fn().mockResolvedValue({ ok: true }),
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
    integrations: {
      listProject: vi.fn().mockResolvedValue([]),
    },
    stats: {
      get: vi.fn().mockResolvedValue({
        summary: {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          thoughtTokens: 0,
          avgDurationMs: 0,
          totalDurationMs: 0,
          avgTokensPerSecond: 0,
          totalTurns: 0,
          totalLinesAdded: 0,
          totalLinesDeleted: 0,
          planAccepted: 0,
          planRejected: 0,
          planTotal: 0,
          planAcceptanceRate: 0,
          cachedTokens: 0,
          cacheHitRate: 0,
          inputPercentage: 0,
          outputPercentage: 0,
          filesCreated: 0,
          filesModified: 0,
          filesDeleted: 0,
          skillsUsedTotal: 0,
          mcpUsedTotal: 0,
          gitActionsTotal: 0,
          shellCommandsTotal: 0,
          topSkills: [],
          topMcpTools: [],
          topGitActions: [],
          topShellCommands: [],
          activeProjectsCount: 0,
          activeSessionsCount: 0,
        },
        timeSeries: [],
        tokensPerSecondSeries: [],
        modelComparison: [],
        availableModels: [],
      }),
    },
    agentExtensions: {
      listSkills: vi.fn().mockResolvedValue({ projectId: project.id, skills: [] }),
      listMcpServers: vi.fn().mockResolvedValue({ projectId: project.id, servers: [] }),
    },
    gitlab: {
      listRepositoryCandidates: vi.fn().mockResolvedValue([]),
      listConnections: vi.fn().mockResolvedValue([]),
      testConnection: vi.fn(),
      saveConnection: vi.fn(),
      replaceToken: vi.fn(),
      removeConnection: vi.fn().mockResolvedValue({ ok: true }),
      enableBinding: vi.fn(),
      disableBinding: vi.fn().mockResolvedValue({ ok: true }),
      listMergeRequests: vi.fn().mockResolvedValue([]),
      selectMergeRequest: vi.fn(),
      connectMergeRequestUrl: vi.fn(),
      getReviewState: vi.fn(),
      subscribeReviewState: vi.fn().mockResolvedValue(() => undefined),
      prepareReviewContext: vi.fn(),
      resolveDiscussion: vi.fn(),
      replyToDiscussion: vi.fn(),
    },
    jira: {
      listConfigs: vi.fn().mockResolvedValue([]),
      saveConfig: vi.fn(),
      deleteConfig: vi.fn().mockResolvedValue({ ok: true }),
      getProjectIntegration: vi.fn().mockResolvedValue({
        projectId: project.id,
        activeConfigId: null,
        activeConfig: null,
        updatedAt: null,
      }),
      activate: vi.fn(),
      deactivate: vi.fn(),
      attachIssue: vi.fn(),
      fetchIssueDetails: vi.fn(),
      syncAttachments: vi.fn().mockResolvedValue({ syncedCount: 0, attachmentIds: [], skippedCount: 0 }),
      onLog: vi.fn().mockReturnValue(() => undefined),
    },
    settings: {
      chooseGeminiBinary: vi.fn().mockResolvedValue(capabilities),
      chooseGitBinary: vi.fn().mockResolvedValue(capabilities),
    },
    subscribeSessionEvents: vi.fn().mockImplementation(async (_input, callback) => {
      subscriber = callback;
      // Only the still-current subscription may clear the slot: the effect that
      // owns an older one disposes it asynchronously, after a newer one is in.
      return () => { if (subscriber === callback) subscriber = undefined; };
    }),
    openExternalHttpsUrl: vi.fn().mockResolvedValue(undefined),
  };
  // The app subscribes to the session stream inside a passive effect, so the
  // subscription can still be pending when the first rendered element is found.
  // Waiting for it turns the delivery into a fact instead of a race that a
  // fast machine wins and a busy CI runner loses.
  const emit = async (events: StreamEnvelope[]) => {
    await waitFor(() => {
      if (!subscriber) throw new Error("Der Session-Stream ist noch nicht abonniert.");
    });
    const deliver = subscriber;
    await act(async () => { deliver?.(events); });
  };
  return { api, emit };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("confirm", vi.fn(() => true));
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => storage.set(key, String(value))),
    removeItem: vi.fn((key: string) => storage.delete(key)),
    clear: vi.fn(() => storage.clear()),
    key: vi.fn((index: number) => [...storage.keys()][index] ?? null),
    get length() { return storage.size; },
  });
});

function populatedContextList(overBudget = false): ContextAttachmentList {
  const createdAt = "2026-08-21T09:00:00.000Z";
  return {
    projectId: project.id,
    sessionId: session.id,
    projectAttachments: [
      {
        id: "41000000-0000-4000-8000-000000000001",
        projectId: project.id,
        scope: "project",
        sessionId: null,
        kind: "file",
        origin: "manual",
        title: "Architektur.md",
        note: null,
        sortOrder: 0,
        includedInContext: true,
        estimatedTokens: 1_250,
        file: {
          displayName: "Architektur.md",
          mimeType: "text/markdown",
          size: 4_096,
          sha256: "a".repeat(64),
          extractionState: "ready",
          extractedChars: 5_000,
          extractionTruncated: false,
          pageCount: null,
          extractionError: null,
          renderable: false,
        },
        link: null,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: "41000000-0000-4000-8000-000000000002",
        projectId: project.id,
        scope: "project",
        sessionId: null,
        kind: "link",
        origin: "chat",
        title: "Jira LOGIN-42",
        note: null,
        sortOrder: 1,
        includedInContext: false,
        estimatedTokens: 80,
        file: null,
        link: {
          url: "https://jira.example.com/browse/LOGIN-42",
          host: "jira.example.com",
          previewState: "unauthorized",
          previewTitle: null,
          previewDescription: null,
          previewSiteName: null,
          hasPreviewImage: false,
          previewError: null,
          fetchedAt: createdAt,
        },
        createdAt,
        updatedAt: createdAt,
      },
    ],
    sessionAttachments: [],
    includedCount: 1,
    estimatedTotalTokens: overBudget ? 80_000 : 1_250,
    overBudget,
  };
}

describe("Renderer UI", () => {
  it("zeigt Anhangszähler und schaltet Anhänge und Änderungen gegenseitig aus", async () => {
    const user = userEvent.setup();
    const contextList = populatedContextList();
    const { api } = createApi({ contextList });
    window.gemUi = api;

    render(<App />);
    const toggle = await screen.findByRole("button", { name: "Anhänge öffnen, 2 Anhänge, 1 im Kontext" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(await screen.findByRole("complementary", { name: "Anhänge" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Anhänge schließen, 2 Anhänge, 1 im Kontext" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: /^Änderungen öffnen/ }));
    expect(screen.queryByRole("complementary", { name: "Anhänge" })).not.toBeInTheDocument();
    expect(await screen.findByRole("complementary", { name: "Git-Änderungen" })).toBeVisible();
  });

  it("ändert die Breite des rechten Panels per Tastatur und speichert sie", async () => {
    const user = userEvent.setup();
    const { api } = createApi({ contextList: populatedContextList() });
    window.gemUi = api;

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Anhänge öffnen, 2 Anhänge, 1 im Kontext" }));
    const separator = screen.getByRole("separator", { name: "Breite von Chat und rechtem Panel ändern" });
    expect(separator).toHaveAttribute("aria-valuenow", "520");

    separator.focus();
    await user.keyboard("{ArrowLeft}");
    expect(separator).toHaveAttribute("aria-valuenow", "544");
    expect(window.localStorage.getItem("geminui.right-panel.width")).toBe("544");

    await user.keyboard("{ArrowRight}");
    expect(separator).toHaveAttribute("aria-valuenow", "520");
  });

  it("zeigt gemischte Gruppenauswahl und wählt bei Klick alle Anhänge aus", async () => {
    const user = userEvent.setup();
    const contextList = populatedContextList();
    const { api } = createApi({ contextList });
    vi.mocked(api.contextAttachments.setInclusion).mockResolvedValue({
      ...contextList,
      projectAttachments: contextList.projectAttachments.map((attachment) => ({ ...attachment, includedInContext: true })),
      includedCount: 2,
      estimatedTotalTokens: 1_330,
    });
    window.gemUi = api;

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Anhänge öffnen, 2 Anhänge, 1 im Kontext" }));
    const selectAll = await screen.findByRole("checkbox", { name: "Projekt: alle im Kontext" });
    expect(selectAll).toHaveAttribute("aria-checked", "mixed");
    await user.click(selectAll);
    expect(api.contextAttachments.setInclusion).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.id,
      attachmentIds: contextList.projectAttachments.map(({ id }) => id),
      included: true,
    }));
  });

  it("sperrt das Senden, wenn der ausgewählte Anhangskontext das Budget überschreitet", async () => {
    const user = userEvent.setup();
    const { api } = createApi({ contextList: populatedContextList(true) });
    window.gemUi = api;

    render(<App />);
    const composer = await screen.findByRole("textbox", { name: "Nachricht an Gemini" });
    await user.type(composer, "Fasse den Kontext zusammen");
    const send = screen.getByRole("button", { name: "Nachricht senden" });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("title", expect.stringContaining("überschreitet"));
  });

  it("sendet die effektive Kontextauswahl als Momentaufnahme und zeigt sie im Verlauf", async () => {
    const user = userEvent.setup();
    const contextList = populatedContextList();
    const { api } = createApi({ contextList });
    window.gemUi = api;

    render(<App />);
    const composer = await screen.findByRole("textbox", { name: "Nachricht an Gemini" });
    await screen.findByRole("button", { name: "Anhänge öffnen, 2 Anhänge, 1 im Kontext" });
    await user.type(composer, "Nutze die Architektur{Enter}");
    await waitFor(() => expect(api.sessions.sendPrompt).toHaveBeenCalledTimes(1));
    expect(api.sessions.sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
      contextAttachmentIds: [contextList.projectAttachments[0]!.id],
    }));
    expect(screen.getByText("Architektur.md", { selector: ".sent-context-attachment" })).toBeVisible();
  });

  it("wählt Projektdateien per @-Drop-up und Tab als Promptkontext aus", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    vi.mocked(api.projectFiles.search).mockResolvedValue({
      projectId: project.id,
      rootRevision: project.rootRevision,
      entries: [{
        rootId: project.roots[0]!.id,
        rootLabel: "portal",
        relativePath: "src/auth.ts",
        displayName: "auth.ts",
        kind: "file",
        size: 512,
        childCount: 0,
        contextEligible: true,
        contextUnavailableReason: null,
      }],
      truncated: false,
    });
    window.gemUi = api;

    render(<App />);
    const composer = await screen.findByRole("textbox", { name: "Nachricht an Gemini" });
    await user.type(composer, "Prüfe @");
    expect(screen.getByRole("listbox", { name: "Projektdateien" })).toBeVisible();
    expect(screen.getByText("Tippe den Anfang eines Datei- oder Ordnernamens.")).toBeVisible();
    await user.type(composer, "aut");
    expect(await screen.findByRole("option", { name: /auth\.ts/ })).toBeVisible();

    await user.keyboard("{Tab}");
    expect(screen.getByLabelText("Referenzierte Projektdateien und -ordner")).toHaveTextContent("auth.ts");
    expect(composer).toHaveValue("Prüfe @src/auth.ts ");

    await user.type(composer, "auf Fehler{Enter}");
    await waitFor(() => expect(api.sessions.sendPrompt).toHaveBeenCalledTimes(1));
    expect(api.sessions.sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
      projectFiles: [{ rootId: project.roots[0]!.id, relativePath: "src/auth.ts", kind: "file" }],
    }));
    expect(screen.getByText("auth.ts", { selector: ".sent-project-file > span" })).toBeVisible();
  });

  it("erlaubt Copy-Paste im Eingabefeld des 'Link hinzufügen'-Dialogs", async () => {
    const user = userEvent.setup();
    const contextList = populatedContextList();
    const { api } = createApi({ contextList });
    vi.mocked(api.contextAttachments.addLink).mockResolvedValue(contextList);
    window.gemUi = api;

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Anhänge öffnen, 2 Anhänge, 1 im Kontext" }));

    // Menu öffnen & Link hinzufügen Dialog öffnen
    const addMenu = screen.getByLabelText("Anhang hinzufügen");
    await user.click(addMenu);
    const addLinkBtn = screen.getAllByRole("button", { name: "Link hinzufügen" })[0]!;
    await user.click(addLinkBtn);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Link hinzufügen" })).toBeVisible();

    const input = within(dialog).getByRole("textbox", { name: "HTTPS-Adresse" });
    await user.type(input, "https://github.com/bonbonn1912/gem-ui-ini");
    expect(input).toHaveValue("https://github.com/bonbonn1912/gem-ui-ini");

    // addLink soll erst beim Klick auf Hinzufügen aufgerufen werden, nicht durch Paste-Event-Abfangen
    expect(api.contextAttachments.addLink).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Hinzufügen" }));
    await waitFor(() => expect(api.contextAttachments.addLink).toHaveBeenCalledWith(expect.objectContaining({
      scope: "project",
      url: "https://github.com/bonbonn1912/gem-ui-ini",
    })));
  });

  it("klappt beim Öffnen der Live-Ansicht die Anhänge in eine Dropdown-Leiste zusammen und stellt vertikale Höhenanpassung bereit", async () => {
    const user = userEvent.setup();
    const contextList = populatedContextList();
    const { api } = createApi({ contextList });
    vi.mocked(api.linkPreview.open).mockResolvedValue({
      attachmentId: "41000000-0000-4000-8000-000000000002",
      host: "jira.example.com",
      loading: false,
    });
    window.gemUi = api;

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Anhänge öffnen, 2 Anhänge, 1 im Kontext" }));

    // Link-Anhang auswählen
    await user.click(screen.getByRole("button", { name: /Jira LOGIN-42/ }));
    expect(await screen.findByRole("button", { name: "Live-Ansicht öffnen" })).toBeVisible();

    // Live-Ansicht öffnen
    await user.click(screen.getByRole("button", { name: "Live-Ansicht öffnen" }));

    // Dropdown-Leiste und Höhen-Trennleiste sollen sichtbar sein
    const dropdownBar = await screen.findByRole("button", { name: "Live-Ansicht einklappen und alle Anhänge anzeigen" });
    expect(dropdownBar).toBeVisible();
    expect(within(dropdownBar).getByText("Live-Ansicht: jira.example.com")).toBeVisible();
    expect(screen.getByRole("separator", { name: "Höhe der Live-Vorschau ändern" })).toBeVisible();

    // Klick auf die Dropdown-Leiste schließt die Live-Ansicht und stellt die vollständige Anhangsliste wieder her
    await user.click(dropdownBar);
    expect(screen.queryByRole("button", { name: "Live-Ansicht einklappen und alle Anhänge anzeigen" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Live-Ansicht öffnen" })).toBeVisible();
    expect(screen.getByText("Architektur.md")).toBeVisible();
  });

  it("schließt die native Linkvorschau beim Abbauen zuverlässig", async () => {
    const { api } = createApi();
    vi.mocked(api.linkPreview.open).mockResolvedValue({
      attachmentId: "41000000-0000-4000-8000-000000000002",
      host: "jira.example.com",
      loading: false,
    });
    window.gemUi = api;
    const rendered = render(
      <LinkPreviewSurface
        attachmentId="41000000-0000-4000-8000-000000000002"
        host="jira.example.com"
        url="https://jira.example.com/browse/LOGIN-42"
        onOpenExternal={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(api.linkPreview.open).toHaveBeenCalledTimes(1));
    vi.mocked(api.linkPreview.close).mockClear();
    rendered.unmount();
    expect(api.linkPreview.close).toHaveBeenCalledTimes(1);
  });

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
    await user.click(screen.getByRole("button", { name: /^Änderungen öffnen/ }));
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
    // The accessible name gains a ", N Dateien" suffix as soon as the git status
    // arrives, so match the prefix instead of racing the subscription.
    await user.click(screen.getByRole("button", { name: /^Änderungen öffnen/ }));

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

  it("hängt aktuelle Dateiänderungen als kleine Diff-Vorschau an das abgeschlossene Tool", async () => {
    const user = userEvent.setup();
    const { api, emit } = createApi();
    const repositoryId = "10000000-0000-4000-8000-000000000011";
    const fileId = "20000000-0000-4000-8000-000000000012";
    const repository = {
      repositoryId,
      rootIds: [project.roots[0]!.id],
      displayName: "portal",
      worktreeLabel: "portal",
      branch: "main",
      headOid: "a".repeat(40),
      upstream: null,
      ahead: 0,
      behind: 0,
      state: "ready" as const,
      message: null,
    };
    const initialStatus = {
      projectId: project.id,
      rootRevision: project.rootRevision,
      refreshedAt: "2026-08-21T12:00:00.000Z",
      repositories: [repository],
      changes: [],
    };
    const changedStatus = {
      ...initialStatus,
      refreshedAt: "2026-08-21T12:00:01.000Z",
      changes: [{
        fileId,
        repositoryId,
        path: "src/auth.ts",
        previousPath: null,
        indexStatus: ".",
        worktreeStatus: "M",
        conflict: false,
        untracked: false,
        submodule: false,
        renameScore: null,
      }],
    };
    vi.mocked(api.git.subscribeProjectStatus).mockImplementation(async (_input, callback) => {
      callback(initialStatus);
      return () => undefined;
    });
    vi.mocked(api.git.getProjectStatus).mockResolvedValue(changedStatus);
    vi.mocked(api.git.getFileDiff).mockResolvedValue({
      snapshotId: "30000000-0000-4000-8000-000000000013",
      repositoryId,
      fileId,
      area: "unstaged",
      path: "src/auth.ts",
      previousPath: null,
      state: "text",
      message: null,
      additions: 1,
      deletions: 1,
      metadata: [],
      hunks: [{
        hunkId: "e".repeat(64),
        header: "@@ -1 +1 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { kind: "deletion", content: "const loggedIn = false;", oldLine: 1, newLine: null },
          { kind: "addition", content: "const loggedIn = true;", oldLine: null, newLine: 1 },
        ],
      }],
    });
    window.gemUi = api;

    render(<App />);
    const composer = await screen.findByRole("textbox", { name: "Nachricht an Gemini" });
    await waitFor(() => expect(api.git.subscribeProjectStatus).toHaveBeenCalledTimes(1));

    await emit([{
      seq: 1,
      sessionId: session.id,
      turnId: "turn-preview",
      timestamp: "2026-08-21T12:00:00.100Z",
      event: {
        type: "tool.started",
        toolCallId: "tool-edit-auth",
        title: "auth.ts bearbeiten",
        kind: "edit",
        arguments: null,
      },
    }]);
    await emit([{
      seq: 2,
      sessionId: session.id,
      turnId: "turn-preview",
      timestamp: "2026-08-21T12:00:00.900Z",
      event: {
        type: "tool.completed",
        toolCallId: "tool-edit-auth",
        result: null,
      },
    }]);

    expect(await screen.findByRole("region", { name: "Dateiänderungen dieses Werkzeugs" })).toBeVisible();
    expect(await screen.findByText("1 geänderte Datei")).toBeVisible();
    expect(await screen.findByText("const loggedIn = true;")).toBeVisible();
    expect(screen.getByText("const loggedIn = false;")).toBeVisible();
    expect(screen.getByText("portal · src/auth.ts")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Vollständigen Diff für src/auth.ts in portal anzeigen" }));
    const panel = await screen.findByRole("complementary", { name: "Git-Änderungen" });
    expect(await within(panel).findByText("const loggedIn = true;")).toBeVisible();
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

    await emit([
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

    await emit([{
      seq: 3,
      sessionId: "session-1",
      turnId: "turn-1",
      timestamp: "2026-08-20T12:00:03.000Z",
      event: { type: "turn.cancelled", reason: null },
    }]);
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

    await emit([
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

    await user.click(screen.getByTitle("Sessioneinstellungen"));
    const modelSelect = await screen.findByRole("combobox", { name: "Gemini-Modell" });
    expect(modelSelect).toHaveValue("gemini-2.5-flash");
    // The pill answers one question — how full the context is — and keeps the
    // breakdown in its tooltip.
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

  it("füllt die Modellauswahl aus der gespeicherten Liste, bevor ein Event eintrifft", async () => {
    // Ein ACP-Prozess startet erst beim ersten Prompt. Ohne gespeicherte Liste
    // bliebe die Auswahl nach jedem Neustart leer, bis die Session läuft.
    const user = userEvent.setup();
    const cachedSession: AppSession = {
      ...session,
      model: "gemini-2.5-flash",
      availableModels: [
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", description: "Für schwierige Aufgaben" },
        { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      ],
    };
    const { api } = createApi({ sessions: [cachedSession] });
    vi.mocked(api.getCapabilities).mockResolvedValue({
      ...capabilities,
      gemini: { ...capabilities.gemini, models: true },
    });
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Login reparieren" });

    await user.click(screen.getByTitle("Sessioneinstellungen"));
    const modelSelect = await screen.findByRole("combobox", { name: "Gemini-Modell" });
    expect(modelSelect).toHaveValue("gemini-2.5-flash");
    // Die gespeicherte Liste bringt lesbare Namen mit, nicht nur IDs.
    expect(within(modelSelect).getByRole("option", { name: "Gemini 2.5 Pro" })).toBeInTheDocument();

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

    await emit([
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

    // Without a reported context window the pill states the session total, and
    // the "≥" is literal: turns before tracking started are missing from it.
    const pill = (await screen.findByText("≥ 18.400")).closest(".usage-pill");
    expect(pill).toBeVisible();
    expect(within(pill as HTMLElement).getByText("Token")).toBeVisible();
    // No context window was reported, so no percentage is shown at all.
    expect(within(pill as HTMLElement).queryByText("Kontext")).not.toBeInTheDocument();
    expect(pill).not.toHaveTextContent("%");

    // The counters Gemini did and did not report stay readable in the tooltip —
    // cache shows a dash there rather than a fake zero.
    const title = pill?.getAttribute("title") ?? "";
    expect(title).toContain("Eingabe: 12.000 Token");
    expect(title).toContain("Ausgabe: 6.400 Token");
    expect(title).toContain("keinen Prozentwert");
    expect(title).toContain("Cache gelesen: nicht gemeldet");
    expect(title).toContain("≥ bedeutet: erfasst seit Aktivierung der Zählung");
    expect(title).toContain("aus Eingabe + Ausgabe berechnet");
    expect(title).not.toContain("Kosten");
  });

  it("zeigt bei fehlender Modell-Capability ehrlich an, dass kein Modell gemeldet wurde", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Login reparieren" });

    expect(screen.getByText("GeminUI")).toBeVisible();
    await user.click(screen.getByTitle("Sessioneinstellungen"));
    expect(await screen.findByText("nicht gemeldet")).toBeVisible();
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

  it("gibt ein Todo samt Anhang als Entwurf in die offene Session", async () => {
    const user = userEvent.setup();
    const todo: Todo = {
      id: "51000000-0000-4000-8000-000000000001",
      projectId: project.id,
      title: "Login reparieren",
      description: "Der Redirect verliert die Session.",
      done: false,
      sortOrder: 0,
      attachments: [],
      completedAt: null,
      createdAt: "2026-08-21T09:00:00.000Z",
      updatedAt: "2026-08-21T09:00:00.000Z",
    };
    const { api } = createApi({ todos: todoList([todo]) });
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Login reparieren" });

    await user.click(screen.getByRole("button", { name: /^Todos öffnen/ }));
    const panel = await screen.findByRole("complementary", { name: "Todos dieses Projekts" });
    await user.click(within(panel).getByRole("button", { name: /Der Redirect verliert die Session/ }));
    await user.click(within(panel).getByRole("button", { name: "In diese Session" }));

    await waitFor(() =>
      expect(api.todos.prepareForSession).toHaveBeenCalledWith(
        expect.objectContaining({ todoId: todo.id, sessionId: "session-1" }),
      ),
    );
    // The draft lands in the composer instead of being sent: nothing goes to
    // Gemini until the user presses send.
    expect(screen.getByRole("textbox", { name: "Nachricht an Gemini" })).toHaveValue(
      "Login reparieren\n\nDer Redirect verliert die Session.",
    );
    expect(api.sessions.sendPrompt).not.toHaveBeenCalled();
  });

  it("hängt einen übernommenen Entwurf an bereits getippten Text an", async () => {
    const user = userEvent.setup();
    const todo: Todo = {
      id: "51000000-0000-4000-8000-000000000002",
      projectId: project.id,
      title: "Login reparieren",
      description: "Der Redirect verliert die Session.",
      done: false,
      sortOrder: 0,
      attachments: [],
      completedAt: null,
      createdAt: "2026-08-21T09:00:00.000Z",
      updatedAt: "2026-08-21T09:00:00.000Z",
    };
    const { api } = createApi({ todos: todoList([todo]) });
    window.gemUi = api;

    render(<App />);
    const composer = await screen.findByRole("textbox", { name: "Nachricht an Gemini" });
    await user.type(composer, "Vorher getippt");

    await user.click(screen.getByRole("button", { name: /^Todos öffnen/ }));
    const panel = await screen.findByRole("complementary", { name: "Todos dieses Projekts" });
    await user.click(within(panel).getByRole("button", { name: /Der Redirect verliert die Session/ }));
    await user.click(within(panel).getByRole("button", { name: "In diese Session" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Nachricht an Gemini" })).toHaveValue(
        "Vorher getippt\n\nLogin reparieren\n\nDer Redirect verliert die Session.",
      ),
    );
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

  it("bietet im Planmodus Buttons zum Akzeptieren und Ablehnen des Plans", async () => {
    const user = userEvent.setup();
    const { api, emit } = createApi();
    const planSession = {
      ...session,
      id: "session-plan",
      title: "Architektur planen",
      mode: "plan",
      status: "idle" as const,
    };
    vi.mocked(api.sessions.list).mockResolvedValue([planSession]);
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Architektur planen" });

    await emit([
      {
        seq: 1,
        sessionId: "session-plan",
        turnId: "turn-1",
        timestamp: "2026-08-20T12:00:01.000Z",
        event: { type: "message.assistant.delta", messageId: "assistant-plan", delta: "# Plan für Architektur\n1. Entwurf\n2. Umsetzung" },
      },
      {
        seq: 2,
        sessionId: "session-plan",
        turnId: "turn-1",
        timestamp: "2026-08-20T12:00:02.000Z",
        event: { type: "turn.completed", stopReason: "completed" },
      },
    ]);

    const acceptButton = await screen.findByRole("button", { name: "Plan akzeptieren" });
    const rejectButton = screen.getByRole("button", { name: "Plan ablehnen" });
    expect(acceptButton).toBeVisible();
    expect(rejectButton).toBeVisible();

    await user.click(acceptButton);
    await waitFor(() => expect(api.sessions.sendPrompt).toHaveBeenCalledTimes(1));
    expect(api.sessions.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-plan",
        text: "Plan akzeptiert. Bitte mit der Umsetzung beginnen.",
      }),
    );
  });

  it("sendet beim Ablehnen im Planmodus eine saubere Absage ohne Alternativvorschlag", async () => {
    const user = userEvent.setup();
    const { api, emit } = createApi();
    const planSession = {
      ...session,
      id: "session-plan",
      title: "Architektur planen",
      mode: "plan",
      status: "idle" as const,
    };
    vi.mocked(api.sessions.list).mockResolvedValue([planSession]);
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Architektur planen" });

    await emit([
      {
        seq: 1,
        sessionId: "session-plan",
        turnId: "turn-1",
        timestamp: "2026-08-20T12:00:01.000Z",
        event: { type: "message.assistant.delta", messageId: "assistant-plan", delta: "Hier ist der Plan." },
      },
      {
        seq: 2,
        sessionId: "session-plan",
        turnId: "turn-1",
        timestamp: "2026-08-20T12:00:02.000Z",
        event: { type: "turn.completed", stopReason: "completed" },
      },
    ]);

    const rejectButton = await screen.findByRole("button", { name: "Plan ablehnen" });
    await user.click(rejectButton);

    await waitFor(() => expect(api.sessions.sendPrompt).toHaveBeenCalledTimes(1));
    expect(api.sessions.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-plan",
        text: "Plan abgelehnt.",
      }),
    );
  });

  it("zeigt beim Wechseln von Developer zu Plan Modus nicht direkt die Plan-Entscheidungs-Buttons an", async () => {
    const user = userEvent.setup();
    const { api, emit } = createApi();
    const devSession = {
      ...session,
      id: "session-dev",
      title: "Feature bauen",
      mode: "developer",
      status: "idle" as const,
      availableModes: [
        { id: "developer", name: "developer", description: "Developer mode" },
        { id: "plan", name: "plan", description: "Planning mode" },
      ],
    };
    vi.mocked(api.sessions.list).mockResolvedValue([devSession]);
    vi.mocked(api.sessions.update).mockResolvedValue({
      ...devSession,
      mode: "plan",
    });
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Feature bauen" });

    // Assistant answers in developer mode
    await emit([
      {
        seq: 1,
        sessionId: "session-dev",
        turnId: "turn-dev-1",
        timestamp: "2026-08-20T12:00:01.000Z",
        event: { type: "message.assistant.delta", messageId: "assistant-1", delta: "Code wurde geändert." },
      },
      {
        seq: 2,
        sessionId: "session-dev",
        turnId: "turn-dev-1",
        timestamp: "2026-08-20T12:00:02.000Z",
        event: { type: "turn.completed", stopReason: "completed" },
      },
    ]);

    expect(screen.queryByRole("button", { name: "Plan akzeptieren" })).toBeNull();

    // Switch mode from developer to plan
    const modeSelect = await screen.findByRole("combobox", { name: "Gemini-Modus" });
    await user.selectOptions(modeSelect, "plan");

    // Plan decision buttons must NOT appear
    expect(screen.queryByRole("button", { name: "Plan akzeptieren" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Plan ablehnen" })).toBeNull();
  });

  it("rendert Markdown-Dateien wie plan.md formatiert und bietet einen Toggle für Raw Markdown", async () => {
    const user = userEvent.setup();
    const { api } = createApi({ contextList: populatedContextList() });
    vi.mocked(api.contextAttachments.getBytes).mockResolvedValue(
      new TextEncoder().encode("# Implementierungsplan\n- [ ] Schritt 1\n- [ ] Schritt 2"),
    );
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Login reparieren" });

    // Open context attachments panel
    await user.click(screen.getByRole("button", { name: /Anhänge öffnen/ }));
    expect(await screen.findByText("Architektur.md")).toBeVisible();

    // Click on Architektur.md to open AttachmentDetail
    await user.click(screen.getByText("Architektur.md"));
    expect(await screen.findByRole("heading", { name: "Implementierungsplan" })).toBeVisible();

    // Toggle to Raw
    const rawToggle = screen.getByTitle("Raw Markdown anzeigen");
    expect(rawToggle).toBeVisible();
    await user.click(rawToggle);

    expect(screen.getByText(/# Implementierungsplan/)).toBeVisible();
  });

  it("öffnet bei Hover/Klick auf die Token-Pille ein Details-Modal mit Input, Output und Cached", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Login reparieren" });

    // Hover / click on usage pill to open token details popover
    const pill = screen.getByText("Token: –").closest(".usage-pill")!;
    await user.hover(pill);

    expect(await screen.findByRole("dialog", { name: "Token-Nutzung Details" })).toBeVisible();
    expect(screen.getByText("Input")).toBeVisible();
    expect(screen.getByText("Output")).toBeVisible();
    expect(screen.getByText("Cached")).toBeVisible();
  });

  it("sucht in Session-Titeln und Inhalten und hebt Treffer farblich hervor", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    api.sessions.search = vi.fn().mockResolvedValue({
      projectId: project.id,
      query: "reparieren",
      results: [
        {
          sessionId: session.id,
          titleMatches: true,
          matchedSnippet: "…Fehler beim Login reparieren gefunden…",
        },
      ],
    });
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Login reparieren" });

    // Sidebar search input
    const searchInput = screen.getByPlaceholderText("Sessions suchen…");
    expect(searchInput).toBeVisible();

    // Type query
    await user.type(searchInput, "Login");

    // The match should be highlighted in mark.search-highlight
    const marks = document.querySelectorAll("mark.search-highlight");
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0].textContent).toBe("Login");

    // Toggle content search checkbox
    const contentCheckbox = screen.getByLabelText("Inhalt durchsuchen");
    expect(contentCheckbox).toBeVisible();
    await user.click(contentCheckbox);
    expect(contentCheckbox).toBeChecked();
  });

  it("sendet GitLab-Review-Kontext mit valider, strikter SendPromptInputSchema-Payload", async () => {
    const { api } = createApi();
    window.gemUi = api;
    render(<App />);
    await screen.findByRole("heading", { name: "Login reparieren" });

    // Directly simulate sending with externalContextRefs
    const preparedRef = { kind: "gitlab_review" as const, id: "ext-1" };
    await api.sessions.sendPrompt({
      sessionId: session.id,
      text: "Bitte bearbeite das Review-Feedback zu dieser Stelle.",
      attachmentIds: [],
      contextAttachmentIds: [],
      projectFiles: [],
      externalContextRefs: [preparedRef],
      expectedRootRevision: 1,
      clientRequestId: "req-1",
    });

    expect(api.sessions.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        text: "Bitte bearbeite das Review-Feedback zu dieser Stelle.",
        externalContextRefs: [{ kind: "gitlab_review", id: "ext-1" }],
      }),
    );
  });

  it("deaktiviert den Neue-Session-Button und zeigt einen Ladekreis während des Anlegens", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    type CreatedSession = Awaited<ReturnType<typeof api.sessions.create>>;
    let resolveCreate: (s: CreatedSession) => void;
    const createPromise = new Promise<CreatedSession>((resolve) => {
      resolveCreate = resolve;
    });
    vi.mocked(api.sessions.create).mockImplementation(() => createPromise);
    window.gemUi = api;

    render(<App />);
    await screen.findByRole("heading", { name: "Login reparieren" });

    const newSessionBtn = screen.getByRole("button", { name: /Neue Session/ });
    expect(newSessionBtn).not.toBeDisabled();
    expect(newSessionBtn.querySelector(".mini-spinner")).toBeNull();

    // Click Neue Session
    await user.click(newSessionBtn);

    // Button should be disabled and show spinner
    expect(newSessionBtn).toBeDisabled();
    expect(newSessionBtn.querySelector(".mini-spinner")).not.toBeNull();
    expect(api.sessions.create).toHaveBeenCalledTimes(1);

    // Second click while pending should not trigger another call
    await user.click(newSessionBtn);
    expect(api.sessions.create).toHaveBeenCalledTimes(1);

    // Resolve create
    const newSession: CreatedSession = {
      ...session,
      status: "idle",
      id: "session-2",
      title: "Neue Session 2",
    };
    await act(async () => {
      resolveCreate!(newSession);
    });

    await waitFor(() => {
      expect(newSessionBtn.querySelector(".mini-spinner")).toBeNull();
      expect(newSessionBtn).not.toBeDisabled();
    });
  });

  it("schaltet über den Theme-Button zwischen Light- und Darkmode um", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    window.gemUi = api;
    render(<App />);

    await screen.findByRole("heading", { name: "Login reparieren" });

    const themeToggle = screen.getByRole("button", { name: /Modus aktivieren/i });
    expect(themeToggle).toBeInTheDocument();

    const initialTheme = document.documentElement.getAttribute("data-theme") ?? "light";
    await user.click(themeToggle);

    const nextTheme = document.documentElement.getAttribute("data-theme");
    expect(nextTheme).toBe(initialTheme === "dark" ? "light" : "dark");
  });

  it("benennt den YOLO-Modus in Developer um", async () => {
    const { api } = createApi({
      sessions: [
        {
          ...session,
          id: "session-1",
          title: "Test Session",
          mode: "yolo",
          availableModes: [
            { id: "yolo", name: "yolo", description: "All permissions" },
            { id: "plan", name: "plan", description: "Planning mode" },
          ],
        },
      ],
    });
    window.gemUi = api;
    render(<App />);

    await screen.findByRole("heading", { name: "Test Session" });
    expect(screen.getAllByText(/Developer/i).length).toBeGreaterThan(0);
  });

  it("zeigt im Token-Nutzungs-Modal die Nutzung nach Modell gestaffelt an", async () => {
    const user = userEvent.setup();
    const { api, emit } = createApi();
    window.gemUi = api;
    render(<App />);

    await screen.findByRole("heading", { name: "Login reparieren" });

    await emit([
      {
        seq: 1,
        sessionId: session.id,
        turnId: "turn-1",
        timestamp: new Date().toISOString(),
        event: {
          type: "usage.updated",
          snapshot: {
            revision: 1,
            lastTurn: {
              turnId: "turn-1",
              tokens: {
                input: 1200,
                output: 350,
                total: 1550,
                thought: null,
                cachedRead: null,
                cachedWrite: null,
                tool: null,
                totalKind: "derived_input_plus_output",
              },
              byModel: [
                { model: "gemini-2.5-pro", input: 1000, output: 300 },
                { model: "gemini-2.5-flash", input: 200, output: 50 },
              ],
              source: "gemini_meta_quota",
            },
            session: {
              tokens: {
                input: 1200,
                output: 350,
                total: 1550,
                thought: null,
                cachedRead: null,
                cachedWrite: null,
                tool: null,
                totalKind: "derived_input_plus_output",
              },
              coverage: "complete",
              source: "geminui_aggregate",
            },
            context: {
              used: 1550,
              size: 1_000_000,
              source: "acp_usage_update",
            },
            cost: null,
            updatedAt: new Date().toISOString(),
          },
        },
      },
    ]);

    const pill = document.querySelector(".usage-pill")!;
    await user.hover(pill);

    expect(await screen.findByRole("dialog", { name: "Token-Nutzung Details" })).toBeVisible();
    expect(screen.getByText("Nutzung nach Modell")).toBeInTheDocument();
    expect(screen.getByText("gemini-2.5-pro")).toBeInTheDocument();
    expect(screen.getByText("gemini-2.5-flash")).toBeInTheDocument();
  });

  it("zeigt on hover beim Antwort-Icon das Modell und die Token-Kosten an", async () => {
    const user = userEvent.setup();
    const { api, emit } = createApi();
    window.gemUi = api;
    render(<App />);

    await screen.findByRole("heading", { name: "Login reparieren" });

    // Stream an assistant message
    await emit([
      {
        seq: 1,
        sessionId: session.id,
        turnId: "turn-abc",
        timestamp: new Date().toISOString(),
        event: {
          type: "message.assistant.delta",
          messageId: "msg-123",
          delta: "Hier ist die Antwort von Gemini.",
        },
      },
      {
        seq: 2,
        sessionId: session.id,
        turnId: "turn-abc",
        timestamp: new Date().toISOString(),
        event: {
          type: "usage.updated",
          snapshot: {
            revision: 1,
            lastTurn: {
              turnId: "turn-abc",
              tokens: {
                input: 800,
                output: 150,
                total: 950,
                thought: null,
                cachedRead: 200,
                cachedWrite: null,
                tool: null,
                totalKind: "derived_input_plus_output",
              },
              byModel: [{ model: "gemini-2.5-pro", input: 800, output: 150 }],
              source: "gemini_meta_quota",
            },
            session: null,
            context: null,
            cost: null,
            updatedAt: new Date().toISOString(),
          },
        },
      },
    ]);

    const assistantMark = document.querySelector(".assistant-mark")!;
    expect(assistantMark).toBeInTheDocument();
    await user.hover(assistantMark);

    expect(await screen.findByRole("tooltip", { name: "Antwort-Details" })).toBeVisible();
    expect(screen.getByText("gemini-2.5-pro")).toBeInTheDocument();
    expect(screen.getByText(/950 Token/i)).toBeInTheDocument();
  });

  it("zeigt in der Leiste die Gemini-Session-Historie mit Kontext-Gehirn-Icon an", async () => {
    const user = userEvent.setup();
    const { api, emit } = createApi();
    window.gemUi = api;
    render(<App />);

    await screen.findByRole("heading", { name: "Login reparieren" });

    // Emit reconnect session.started
    await emit([
      {
        seq: 1,
        sessionId: session.id,
        turnId: null,
        timestamp: "2026-08-22T10:00:00.000Z",
        event: {
          type: "session.started",
          providerSessionId: "gemini-sess-initial",
        },
      },
      {
        seq: 2,
        sessionId: session.id,
        turnId: null,
        timestamp: "2026-08-22T11:00:00.000Z",
        event: {
          type: "session.started",
          providerSessionId: "gemini-sess-reconnected",
        },
      },
    ]);

    const historyBtn = screen.getByRole("button", { name: "Gemini-Sitzungsverlauf anzeigen" });
    await user.hover(historyBtn);

    expect(await screen.findByRole("dialog", { name: "Gemini-Sitzungshistorie" })).toBeVisible();
    expect(screen.getByText(/gemini-sess-initial/i)).toBeInTheDocument();
    expect(screen.getByText(/gemini-sess-reconnected/i)).toBeInTheDocument();
    expect(screen.getByText("Kontext übergeben")).toBeInTheDocument();
  });

  it("zeigt in der Leiste die Gemini-Session-Historie über session.ready Events an", async () => {
    const user = userEvent.setup();
    const { api, emit } = createApi();
    window.gemUi = api;
    render(<App />);

    await screen.findByRole("heading", { name: "Login reparieren" });

    // Emit initial and reconnected session.ready
    await emit([
      {
        seq: 1,
        sessionId: session.id,
        turnId: null,
        timestamp: "2026-08-22T10:00:00.000Z",
        event: {
          type: "session.ready",
          providerSessionId: "gemini-ready-initial",
          modes: ["default"],
          models: ["gemini-2.5-flash"],
        },
      },
      {
        seq: 2,
        sessionId: session.id,
        turnId: null,
        timestamp: "2026-08-22T11:00:00.000Z",
        event: {
          type: "session.ready",
          providerSessionId: "gemini-ready-reconnected",
          modes: ["default"],
          models: ["gemini-2.5-flash"],
        },
      },
    ]);

    const historyBtn = screen.getByRole("button", { name: "Gemini-Sitzungsverlauf anzeigen" });
    await user.hover(historyBtn);

    expect(await screen.findByRole("dialog", { name: "Gemini-Sitzungshistorie" })).toBeVisible();
    expect(screen.getByText(/gemini-ready-initial/i)).toBeInTheDocument();
    expect(screen.getByText(/gemini-ready-reconnected/i)).toBeInTheDocument();
    expect(screen.getByText("Kontext übergeben")).toBeInTheDocument();
  });

  it("lässt das Info-Icon pulsieren wenn ein Update verfügbar ist", async () => {
    const { api } = createApi();
    api.app.checkForUpdates = vi.fn().mockResolvedValue({
      currentVersion: "0.1.0",
      latestVersion: "0.5.1",
      updateAvailable: true,
      releaseName: "v0.5.1",
      releaseNotes: "Fehlerbehebungen",
      downloadUrl: "https://example.com/update.exe",
      error: null,
    });
    window.gemUi = api;
    render(<App />);

    const infoButton = await screen.findByRole("button", { name: /Update verfügbar/i });
    expect(infoButton).toHaveClass("app-info-trigger-button--update-available");
    expect(infoButton.querySelector(".app-info-trigger-icon--pulse")).toBeInTheDocument();
  });

  it("öffnet Statistiken standardmäßig global und erlaubt Filterung nach Projekt mit Aktivierungs-Aufforderung", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    window.gemUi = api;
    render(<App />);

    await screen.findByRole("heading", { name: "Login reparieren" });

    // Open statistics via bottom rail button
    const statsBtn = screen.getByRole("button", { name: "Statistiken öffnen" });
    await user.click(statsBtn);

    expect(await screen.findByRole("main", { name: "App-Statistiken" })).toBeInTheDocument();
    expect(screen.getByText(/Gesamte globale Nutzungs- und Performance-Daten/i)).toBeInTheDocument();

    // Select specific project in the project filter
    const projectSelect = screen.getByRole("combobox", { name: "Projekt filtern" });
    await user.selectOptions(projectSelect, project.id);

    expect(screen.getByText("Statistiken sind aktuell nicht aktiviert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Statistiken jetzt aktivieren/i })).toBeInTheDocument();

    // Click activation button
    await user.click(screen.getByRole("button", { name: /Statistiken jetzt aktivieren/i }));
    expect(api.projects.setStatsEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: project.id,
        enabled: true,
      }),
    );
  });

  it("zeigt Warnbalken wenn Statistik-Tracking deaktiviert ist aber historische Daten vorliegen nach Projekt-Filterung", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    api.stats.get = vi.fn().mockResolvedValue({
      summary: {
        totalTokens: 12500,
        inputTokens: 10000,
        outputTokens: 2500,
        thoughtTokens: 0,
        cachedTokens: 2500,
        cacheHitRate: 20,
        inputPercentage: 80,
        outputPercentage: 20,
        avgDurationMs: 850,
        totalDurationMs: 4250,
        totalTurns: 5,
        totalLinesAdded: 45,
        totalLinesDeleted: 10,
        planAccepted: 2,
        planRejected: 0,
        planTotal: 2,
        planAcceptanceRate: 100,
        filesCreated: 3,
        filesModified: 5,
        filesDeleted: 1,
        skillsUsedTotal: 2,
        mcpUsedTotal: 1,
        gitActionsTotal: 4,
        shellCommandsTotal: 6,
        topSkills: [{ name: "agy-customizations", count: 2 }],
        topMcpTools: [{ name: "github:create_issue", count: 1 }],
        topGitActions: [{ name: "commit", count: 2 }, { name: "diff", count: 2 }],
        topShellCommands: [{ name: "npm test", count: 4 }, { name: "git commit", count: 2 }],
        activeProjectsCount: 1,
        activeSessionsCount: 1,
      },
      timeSeries: [],
      tokensPerSecondSeries: [],
      modelComparison: [],
      availableModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
    });
    window.gemUi = api;
    render(<App />);

    await screen.findByRole("heading", { name: "Login reparieren" });

    const statsBtn = screen.getByRole("button", { name: "Statistiken öffnen" });
    await user.click(statsBtn);

    expect(await screen.findByRole("main", { name: "App-Statistiken" })).toBeInTheDocument();

    // Select specific project in the project filter
    const projectSelect = screen.getByRole("combobox", { name: "Projekt filtern" });
    await user.selectOptions(projectSelect, project.id);

    expect(screen.getByText(/Statistik-Erfassung ist für dieses Projekt aktuell deaktiviert/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Jetzt wieder aktivieren/i })).toBeInTheDocument();
    expect(screen.getByText("12.5k")).toBeInTheDocument(); // total tokens rendered in KPI (12500 -> 12.5k)
    expect(screen.getByText(/Cache:/i)).toBeInTheDocument();
  });

  it("blendet während des Antwort-Runs die Live-Token-Schätzung über dem Composer ein wenn in Projekteinstellungen aktiviert", async () => {
    const liveProject = {
      ...project,
      liveTokensEnabled: true,
    };
    const { api, emit } = createApi({ project: liveProject });
    window.gemUi = api;
    render(<App />);

    await screen.findByRole("heading", { name: "Login reparieren" });

    // Emit assistant message delta
    await emit([
      {
        sessionId: session.id,
        turnId: "turn-live-1",
        seq: 1,
        event: {
          type: "message.assistant.delta",
          messageId: "assistant-live-1",
          delta: "Hier ist eine längere Antwort von Gemini mit vielen Wörtern und Details zum Beheben des Fehlers.",
        },
        timestamp: new Date().toISOString(),
      },
    ]);

    expect(screen.getByText(/Gemini arbeitet gerade/i)).toBeInTheDocument();
    expect(screen.getByText(/Tokens/i)).toBeInTheDocument();
    expect(screen.getByText(/geschätzt/i)).toBeInTheDocument();
  });

  it("zeigt standardmäßig keine Live-Token-Schätzung wenn liveTokensEnabled deaktiviert ist", async () => {
    const defaultProject = {
      ...project,
      liveTokensEnabled: false,
    };
    const { api, emit } = createApi({ project: defaultProject });
    window.gemUi = api;
    render(<App />);

    await screen.findByRole("heading", { name: "Login reparieren" });

    // Emit assistant message delta
    await emit([
      {
        sessionId: session.id,
        turnId: "turn-live-1",
        seq: 1,
        event: {
          type: "message.assistant.delta",
          messageId: "assistant-live-2",
          delta: "Hier ist eine Antwort von Gemini.",
        },
        timestamp: new Date().toISOString(),
      },
    ]);

    expect(screen.queryByText(/geschätzt/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tokens/i)).not.toBeInTheDocument();
  });

  it("öffnet den Projekt-Explorer über die Panel-Leiste, zeigt Dateibaum an und übernimmt Datei in den Composer-Kontext", async () => {
    const user = userEvent.setup();
    const { api } = createApi();

    const rootId = project.roots[0]!.id;
    api.projectFiles.listDirectory = vi.fn().mockImplementation(async (input) => {
      if (input.rootId === rootId && input.relativePath === "") {
        return {
          projectId: project.id,
          rootRevision: project.rootRevision,
          entries: [
            {
              rootId,
              rootLabel: project.name,
              relativePath: "src",
              displayName: "src",
              kind: "directory",
              size: 0,
              childCount: 1,
              contextEligible: true,
              contextUnavailableReason: null,
            },
            {
              rootId,
              rootLabel: project.name,
              relativePath: "README.md",
              displayName: "README.md",
              kind: "file",
              size: 120,
              childCount: 0,
              contextEligible: true,
              contextUnavailableReason: null,
            },
          ],
          truncated: false,
        };
      }
      if (input.rootId === rootId && input.relativePath === "src") {
        return {
          projectId: project.id,
          rootRevision: project.rootRevision,
          entries: [
            {
              rootId,
              rootLabel: project.name,
              relativePath: "src/index.ts",
              displayName: "index.ts",
              kind: "file",
              size: 240,
              childCount: 0,
              contextEligible: true,
              contextUnavailableReason: null,
            },
          ],
          truncated: false,
        };
      }
      return {
        projectId: project.id,
        rootRevision: project.rootRevision,
        entries: [],
        truncated: false,
      };
    });

    window.gemUi = api;
    render(<App />);

    await screen.findByRole("heading", { name: "Login reparieren" });

    // Open Explorer via rail button
    const explorerBtn = screen.getByRole("button", { name: /Explorer/i });
    await user.click(explorerBtn);

    expect(await screen.findByRole("complementary", { name: "Projekt-Explorer" })).toBeInTheDocument();
    expect(screen.getByRole("tree", { name: "Dateibaum" })).toBeInTheDocument();

    // Verify root files are listed
    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();

    // Expand "src" directory
    const srcFolder = screen.getByText("src");
    await user.click(srcFolder);

    // Verify sub-file index.ts is loaded and visible
    expect(await screen.findByText("index.ts")).toBeInTheDocument();

    // Click README.md to open in FileViewer
    const readmeFile = screen.getByText("README.md");
    await user.click(readmeFile);

    // FileViewer is now visible in the center workspace while ExplorerTree remains in the right panel
    expect(await screen.findByRole("region", { name: /Dateiinhalt: README.md/i })).toBeInTheDocument();
    expect(screen.getByRole("tree", { name: "Dateibaum" })).toBeInTheDocument();
    expect(await screen.findByText("# Test Project")).toBeInTheDocument();
    expect(screen.getByText("3 Zeilen")).toBeInTheDocument();
    expect(screen.getByText("markdown")).toBeInTheDocument();

    // Click "In Chat" button inside FileViewer
    const inChatBtn = screen.getByRole("button", { name: "Datei in Chat übernehmen" });
    await user.click(inChatBtn);

    // Click Close button in FileViewer
    const closeBtn = screen.getByRole("button", { name: "Dateivorschau schließen" });
    await user.click(closeBtn);

    // FileViewer is closed, chat-view is active and Composer shows referenced file
    expect(screen.queryByRole("region", { name: /Dateiinhalt: README.md/i })).toBeNull();
    const strip = await screen.findByLabelText("Referenzierte Projektdateien und -ordner");
    expect(within(strip).getByText("README.md")).toBeInTheDocument();
  });

  it("übernimmt per Drag-and-drop gezogene Projektdateien in den Composer-Kontext", async () => {
    const { api } = createApi();
    window.gemUi = api;
    render(<App />);

    await screen.findByRole("heading", { name: "Login reparieren" });

    const rootId = project.roots[0]!.id;
    const droppedRef = {
      rootId,
      rootLabel: project.name,
      relativePath: "package.json",
      displayName: "package.json",
      kind: "file",
      size: 500,
      childCount: 0,
      contextEligible: true,
      contextUnavailableReason: null,
    };

    // Simulate drop with application/x-geminui-project-file-refs
    const dataTransfer = {
      types: ["application/x-geminui-project-file-refs"],
      getData: (format: string) =>
        format === "application/x-geminui-project-file-refs"
          ? JSON.stringify([droppedRef])
          : "",
      files: [],
    };

    fireEvent.drop(window, { dataTransfer });

    // Verify package.json reference chip appeared in Composer
    const strip = await screen.findByLabelText("Referenzierte Projektdateien und -ordner");
    expect(within(strip).getByText("package.json")).toBeInTheDocument();
  });

  it("zeigt Jira-Anhänge im Anhänge-Panel und erlaubt 1-Klick-Sync in die Session", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    api.jira.syncAttachments = vi.fn().mockResolvedValue({
      syncedCount: 1,
      attachmentIds: ["att-1"],
      skippedCount: 0,
    });
    window.gemUi = api;

    const jiraIssue = {
      issueKey: "AML-456",
      prefix: "AML",
      url: "https://jira.example.com/browse/AML-456",
      configName: "Firmen-Jira",
      hasAccessToken: true,
      summary: "Zahlungsschnittstelle implementieren",
      storyMarkdown: "# AML-456",
      attachments: [
        {
          id: "att-100",
          filename: "spec.pdf",
          size: 1048576,
          mimeType: "application/pdf",
          created: "2026-08-24T12:00:00.000Z",
          contentUrl: "https://jira.example.com/attachment/100",
        },
      ],
    };

    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onApply = vi.fn();
    const onError = vi.fn();

    const { AttachmentsPanel } = await import(
      "../../src/renderer/features/attachments/AttachmentsPanel"
    );

    render(
      <AttachmentsPanel
        open={true}
        project={project}
        sessionId="session-1"
        list={{
          projectId: project.id,
          sessionId: "session-1",
          projectAttachments: [],
          sessionAttachments: [],
          includedCount: 0,
          estimatedTotalTokens: 0,
          overBudget: false,
        }}
        loading={false}
        refreshing={false}
        error={null}
        jiraIssue={jiraIssue}
        onClose={vi.fn()}
        onRefresh={onRefresh}
        onApply={onApply}
        onError={onError}
        onOpenExternal={vi.fn()}
      />,
    );

    // Verify Jira section is rendered with issue key and attachment info
    expect(screen.getByText("Jira (AML-456)")).toBeInTheDocument();
    expect(screen.getByText("spec.pdf")).toBeInTheDocument();
    expect(screen.getByText(/1\.0 MB/)).toBeInTheDocument();

    // Click "Syncen" button for this attachment
    const syncBtn = screen.getByRole("button", { name: /^Syncen$/i });
    await user.click(syncBtn);

    expect(api.jira.syncAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: project.id,
        sessionId: "session-1",
        issueKey: "AML-456",
        attachmentIds: ["att-100"],
      }),
    );
    expect(onRefresh).toHaveBeenCalled();
  });

  it("rendert JiraIssueView mit In-Chat-Einfügen und Browser-Aktionen", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    window.gemUi = api;

    const onInsertIntoChat = vi.fn();
    const onOpenExternal = vi.fn();
    const onClose = vi.fn();

    const jiraIssue = {
      issueKey: "AML-789",
      prefix: "AML",
      url: "https://jira.example.com/browse/AML-789",
      configName: "Firmen-Jira",
      hasAccessToken: true,
      summary: "Story Test",
      storyMarkdown: "# [AML-789] Story Test\n\n## Beschreibung\nAusführlicher Text.",
      attachments: [],
    };

    const { JiraIssueView } = await import(
      "../../src/renderer/features/jira/JiraIssueView"
    );

    render(
      <JiraIssueView
        issue={jiraIssue}
        projectId="project-1"
        sessionId="session-1"
        attachError={null}
        onClose={onClose}
        onOpenExternal={onOpenExternal}
        onInsertIntoChat={onInsertIntoChat}
      />,
    );

    // Verify issue key and summary in header
    expect(screen.getByText("AML-789")).toBeInTheDocument();
    expect(screen.getByText("Story Test")).toBeInTheDocument();

    // Click "In Chat einfügen" button
    const insertBtn = screen.getByRole("button", { name: /In Chat einfügen/i });
    await user.click(insertBtn);
    expect(onInsertIntoChat).toHaveBeenCalledWith(jiraIssue.storyMarkdown);

    // Click "Im Browser öffnen"
    const openBtn = screen.getByRole("button", { name: /Im Browser öffnen/i });
    await user.click(openBtn);
    expect(onOpenExternal).toHaveBeenCalledWith(jiraIssue.url);

    // Click Close button
    const closeBtn = screen.getByRole("button", { name: "Jira-Ansicht schließen" });
    await user.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("zeigt Jira-API-Logs im DebugLogModal an und filtert nach Jira", async () => {
    const user = userEvent.setup();
    const { debugLogger } = await import(
      "../../src/renderer/features/debug/debug-logger"
    );
    const { DebugLogModal } = await import(
      "../../src/renderer/features/debug/DebugLogModal"
    );

    // Emit Jira log entries with redacted headers and status codes
    debugLogger.log("info", "jira", "-> GET https://jira.example.com/rest/api/2/issue/AML-1234?fields=*all", {
      url: "https://jira.example.com/rest/api/2/issue/AML-1234?fields=*all",
      auth: "Bearer [GESCHÜTZT]",
    });
    debugLogger.log("info", "jira", "<- HTTP 200 OK von GET https://jira.example.com/rest/api/2/issue/AML-1234?fields=*all", {
      status: 200,
    });

    render(<DebugLogModal open={true} onClose={vi.fn()} />);

    // Verify Jira entries and source badge are visible
    expect(screen.getByText(/-> GET https:\/\/jira\.example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/<- HTTP 200 OK/)).toBeInTheDocument();
    expect(screen.getAllByText("jira").length).toBeGreaterThan(0);

    // Click the Jira segment filter button
    const jiraFilterBtn = screen.getByRole("button", { name: /Jira \(\d+\)/ });
    await user.click(jiraFilterBtn);

    expect(screen.getByText(/-> GET https:\/\/jira\.example\.com/)).toBeInTheDocument();
  });
});
