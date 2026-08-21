import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AddContextFilesInputSchema,
  AddContextLinkInputSchema,
  AgentEventSchema,
  AppProjectSchema,
  ClipboardImageInputSchema,
  ContextAttachmentSchema,
  CreateProjectInputSchema,
  GEMINI_SETTINGS_KEY,
  GIT_SETTINGS_KEY,
  GetGitFileDiffInputSchema,
  GeminiSettingsSchema,
  IPC_CHANNELS,
  MAX_ADDITIONAL_ROOTS,
  OpenLinkPreviewInputSchema,
  ProjectWithRootsSchema,
  ProjectRootReauthorizationResultSchema,
  ReauthorizeProjectRootInputSchema,
  SendPromptInputSchema,
  StreamEnvelopeSchema,
} from "../../src/shared";

const timestamp = "2026-08-20T12:00:00.000Z";
const fingerprint = "a".repeat(64);

describe("shared Zod contracts", () => {
  it("rejects unknown IPC input fields", () => {
    expect(() =>
      CreateProjectInputSchema.parse({
        clientRequestId: randomUUID(),
        name: "Demo",
        primaryRootPath: "/tmp/demo",
        additionalRootPaths: [],
        arbitraryGeminiFlags: ["--yolo"],
      }),
    ).toThrow();
  });

  it("limits project inputs to five additional roots", () => {
    const input = {
      clientRequestId: randomUUID(),
      name: "Demo",
      primaryRootPath: "/tmp/demo",
      additionalRootPaths: Array.from(
        { length: MAX_ADDITIONAL_ROOTS + 1 },
        (_, index) => `/tmp/root-${index}`,
      ),
    };
    expect(CreateProjectInputSchema.safeParse(input).success).toBe(false);
  });

  it("enforces exactly one primary root and matching primaryRootId", () => {
    const projectId = randomUUID();
    const primaryRootId = randomUUID();
    const project = AppProjectSchema.parse({
      id: projectId,
      name: "Demo",
      primaryRootId,
      rootRevision: 1,
      rootFingerprint: fingerprint,
      approvalModeId: null,
      approvalModeState: "gemini_default",
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const root = {
      id: primaryRootId,
      projectId,
      kind: "primary" as const,
      path: "/tmp/demo",
      realPath: "/tmp/demo",
      label: "demo",
      sortOrder: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    expect(ProjectWithRootsSchema.parse({ ...project, roots: [root] }).roots).toHaveLength(1);
    expect(
      ProjectWithRootsSchema.safeParse({
        ...project,
        roots: [{ ...root, kind: "additional", sortOrder: 1 }],
      }).success,
    ).toBe(false);
  });

  it("requires prompt text or an attachment", () => {
    const base = {
      clientRequestId: randomUUID(),
      sessionId: randomUUID(),
      expectedRootRevision: 1,
      text: "   ",
      attachmentIds: [],
    };
    expect(SendPromptInputSchema.safeParse(base).success).toBe(false);
    expect(
      SendPromptInputSchema.safeParse({
        ...base,
        attachmentIds: [randomUUID()],
      }).success,
    ).toBe(true);
    expect(SendPromptInputSchema.safeParse({
      ...base,
      contextAttachmentIds: [randomUUID()],
    }).success).toBe(false);
  });

  it("verknüpft Anhangstyp, Nutzlast und Ebene strikt", () => {
    const base = {
      id: randomUUID(),
      projectId: randomUUID(),
      scope: "project" as const,
      sessionId: null,
      kind: "link" as const,
      origin: "manual" as const,
      title: "Ticket",
      note: null,
      sortOrder: 0,
      includedInContext: false,
      estimatedTokens: 10,
      file: null,
      link: {
        url: "https://example.com/ticket",
        host: "example.com",
        previewState: "ready" as const,
        previewTitle: "Ticket",
        previewDescription: null,
        previewSiteName: null,
        hasPreviewImage: false,
        previewError: null,
        fetchedAt: timestamp,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(ContextAttachmentSchema.parse(base).kind).toBe("link");
    expect(ContextAttachmentSchema.safeParse({ ...base, kind: "file" }).success).toBe(false);
    expect(ContextAttachmentSchema.safeParse({ ...base, scope: "session" }).success).toBe(false);
    expect(ContextAttachmentSchema.safeParse({ ...base, origin: undefined }).success).toBe(false);
    expect(ContextAttachmentSchema.safeParse({ ...base, origin: "drop" }).success).toBe(false);
  });

  it("setzt die Herkunft eines Anhangs standardmäßig auf \"manual\" und erlaubt \"chat\"", () => {
    const target = {
      clientRequestId: randomUUID(),
      projectId: randomUUID(),
      scope: "project" as const,
      sessionId: null,
    };
    expect(AddContextFilesInputSchema.parse({ ...target, paths: [] }).origin).toBe("manual");
    expect(AddContextFilesInputSchema.parse({ ...target, paths: [], origin: "chat" }).origin).toBe("chat");
    expect(AddContextLinkInputSchema.parse({ ...target, url: "https://example.com/a" }).origin).toBe("manual");
    expect(AddContextLinkInputSchema.parse({ ...target, url: "https://example.com/a", origin: "chat" }).origin).toBe("chat");
    expect(AddContextFilesInputSchema.safeParse({ ...target, paths: [], origin: "drop" }).success).toBe(false);
  });

  it("öffnet eine Live-Vorschau nur über eine opaque Anhang-ID", () => {
    const attachmentId = randomUUID();
    expect(OpenLinkPreviewInputSchema.parse({ attachmentId })).toEqual({ attachmentId });
    expect(OpenLinkPreviewInputSchema.safeParse({
      attachmentId,
      url: "file:///tmp/secret",
    }).success).toBe(false);
  });

  it("validates normalized events and stream envelopes strictly", () => {
    const sessionId = randomUUID();
    const messageId = randomUUID();
    const event = AgentEventSchema.parse({
      type: "message.assistant.delta",
      messageId,
      delta: "Hallo",
    });
    expect(
      StreamEnvelopeSchema.parse({
        seq: 1,
        sessionId,
        turnId: null,
        event,
        timestamp,
      }).event.type,
    ).toBe("message.assistant.delta");
    expect(
      AgentEventSchema.safeParse({ ...event, unsafeHtml: "<script />" }).success,
    ).toBe(false);
  });

  it("keeps dropped paths internal while exposing a file-based bridge name", () => {
    expect(IPC_CHANNELS.stageDroppedPaths).toBe("attachments:stage-dropped-paths");
    expect(IPC_CHANNELS.chooseGeminiBinary).toBe(
      "settings:choose-gemini-binary",
    );
    expect(IPC_CHANNELS.chooseGitBinary).toBe("settings:choose-git-binary");
  });

  it("keeps Git diff requests opaque and rejects renderer paths or patch text", () => {
    const input = {
      projectId: randomUUID(),
      expectedRootRevision: 1,
      repositoryId: randomUUID(),
      fileId: randomUUID(),
      area: "unstaged" as const,
    };
    expect(GetGitFileDiffInputSchema.parse(input)).toEqual(input);
    expect(GetGitFileDiffInputSchema.safeParse({
      ...input,
      path: "../../outside",
    }).success).toBe(false);
    expect(GetGitFileDiffInputSchema.safeParse({
      ...input,
      patch: "diff --git a/x b/x",
    }).success).toBe(false);
    expect(IPC_CHANNELS.getGitFileDiff).toBe("git:get-file-diff");
  });

  it("types single-root reauthorization without accepting a renderer path", () => {
    const input = {
      projectId: randomUUID(),
      rootId: randomUUID(),
    };
    expect(ReauthorizeProjectRootInputSchema.parse(input)).toEqual(input);
    expect(
      ReauthorizeProjectRootInputSchema.safeParse({
        ...input,
        selectedPath: "/renderer/must/not/choose/this",
      }).success,
    ).toBe(false);
    expect(
      ProjectRootReauthorizationResultSchema.parse({ status: "cancelled" }),
    ).toEqual({ status: "cancelled" });
    expect(IPC_CHANNELS.reauthorizeProjectRoot).toBe(
      "projects:reauthorize-root",
    );
  });

  it("validates clipboard byte limits and typed Gemini settings", () => {
    expect(
      ClipboardImageInputSchema.safeParse({
        clientRequestId: randomUUID(),
        sessionId: null,
        displayName: "paste.png",
        mimeType: "image/png",
        bytes: new Uint8Array(),
      }).success,
    ).toBe(false);

    expect(GEMINI_SETTINGS_KEY).toBe("gemini.binaryPath");
    expect(GIT_SETTINGS_KEY).toBe("git.binaryPath");
    expect(
      GeminiSettingsSchema.parse({
        binaryPath: "/usr/local/bin/gemini",
        updatedAt: timestamp,
      }).binaryPath,
    ).toBe("/usr/local/bin/gemini");
  });
});
