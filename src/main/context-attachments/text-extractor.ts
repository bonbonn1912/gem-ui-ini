import { randomUUID } from "node:crypto";
import { utilityProcess, type UtilityProcess } from "electron";
import path from "node:path";

import type { ContextAttachmentRepository } from "../storage";
import type { ContextBlobStore } from "./blob-store";
import type { ExtractionResult } from "./extraction-worker";

const EXTRACTION_TIMEOUT_MS = 30_000;

export class ContextTextExtractor {
  readonly #queue: string[] = [];
  #running = false;
  #disposed = false;

  constructor(
    private readonly blobs: ContextBlobStore,
    private readonly repository: ContextAttachmentRepository,
    private readonly onChanged: (projectId: string) => void,
  ) {}

  enqueue(attachmentId: string): void {
    if (this.#disposed || this.#queue.includes(attachmentId)) return;
    this.#queue.push(attachmentId);
    void this.#drain();
  }

  dispose(): void {
    this.#disposed = true;
    this.#queue.length = 0;
  }

  async #drain(): Promise<void> {
    if (this.#running || this.#disposed) return;
    this.#running = true;
    try {
      while (!this.#disposed) {
        const attachmentId = this.#queue.shift();
        if (!attachmentId) break;
        await this.#extractOne(attachmentId);
      }
    } finally {
      this.#running = false;
    }
  }

  async #extractOne(attachmentId: string): Promise<void> {
    let attachment;
    try {
      attachment = this.repository.getInternal(attachmentId);
    } catch {
      return;
    }
    if (!attachment.file || !attachment.internalFile) return;
    this.repository.updateExtraction({ attachmentId, state: "running" });
    this.onChanged(attachment.projectId);
    const filePath = this.blobs.blobPath(attachment.file.sha256);
    try {
      const result = await runWorker({
        requestId: randomUUID(),
        filePath,
        mimeType: attachment.file.mimeType,
      });
      if (!result.ok || result.state === "failed") throw new Error(result.error ?? "Extraktion fehlgeschlagen");
      if (result.state === "ready" || result.state === "empty") {
        await this.blobs.writeDerivedText(attachment.file.sha256, result.text);
      }
      this.repository.updateExtraction({
        attachmentId,
        state: result.state,
        extractedChars: result.extractedChars,
        pageCount: result.pageCount,
        error: null,
      });
    } catch (error) {
      this.repository.updateExtraction({
        attachmentId,
        state: "failed",
        error: error instanceof Error ? error.message : "Extraktion fehlgeschlagen",
      });
    }
    this.onChanged(attachment.projectId);
  }
}

function runWorker(input: {
  requestId: string;
  filePath: string;
  mimeType: string;
}): Promise<ExtractionResult> {
  return new Promise((resolve, reject) => {
    const child: UtilityProcess = utilityProcess.fork(
      path.join(__dirname, "extraction-worker.cjs"),
      [],
      { serviceName: "GeminUI Anhangsextraktion" },
    );
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
      child.kill();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error("Die Textextraktion hat das Zeitlimit überschritten.")));
    }, EXTRACTION_TIMEOUT_MS);
    child.once("message", (message: unknown) => {
      const result = message as Partial<ExtractionResult>;
      if (result.requestId !== input.requestId) return;
      finish(() => resolve(result as ExtractionResult));
    });
    child.once("exit", () => {
      finish(() => reject(new Error("Der Extraktionsprozess wurde unerwartet beendet.")));
    });
    child.postMessage(input);
  });
}
