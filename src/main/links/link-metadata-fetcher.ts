import { session, type Session } from "electron";

import { detectImageMime } from "../attachments/attachment-service";
import { parseHtmlMetadata, type HtmlMetadata } from "./html-metadata-parser";
import { assertPublicUrl } from "./url-policy";

const PAGE_BYTES_LIMIT = 512 * 1024;
const IMAGE_BYTES_LIMIT = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;

export type LinkMetadataResult = HtmlMetadata & {
  finalUrl: URL;
  unauthorized: boolean;
  image: { bytes: Uint8Array; mimeType: string; extension: string } | null;
};

export class LinkMetadataFetcher {
  readonly previewSession: Session;

  constructor() {
    this.previewSession = session.fromPartition("persist:geminui-link-preview");
  }

  async fetch(value: string): Promise<LinkMetadataResult> {
    const { response, url } = await this.follow(value, PAGE_BYTES_LIMIT);
    if (response.status === 401 || response.status === 403) {
      return emptyResult(url, true);
    }
    if (!response.ok) throw new Error(`Die Seite antwortete mit HTTP ${response.status}.`);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!contentType || !["text/html", "application/xhtml+xml"].includes(contentType)) {
      throw new Error("Die Adresse liefert keine HTML-Seite.");
    }
    const bytes = await readLimited(response, PAGE_BYTES_LIMIT);
    const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const metadata = parseHtmlMetadata(html, url);
    const unauthorized = looksLikeLogin(url, metadata);
    let image: LinkMetadataResult["image"] = null;
    if (!unauthorized && metadata.imageUrl) {
      try {
        const imageResponse = await this.follow(metadata.imageUrl, IMAGE_BYTES_LIMIT);
        if (imageResponse.response.ok) {
          const imageBytes = await readLimited(imageResponse.response, IMAGE_BYTES_LIMIT);
          const mimeType = detectImageMime(imageBytes);
          if (mimeType) image = { bytes: imageBytes, mimeType, extension: extensionForMime(mimeType) };
        }
      } catch {
        // Metadata remains useful when only the optional preview image fails.
      }
    }
    return { ...metadata, finalUrl: url, unauthorized, image };
  }

  private async follow(value: string, limit: number): Promise<{ response: Response; url: URL }> {
    let url = await assertPublicUrl(value);
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await this.previewSession.fetch(url.toString(), {
          redirect: "manual",
          signal: controller.signal,
          headers: { "accept": "text/html,application/xhtml+xml,image/*;q=0.8" },
        });
      } finally {
        clearTimeout(timer);
      }
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > limit) {
        throw new Error("Die Vorschauantwort ist zu groß.");
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url };
      if (redirect === MAX_REDIRECTS) throw new Error("Die Seite leitet zu oft weiter.");
      const location = response.headers.get("location");
      if (!location) throw new Error("Die Seite meldet eine ungültige Weiterleitung.");
      url = await assertPublicUrl(new URL(location, url));
    }
    throw new Error("Die Seite konnte nicht geladen werden.");
  }
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error("Die Vorschauantwort ist zu groß.");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function looksLikeLogin(url: URL, metadata: HtmlMetadata): boolean {
  const value = `${url.pathname} ${metadata.title ?? ""}`.toLowerCase();
  return /(?:login|sign[ -]?in|anmelden|auth)/.test(value);
}

function extensionForMime(mimeType: string): string {
  return mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
}

function emptyResult(url: URL, unauthorized: boolean): LinkMetadataResult {
  return {
    finalUrl: url,
    unauthorized,
    title: null,
    description: null,
    siteName: null,
    imageUrl: null,
    image: null,
  };
}
