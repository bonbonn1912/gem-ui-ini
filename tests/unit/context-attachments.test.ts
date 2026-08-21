import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ContextBlobStore } from "../../src/main/context-attachments/blob-store";
import { sniffMime } from "../../src/main/context-attachments/mime-sniffer";
import { buildContextParts, type PromptContextSource } from "../../src/main/context-attachments/prompt-context-builder";
import { parseHtmlMetadata } from "../../src/main/links/html-metadata-parser";
import { isPublicAddress, normalizeUrl } from "../../src/main/links/url-policy";
import { ContextAttachmentSchema, MAX_CONTEXT_CHARS_PER_ATTACHMENT } from "../../src/shared";
import type { ContextAttachment } from "../../src/shared";

const temporaryDirectories: string[] = [];
const timestamp = "2026-08-21T09:00:00.000Z";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

function attachment(input: {
  id: string;
  scope?: "project" | "session";
  title: string;
  kind: "file" | "link";
  origin?: "manual" | "chat";
  mimeType?: string;
  extractedChars?: number | null;
  renderable?: boolean;
}): ContextAttachment {
  const scope = input.scope ?? "project";
  return ContextAttachmentSchema.parse({
    id: input.id,
    projectId: "10000000-0000-4000-8000-000000000001",
    scope,
    sessionId: scope === "session" ? "20000000-0000-4000-8000-000000000002" : null,
    kind: input.kind,
    origin: input.origin ?? "manual",
    title: input.title,
    note: null,
    sortOrder: 0,
    includedInContext: true,
    estimatedTokens: 10,
    file: input.kind === "file" ? {
      displayName: input.title,
      mimeType: input.mimeType ?? "text/plain",
      size: 12,
      sha256: "a".repeat(64),
      extractionState: "ready",
      extractedChars: input.extractedChars ?? 12,
      pageCount: null,
      extractionError: null,
      renderable: input.renderable ?? false,
    } : null,
    link: input.kind === "link" ? {
      url: "https://docs.example.com/ticket?q=42",
      host: "docs.example.com",
      previewState: "ready",
      previewTitle: "Ticket 42",
      previewDescription: "Fehlerbeschreibung",
      previewSiteName: "Docs",
      hasPreviewImage: false,
      previewError: null,
      fetchedAt: timestamp,
    } : null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

describe("dauerhafte Kontextanhänge", () => {
  it("normalisiert ausschließlich sichere HTTPS-URLs und erhält die Query", () => {
    expect(normalizeUrl("HTTPS://BÜCHER.Example:443/a?q=JIRA-42#details").toString())
      .toBe("https://xn--bcher-kva.example/a?q=JIRA-42");
    for (const value of [
      "http://example.com",
      "file:///tmp/a",
      "javascript:alert(1)",
      "https://user:secret@example.com",
    ]) {
      expect(() => normalizeUrl(value)).toThrow();
    }
  });

  it("blockiert lokale, private und Link-Local-Adressen", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("erkennt Bilder, PDF, ZIP, UTF-8-Text und Binärdaten anhand ihres Inhalts", () => {
    expect(sniffMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "x.bin")).toBe("image/png");
    expect(sniffMime(Uint8Array.from([0xff, 0xd8, 0xff]), "x.bin")).toBe("image/jpeg");
    expect(sniffMime(new TextEncoder().encode("RIFF0000WEBP"), "x.bin")).toBe("image/webp");
    expect(sniffMime(new TextEncoder().encode("GIF89a"), "x.bin")).toBe("image/gif");
    expect(sniffMime(new TextEncoder().encode("%PDF-1.7"), "x.txt")).toBe("application/pdf");
    expect(sniffMime(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]), "x.txt")).toBe("application/zip");
    expect(sniffMime(new TextEncoder().encode("const ok = true;"), "code.ts")).toBe("text/typescript");
    expect(sniffMime(Uint8Array.from([0, 1, 2, 3]), "fake.png")).toBe("application/octet-stream");
  });

  it("baut Kontextblöcke in Reihenfolge und fällt bei nicht unterstützten Bildern lesbar zurück", () => {
    const sources: PromptContextSource[] = [
      {
        attachment: attachment({ id: "30000000-0000-4000-8000-000000000003", title: "Ticket", kind: "link" }),
        text: null,
        imageData: null,
      },
      {
        attachment: attachment({ id: "30000000-0000-4000-8000-000000000004", scope: "session", title: "Code.ts", kind: "file", mimeType: "text/typescript" }),
        text: "export const answer = 42;",
        imageData: null,
      },
      {
        attachment: attachment({ id: "30000000-0000-4000-8000-000000000005", title: "Screenshot.png", kind: "file", mimeType: "image/png", renderable: true }),
        text: null,
        imageData: "iVBORw0KGgo=",
      },
    ];
    const result = buildContextParts({ sources, imagesSupported: false });
    expect(result.parts[0]).toMatchObject({ type: "text", text: expect.stringContaining("3 Anhänge") });
    expect(result.parts.map((part) => part.type)).toEqual(["text", "text", "text", "text", "text"]);
    expect(result.parts[1]).toMatchObject({ text: expect.stringContaining("URL: https://docs.example.com") });
    expect(result.parts[2]).toMatchObject({ text: expect.stringContaining("```typescript") });
    expect(result.parts.at(-1)).toMatchObject({ text: expect.stringContaining("keine Unterstützung für Bild-Prompts") });
    expect(result.snapshots.map(({ title }) => title)).toEqual(["Ticket", "Code.ts", "Screenshot.png"]);
  });

  it("lehnt einen Anhangskontext oberhalb des Gesamtbudgets klar ab", () => {
    const sources = Array.from({ length: 5 }, (_, index): PromptContextSource => ({
      attachment: attachment({
        id: `30000000-0000-4000-8000-00000000000${index + 1}`,
        title: `Dokument ${index + 1}`,
        kind: "file",
        extractedChars: MAX_CONTEXT_CHARS_PER_ATTACHMENT,
      }),
      text: "x",
      imageData: null,
    }));
    expect(() => buildContextParts({ sources, imagesSupported: true })).toThrow(/überschreitet 240\.000 Zeichen/);
  });

  it("parst Linkmetadaten als Text und löst nur HTTPS-Bilder auf", () => {
    const metadata = parseHtmlMetadata(`
      <title>Fallback</title>
      <meta property="og:title" content="Ticket &amp; Details">
      <meta property="og:description" content="Eine Beschreibung">
      <meta property="og:site_name" content="Jira">
      <meta property="og:image" content="/preview.png">
    `, new URL("https://jira.example.com/browse/42"));
    expect(metadata).toEqual({
      title: "Ticket & Details",
      description: "Eine Beschreibung",
      siteName: "Jira",
      imageUrl: "https://jira.example.com/preview.png",
    });
  });

  it("weist Symlinks aus dem geschützten Blob-Speicher zurück", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "geminui-context-test-"));
    temporaryDirectories.push(root);
    const store = new ContextBlobStore(root);
    await store.initialize();
    const outside = path.join(root, "outside.txt");
    const previewDirectory = path.join(store.linkPreviewsDirectory, "safe");
    const linked = path.join(previewDirectory, "image.png");
    await writeFile(outside, "secret");
    await mkdir(previewDirectory, { recursive: true });
    await symlink(outside, linked);
    await expect(store.assertReadableFile(linked, store.linkPreviewsDirectory)).rejects.toThrow(/Symbolische Links/);
  });
});
