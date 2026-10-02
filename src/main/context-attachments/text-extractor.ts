import { randomUUID } from "node:crypto";
import { utilityProcess, type UtilityProcess } from "electron";
import path from "node:path";

import type { ContextAttachmentRepository } from "../storage";
import type { ContextBlobStore } from "./blob-store";
import type { ExtractionResult } from "./extraction-worker";

const EXTRACTION_TIMEOUT_MS = 30_000;
const WORKER_IDLE_MS = 30_000;
const EXTRACTION_WORKER_PATH = path.join(__dirname, "extraction-worker.cjs");

export class ContextTextExtractor {
  readonly #queue: string[] = [];
  #running = false;
  #disposed = false;
  #activeWorker: UtilityProcess | null = null;

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
    const worker = this.#activeWorker;
    this.#activeWorker = null;
    stopWorker(worker ?? undefined);
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
      }, (worker) => { this.#activeWorker = worker; });
      if (this.#disposed) return;
      if (!result.ok || result.state === "failed") throw new Error(result.error ?? "Extraktion fehlgeschlagen");
      if (result.state === "ready" || result.state === "empty") {
        await this.blobs.writeDerivedText(attachment.file.sha256, result.text);
      }
      if (this.#disposed) return;
      this.repository.updateExtraction({
        attachmentId,
        state: result.state,
        extractedChars: result.extractedChars,
        pageCount: result.pageCount,
        truncated: result.truncated,
        error: null,
      });
    } catch (error) {
      if (this.#disposed) return;
      this.repository.updateExtraction({
        attachmentId,
        state: "failed",
        error: error instanceof Error ? error.message : "Extraktion fehlgeschlagen",
      });
    }
    if (!this.#disposed) this.onChanged(attachment.projectId);
  }
}

type ExtractionRequest = {
  requestId: string;
  filePath: string;
  mimeType: string;
};

let worker: UtilityProcess | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<string, {
  resolve: (result: ExtractionResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

function runWorker(input: ExtractionRequest, onWorker: (child: UtilityProcess | null) => void): Promise<ExtractionResult> {
  return new Promise((resolve, reject) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const child = ensureWorker();
    onWorker(child);
    const timer = setTimeout(() => {
      const task = pending.get(input.requestId);
      if (!task) return;
      pending.delete(input.requestId);
      task.reject(new Error("Die Textextraktion hat das Zeitlimit überschritten."));
      stopWorker(child);
    }, EXTRACTION_TIMEOUT_MS);
    pending.set(input.requestId, {
      resolve: (result) => { onWorker(null); resolve(result); },
      reject: (error) => { onWorker(null); reject(error); },
      timer,
    });
    try {
      child.postMessage(input);
    } catch (error) {
      const task = pending.get(input.requestId);
      if (task) {
        pending.delete(input.requestId);
        clearTimeout(task.timer);
        task.reject(new Error(`Der Extraktionsauftrag konnte nicht gesendet werden: ${messageFrom(error)}`));
      }
      stopWorker(child);
    }
  });
}

function ensureWorker(): UtilityProcess {
  if (worker) return worker;
  const child = utilityProcess.fork(EXTRACTION_WORKER_PATH, [], {
    serviceName: "GeminUI Anhangsextraktion",
  });
  worker = child;
  child.on("message", (message: unknown) => {
    const result = message as Partial<ExtractionResult>;
    if (!result.requestId) return;
    const task = pending.get(result.requestId);
    if (!task) return;
    pending.delete(result.requestId);
    clearTimeout(task.timer);
    task.resolve(result as ExtractionResult);
    if (pending.size === 0) idleTimer = setTimeout(() => stopWorker(), WORKER_IDLE_MS);
  });
  child.once("exit", () => {
    if (worker !== child) return;
    worker = null;
    for (const task of pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error("Der Extraktionsprozess wurde unerwartet beendet."));
    }
    pending.clear();
  });
  return child;
}

function stopWorker(expected?: UtilityProcess): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const child = worker;
  if (expected && expected !== child) return;
  worker = null;
  if (child) {
    for (const [requestId, task] of pending) {
      pending.delete(requestId);
      clearTimeout(task.timer);
      task.reject(new Error("Der Extraktionsprozess wurde beendet."));
    }
    child.kill();
  }
}

function messageFrom(error: unknown): string {
  return (error instanceof Error ? error.message : "unbekannter Fehler").slice(0, 300);
}
