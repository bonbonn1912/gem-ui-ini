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

async function extractPdf(input: ExtractionRequest): Promise<ExtractionResult> {
  const [{ getDocument }, bytes] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
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
