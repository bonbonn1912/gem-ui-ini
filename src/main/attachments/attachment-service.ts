import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PROMPT_BYTES = 25 * 1024 * 1024;
const MAX_PROMPT_IMAGES = 4;

export type SupportedImageMime =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

export type AttachmentRecord = {
  id: string;
  sessionId: string | null;
  turnId: string | null;
  displayName: string;
  mimeType: SupportedImageMime;
  size: number;
  sha256: string;
  storagePath: string;
  status: "staged" | "sent";
  createdAt: string;
};

export type AttachmentView = Omit<AttachmentRecord, "storagePath">;

export interface AttachmentPersistence {
  save(record: AttachmentRecord): void | Promise<void>;
  find(id: string): AttachmentRecord | null | Promise<AttachmentRecord | null>;
  remove(id: string): void | Promise<void>;
}

export class InMemoryAttachmentPersistence implements AttachmentPersistence {
  readonly #records = new Map<string, AttachmentRecord>();

  save(record: AttachmentRecord): void {
    this.#records.set(record.id, record);
  }

  find(id: string): AttachmentRecord | null {
    return this.#records.get(id) ?? null;
  }

  remove(id: string): void {
    this.#records.delete(id);
  }
}

export class AttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

export class AttachmentService {
  readonly #directory: string;
  readonly #persistence: AttachmentPersistence;

  constructor(appDataDirectory: string, persistence: AttachmentPersistence) {
    this.#directory = path.join(appDataDirectory, "attachments");
    this.#persistence = persistence;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
  }

  async stageFile(input: {
    filePath: string;
    sessionId?: string | null;
  }): Promise<AttachmentView> {
    const handle = await open(input.filePath, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new AttachmentValidationError("Der Anhang ist keine reguläre Datei.");
      }
      if (stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) {
        throw new AttachmentValidationError(
          `Bilder müssen zwischen 1 Byte und ${MAX_IMAGE_BYTES / 1024 / 1024} MiB groß sein.`,
        );
      }
      const bytes = await handle.readFile();
      return this.stageBytes({
        bytes,
        displayName: safeDisplayName(path.basename(input.filePath)),
        sessionId: input.sessionId,
      });
    } finally {
      await handle.close();
    }
  }

  async stageBytes(input: {
    bytes: Uint8Array;
    displayName?: string;
    declaredMimeType?: string;
    sessionId?: string | null;
  }): Promise<AttachmentView> {
    if (input.bytes.byteLength <= 0 || input.bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new AttachmentValidationError(
        `Bilder müssen zwischen 1 Byte und ${MAX_IMAGE_BYTES / 1024 / 1024} MiB groß sein.`,
      );
    }

    const mimeType = detectImageMime(input.bytes);
    if (!mimeType) {
      throw new AttachmentValidationError(
        "Nur PNG-, JPEG-, WebP- und GIF-Bilder werden unterstützt.",
      );
    }
    if (
      input.declaredMimeType &&
      input.declaredMimeType !== "application/octet-stream" &&
      input.declaredMimeType !== mimeType
    ) {
      throw new AttachmentValidationError(
        "Der angegebene Dateityp stimmt nicht mit dem Bildinhalt überein.",
      );
    }

    await this.initialize();
    const id = randomUUID();
    const extension = extensionForMime(mimeType);
    const storagePath = path.join(this.#directory, `${id}.${extension}`);
    const handle = await open(storagePath, "wx", 0o600);
    try {
      await handle.writeFile(input.bytes);
    } finally {
      await handle.close();
    }

    const record: AttachmentRecord = {
      id,
      sessionId: input.sessionId ?? null,
      turnId: null,
      displayName: safeDisplayName(input.displayName ?? `Bild.${extension}`),
      mimeType,
      size: input.bytes.byteLength,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      storagePath,
      status: "staged",
      createdAt: new Date().toISOString(),
    };

    try {
      await this.#persistence.save(record);
    } catch (error) {
      await unlink(storagePath).catch(() => undefined);
      throw error;
    }
    return toAttachmentView(record);
  }

  async getPreviewBytes(id: string): Promise<Uint8Array> {
    const record = await this.#requireRecord(id);
    const bytes = await readFile(record.storagePath);
    if (bytes.byteLength !== record.size || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new AttachmentValidationError("Der gespeicherte Anhang ist ungültig.");
    }
    return Uint8Array.from(bytes);
  }

  async getPromptImages(ids: string[]): Promise<
    Array<{ id: string; mimeType: SupportedImageMime; data: string }>
  > {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0 || uniqueIds.length > MAX_PROMPT_IMAGES) {
      throw new AttachmentValidationError(
        `Pro Nachricht sind maximal ${MAX_PROMPT_IMAGES} Bilder erlaubt.`,
      );
    }

    const images = [];
    let totalBytes = 0;
    for (const id of uniqueIds) {
      const record = await this.#requireRecord(id);
      const bytes = await readFile(record.storagePath);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_PROMPT_BYTES) {
        throw new AttachmentValidationError(
          `Alle Bilder zusammen dürfen maximal ${MAX_PROMPT_BYTES / 1024 / 1024} MiB groß sein.`,
        );
      }
      images.push({ id, mimeType: record.mimeType, data: bytes.toString("base64") });
    }
    return images;
  }

  async remove(id: string): Promise<void> {
    const record = await this.#persistence.find(id);
    if (!record) return;
    await this.#persistence.remove(id);
    await unlink(record.storagePath).catch(() => undefined);
  }

  async #requireRecord(id: string): Promise<AttachmentRecord> {
    const record = await this.#persistence.find(id);
    if (!record) {
      throw new AttachmentValidationError("Der Anhang wurde nicht gefunden.");
    }
    return record;
  }
}

export function detectImageMime(bytes: Uint8Array): SupportedImageMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  const gifHeader = ascii(bytes, 0, 6);
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
    return "image/gif";
  }
  return null;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

function extensionForMime(mimeType: SupportedImageMime): string {
  return {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  }[mimeType];
}

function safeDisplayName(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || "Bild").slice(0, 180);
}

function toAttachmentView(record: AttachmentRecord): AttachmentView {
  const { storagePath: _storagePath, ...view } = record;
  return view;
}
