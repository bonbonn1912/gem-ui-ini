import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  workers: [] as Array<{
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => boolean;
  }>,
  postMessageError: null as Error | null,
}));

vi.mock("electron", () => ({
  utilityProcess: {
    fork: vi.fn(() => {
      const emitter = new EventEmitter();
      const child = Object.assign(emitter, {
        postMessage: vi.fn((message: unknown) => {
          if (harness.postMessageError) throw harness.postMessageError;
          return message;
        }),
        kill: vi.fn(() => { setImmediate(() => emitter.emit("exit", 0)); }),
      });
      harness.workers.push(child as never);
      return child;
    }),
  },
}));

import { ContextTextExtractor } from "../../src/main/context-attachments/text-extractor";

afterEach(() => {
  harness.workers.length = 0;
  harness.postMessageError = null;
  vi.resetModules();
  vi.clearAllMocks();
});

function createExtractor() {
  const updates: Array<{ attachmentId: string; state: string }> = [];
  const attachment = {
    projectId: "project",
    file: { sha256: "hash", mimeType: "text/plain" },
    internalFile: true,
  };
  const repository = {
    getInternal: vi.fn(() => attachment),
    updateExtraction: vi.fn((input: { attachmentId: string; state: string }) => updates.push(input)),
  };
  const blobs = {
    blobPath: vi.fn(() => "/blob/file.txt"),
    writeDerivedText: vi.fn(async () => undefined),
  };
  const extractor = new ContextTextExtractor(blobs as never, repository as never, vi.fn());
  return { extractor, repository, updates };
}

describe("ContextTextExtractor worker lifecycle", () => {
  it("kills the pooled worker on disposal and ignores any late result", async () => {
    const { extractor, repository, updates } = createExtractor();
    extractor.enqueue("attachment");
    await vi.waitFor(() => expect(harness.workers).toHaveLength(1));
    const worker = harness.workers[0]!;
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());

    extractor.dispose();
    expect(worker.kill).toHaveBeenCalledOnce();
    worker.emit("message", {
      requestId: (worker.postMessage.mock.calls[0]![0] as { requestId: string }).requestId,
      ok: true,
      state: "ready",
      text: "late",
      extractedChars: 4,
      pageCount: null,
      truncated: false,
      error: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(repository.updateExtraction).toHaveBeenCalledTimes(1);
    expect(updates[0]).toMatchObject({ state: "running" });
    expect(repository.updateExtraction).not.toHaveBeenCalledWith(expect.objectContaining({ state: "ready" }));
  });

  it("clears failed sends so a later extraction can start a fresh worker", async () => {
    harness.postMessageError = new Error("closed pipe");
    const { extractor, repository } = createExtractor();
    extractor.enqueue("first");
    await vi.waitFor(() => expect(repository.updateExtraction).toHaveBeenCalledWith(expect.objectContaining({ state: "failed" })));
    harness.postMessageError = null;
    extractor.enqueue("second");
    await vi.waitFor(() => expect(harness.workers).toHaveLength(2));
    expect(harness.workers[1]!.postMessage).toHaveBeenCalledOnce();
    extractor.dispose();
  });
});
