import { describe, expect, it, vi, beforeEach } from "vitest";
import { SessionExportService } from "../../src/main/sessions/session-export-service";
import type {
  AppProject,
  AppSession,
  StreamEnvelope,
} from "../../src/shared/contracts";

const validPngBuffer = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, // signature
  0, 0, 0, 13, 73, 72, 68, 82, // IHDR header
  0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, // data
  31, 21, 196, 137, // CRC
  0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130, // IEND
]);

vi.mock("electron", () => {
  class MockBrowserWindow {
    static getFocusedWindow = vi.fn().mockReturnValue(null);
    loadURL = vi.fn().mockResolvedValue(undefined);
    destroy = vi.fn();
    isDestroyed = vi.fn().mockReturnValue(false);
    setContentSize = vi.fn();
    webContents = {
      printToPDF: vi.fn().mockResolvedValue(Buffer.from("%PDF-1.4 test")),
      capturePage: vi.fn().mockResolvedValue({
        toPNG: vi.fn().mockReturnValue(validPngBuffer),
      }),
      executeJavaScript: vi.fn().mockResolvedValue(1200),
    };
  }

  return {
    BrowserWindow: MockBrowserWindow,
    dialog: {
      showSaveDialog: vi.fn(),
    },
  };
});

let writtenFiles: Record<string, Buffer> = {};
vi.mock("node:fs/promises", () => ({
  default: {
    writeFile: vi.fn().mockImplementation(async (path: string, data: Buffer) => {
      writtenFiles[path] = data;
    }),
  },
}));

describe("SessionExportService", () => {
  const fakeProject: AppProject = {
    id: "proj-1",
    name: "Test Project",
    primaryRootId: "root-1",
    rootRevision: 1,
    rootFingerprint: "fp-1",
    approvalModeId: null,
    approvalModeState: "gemini_default",
    statsEnabled: false,
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    archived: false,
  };

  const fakeSession: AppSession = {
    id: "sess-1",
    projectId: "proj-1",
    provider: "gemini-cli",
    providerSessionId: "gem-sess-1",
    title: "Test Session Feature",
    status: "idle",
    model: "gemini-2.5-pro",
    mode: "plan",
    availableModels: [],
    availableModes: [],
    lastRootRevision: 1,
    lastRootFingerprint: "fp",
    pinned: false,
    archived: false,
    createdAt: "2026-08-22T12:00:00.000Z",
    updatedAt: "2026-08-22T12:30:00.000Z",
  };

  const fakeEvents: StreamEnvelope[] = [
    {
      sessionId: "sess-1",
      seq: 1,
      turnId: "turn-1",
      timestamp: "2026-08-22T12:00:01.000Z",
      event: {
        type: "message.user",
        messageId: "msg-1",
        text: "Kannst du mir helfen?",
        attachmentIds: [],
        contextAttachments: [],
        projectFiles: [],
        externalContexts: [],
      },
    },
    {
      sessionId: "sess-1",
      seq: 2,
      turnId: "turn-1",
      timestamp: "2026-08-22T12:00:02.000Z",
      event: {
        type: "message.thought.delta",
        messageId: "msg-2",
        delta: "Ich analysiere den Code...",
      },
    },
    {
      sessionId: "sess-1",
      seq: 3,
      turnId: "turn-1",
      timestamp: "2026-08-22T12:00:03.000Z",
      event: {
        type: "tool.started",
        toolCallId: "call-1",
        title: "Dateien auflisten",
        kind: "read",
        arguments: { dir: "src" },
      },
    },
    {
      sessionId: "sess-1",
      seq: 4,
      turnId: "turn-1",
      timestamp: "2026-08-22T12:00:04.000Z",
      event: {
        type: "tool.completed",
        toolCallId: "call-1",
        result: ["index.ts", "app.tsx"],
      },
    },
    {
      sessionId: "sess-1",
      seq: 5,
      turnId: "turn-1",
      timestamp: "2026-08-22T12:00:05.000Z",
      event: {
        type: "message.assistant.delta",
        messageId: "msg-3",
        delta: "Hier ist die Antwort mit **fettem Text** und `Code`.",
      },
    },
  ];

  let mockSessions: any;
  let mockProjects: any;
  let mockEvents: any;
  let mockDatabase: any;
  let service: SessionExportService;

  beforeEach(() => {
    writtenFiles = {};
    mockSessions = {
      getById: vi.fn().mockReturnValue(fakeSession),
    };
    mockProjects = {
      getById: vi.fn().mockReturnValue(fakeProject),
    };
    mockEvents = {
      listAfter: vi.fn().mockImplementation((_id, afterSeq) => (afterSeq === 0 ? fakeEvents : [])),
    };
    mockDatabase = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            turn_id: "turn-1",
            model: "gemini-2.5-pro",
            duration_ms: 1800,
            input_tokens: 1200,
            output_tokens: 450,
            total_tokens: 1650,
            thought_tokens: 100,
            lines_added: 12,
            lines_deleted: 3,
            status: "completed",
            created_at: "2026-08-22T12:00:01.000Z",
          },
        ]),
      }),
    };

    service = new SessionExportService({
      sessions: mockSessions,
      projects: mockProjects,
      events: mockEvents,
      database: mockDatabase,
    });
  });

  it("returns canceled: true when save dialog is canceled", async () => {
    const { dialog } = await import("electron");
    (dialog.showSaveDialog as any).mockResolvedValueOnce({ canceled: true });

    const result = await service.exportSession({
      sessionId: "sess-1",
      format: "pdf",
      mode: "rendered",
      theme: "light",
      includeMetadata: true,
    });

    expect(result).toEqual({ canceled: true });
  });

  it("successfully exports rendered PDF with expanded tool steps, rating, and metadata", async () => {
    const { dialog } = await import("electron");
    (dialog.showSaveDialog as any).mockResolvedValueOnce({
      canceled: false,
      filePath: "/exports/session.pdf",
    });

    const result = await service.exportSession({
      sessionId: "sess-1",
      format: "pdf",
      mode: "rendered",
      theme: "light",
      includeMetadata: true,
      rating: 5,
      feedbackNote: "Hervorragende Antworten!",
    });

    expect(result).toEqual({
      canceled: false,
      filePath: "/exports/session.pdf",
    });
    expect(writtenFiles["/exports/session.pdf"]).toBeDefined();
  });

  it("successfully exports PNG and injects rating and feedback into tEXt metadata chunks", async () => {
    const { dialog } = await import("electron");
    (dialog.showSaveDialog as any).mockResolvedValueOnce({
      canceled: false,
      filePath: "/exports/session.png",
    });

    const result = await service.exportSession({
      sessionId: "sess-1",
      format: "png",
      mode: "raw",
      theme: "dark",
      includeMetadata: true,
      rating: 4,
      feedbackNote: "Code gut generiert",
    });

    expect(result).toEqual({
      canceled: false,
      filePath: "/exports/session.png",
    });

    const pngData = writtenFiles["/exports/session.png"];
    expect(pngData).toBeDefined();
    // Check that PNG metadata contains the Rating and Feedback strings
    const pngStr = pngData.toString("utf8");
    expect(pngStr).toContain("Rating");
    expect(pngStr).toContain("Feedback");
    expect(pngStr).toContain("Code gut generiert");
    expect(pngStr).toContain("GeminUIMetadata");
  });
});
