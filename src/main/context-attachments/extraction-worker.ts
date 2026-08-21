import { readFile } from "node:fs/promises";

import { MAX_CONTEXT_CHARS_PER_ATTACHMENT } from "../../shared";
import { isTextualMime } from "./mime-sniffer";

type ExtractionRequest = {
  requestId: string;
  filePath: string;
  mimeType: string;
};

export type ExtractionResult = {
  requestId: string;
  ok: boolean;
  state: "ready" | "empty" | "unsupported" | "failed";
  text: string;
  extractedChars: number | null;
  pageCount: number | null;
  truncated: boolean;
  error: string | null;
};

const parentPort = process.parentPort;
if (parentPort) {
  parentPort.on("message", (event: { data: ExtractionRequest }) => {
    void extract(event.data).then((result) => parentPort.postMessage(result));
  });
}

export async function extract(input: ExtractionRequest): Promise<ExtractionResult> {
  try {
    if (isTextualMime(input.mimeType)) {
      const source = await readFile(input.filePath, "utf8");
      const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
      const text = normalized.slice(0, MAX_CONTEXT_CHARS_PER_ATTACHMENT);
      return {
        requestId: input.requestId,
        ok: true,
        state: text.trim() ? "ready" : "empty",
        text,
        extractedChars: normalized.length,
        pageCount: null,
        truncated: normalized.length > text.length,
        error: null,
      };
    }
    if (input.mimeType === "application/pdf") {
      return await extractPdf(input);
    }
    return {
      requestId: input.requestId,
      ok: true,
      state: "unsupported",
      text: "",
      extractedChars: null,
      pageCount: null,
      truncated: false,
      error: null,
    };
  } catch (error) {
    return {
      requestId: input.requestId,
      ok: false,
      state: "failed",
      text: "",
      extractedChars: null,
      pageCount: null,
      truncated: false,
      error: messageFrom(error),
    };
  }
}

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/**
 * pdf.js hält jeden Prozess für eine Browserumgebung, dessen `process.type`
 * gesetzt und ungleich "browser" ist. Electrons `utilityProcess` meldet
 * "utility", deshalb überspringt pdf.js hier seine eigenen Node-Polyfills und
 * scheitert bereits beim Modulimport an "DOMMatrix is not defined"; zusätzlich
 * würde es einen `Worker`-Konstruktor bzw. `GlobalWorkerOptions.workerSrc`
 * verlangen, die es in diesem Prozess ebenfalls nicht gibt.
 *
 * Dieser Worker extrahiert ausschließlich Text und rastert nichts, daher
 * genügen inerte Platzhalter für die fehlenden Zeichen-APIs. Der pdf.js-Worker
 * wird über `globalThis.pdfjsWorker` im selben Prozess registriert, damit zur
 * Laufzeit keine separate Worker-Datei aus dem Bundle aufgelöst werden muss.
 */
async function loadPdfJs(): Promise<PdfJsModule> {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.DOMMatrix ??= class DOMMatrixPlaceholder {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;
  };
  globals.Path2D ??= class Path2DPlaceholder {};
  globals.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

async function extractPdf(input: ExtractionRequest): Promise<ExtractionResult> {
  const [{ getDocument }, bytes] = await Promise.all([
    loadPdfJs(),
    readFile(input.filePath),
  ]);
  const loading = getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false });
  const document = await loading.promise;
  let text = "";
  let extractedChars = 0;
  const pageLimit = Math.min(document.numPages, 200);
  try {
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .filter(Boolean)
        .join(" ")
        .replace(/\r\n?/g, "\n");
      extractedChars += pageText.length + (pageNumber > 1 ? 2 : 0);
      if (text.length < MAX_CONTEXT_CHARS_PER_ATTACHMENT) {
        const separator = pageNumber > 1 ? "\n\n" : "";
        text = (text + separator + pageText).slice(0, MAX_CONTEXT_CHARS_PER_ATTACHMENT);
      }
      page.cleanup();
    }
  } finally {
    await loading.destroy();
  }
  const empty = !text.trim();
  return {
    requestId: input.requestId,
    ok: true,
    state: empty ? "empty" : "ready",
    text,
    extractedChars,
    pageCount: document.numPages,
    truncated: document.numPages > pageLimit || extractedChars > text.length,
    error: null,
  };
}

function messageFrom(error: unknown): string {
  return (error instanceof Error ? error.message : "Textextraktion fehlgeschlagen").slice(0, 500);
}
