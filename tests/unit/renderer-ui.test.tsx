// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
  projects?: AppProject[];
  sessions?: AppSession[];
  contextList?: ContextAttachmentList;
  todos?: TodoList;
} = {}) {
  let subscriber: ((events: StreamEnvelope[]) => void) | undefined;
  const api: GemUiDesktopApi = {
    getCapabilities: vi.fn().mockResolvedValue(capabilities),
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
      getReconnectState: vi.fn().mockResolvedValue({
        sessionId: session.id,
        reconnected: false,
        hasHistory: false,
      }),
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
        size: 512,
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
    expect(screen.getByText("Tippe den ersten Buchstaben des Dateinamens oder Pfads.")).toBeVisible();
    await user.type(composer, "aut");
    expect(await screen.findByRole("option", { name: /auth\.ts/ })).toBeVisible();

    await user.keyboard("{Tab}");
    expect(screen.getByLabelText("Referenzierte Projektdateien")).toHaveTextContent("auth.ts");
    expect(composer).toHaveValue("Prüfe @src/auth.ts ");

    await user.type(composer, "auf Fehler{Enter}");
    await waitFor(() => expect(api.sessions.sendPrompt).toHaveBeenCalledTimes(1));
    expect(api.sessions.sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
      projectFiles: [{ rootId: project.roots[0]!.id, relativePath: "src/auth.ts" }],
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
    const { api } = createApi();
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

    const acceptButton = screen.getByRole("button", { name: "Plan akzeptieren" });
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
});
