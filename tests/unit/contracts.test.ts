import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AgentEventSchema,
  AppProjectSchema,
  ClipboardImageInputSchema,
  CreateProjectInputSchema,
  GEMINI_SETTINGS_KEY,
  GeminiSettingsSchema,
  IPC_CHANNELS,
  MAX_ADDITIONAL_ROOTS,
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
    expect(
      GeminiSettingsSchema.parse({
        binaryPath: "/usr/local/bin/gemini",
        updatedAt: timestamp,
      }).binaryPath,
    ).toBe("/usr/local/bin/gemini");
  });
});
