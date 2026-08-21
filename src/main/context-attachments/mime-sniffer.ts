import path from "node:path";

import { detectImageMime } from "../attachments/attachment-service";

const TEXT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".js": "text/javascript",
  ".jsx": "text/jsx",
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".css": "text/css",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".sql": "application/sql",
  ".py": "text/x-python",
  ".java": "text/x-java-source",
  ".kt": "text/x-kotlin",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".sh": "application/x-sh",
};

export function sniffMime(bytes: Uint8Array, displayName: string): string {
  const image = detectImageMime(bytes);
  if (image) return image;
  if (startsWithAscii(bytes, "%PDF-")) return "application/pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return "application/zip";
  }
  if (!looksLikeUtf8Text(bytes)) return "application/octet-stream";
  return TEXT_MIME_BY_EXTENSION[path.extname(displayName).toLowerCase()] ?? "text/plain";
}

export function isTextualMime(mimeType: string): boolean {
  return mimeType.startsWith("text/") || [
    "application/json",
    "application/x-ndjson",
    "application/xml",
    "application/yaml",
    "application/toml",
    "application/sql",
    "application/x-sh",
  ].includes(mimeType);
}

export function syntaxLanguage(mimeType: string, displayName: string): string {
  const extension = path.extname(displayName).toLowerCase();
  const byExtension: Readonly<Record<string, string>> = {
    ".md": "markdown",
    ".markdown": "markdown",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".json": "json",
    ".jsonl": "json",
    ".csv": "csv",
    ".tsv": "tsv",
    ".py": "python",
    ".java": "java",
    ".kt": "kotlin",
    ".go": "go",
    ".rs": "rust",
    ".sh": "bash",
    ".css": "css",
    ".html": "html",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".sql": "sql",
  };
  return byExtension[extension] ?? (mimeType === "application/pdf" ? "text" : "text");
}

function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  if (bytes.length < value.length) return false;
  return [...value].every((character, index) => bytes[index] === character.charCodeAt(0));
}
