import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  mkdir,
  lstat,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { MAX_CONTEXT_FILE_BYTES } from "../../shared";

const READ_CHUNK_BYTES = 64 * 1024;
const SNIFF_BYTES = 8 * 1024;

export type StoredBlob = {
  sha256: string;
  size: number;
  storageDir: string;
  fileName: string;
  sniffBytes: Uint8Array;
};

export class ContextBlobStore {
  readonly rootDirectory: string;
  readonly blobsDirectory: string;
  readonly derivedDirectory: string;
  readonly linkPreviewsDirectory: string;

  constructor(userDataDirectory: string) {
    if (!path.isAbsolute(userDataDirectory)) throw new TypeError("userData must be absolute");
    this.rootDirectory = path.join(userDataDirectory, "context-attachments");
    this.blobsDirectory = path.join(this.rootDirectory, "blobs");
    this.derivedDirectory = path.join(this.rootDirectory, "derived");
    this.linkPreviewsDirectory = path.join(this.rootDirectory, "link-previews");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.blobsDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.derivedDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.linkPreviewsDirectory, { recursive: true, mode: 0o700 }),
    ]);
  }

  async ingest(filePath: string): Promise<StoredBlob> {
    if (!path.isAbsolute(filePath)) throw new Error("Dateipfade müssen absolut sein.");
    const source = await open(filePath, constants.O_RDONLY | noFollowFlag());
    const temporaryPath = path.join(this.blobsDirectory, `.incoming-${randomUUID()}`);
    const target = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      const metadata = await source.stat();
      if (!metadata.isFile()) throw new Error("Nur reguläre Dateien können angehängt werden.");
      if (metadata.size < 1 || metadata.size > MAX_CONTEXT_FILE_BYTES) {
        throw new Error(`Dateien müssen zwischen 1 Byte und ${MAX_CONTEXT_FILE_BYTES / 1024 / 1024} MiB groß sein.`);
      }
      const hash = createHash("sha256");
      const sniff = Buffer.alloc(Math.min(SNIFF_BYTES, metadata.size));
      const chunk = Buffer.alloc(READ_CHUNK_BYTES);
      let offset = 0;
      let sniffOffset = 0;
      while (offset < metadata.size) {
        const { bytesRead } = await source.read(chunk, 0, Math.min(chunk.length, metadata.size - offset), offset);
        if (bytesRead <= 0) throw new Error("Die Datei konnte nicht vollständig gelesen werden.");
        const view = chunk.subarray(0, bytesRead);
        hash.update(view);
        await target.write(view, 0, bytesRead, offset);
        if (sniffOffset < sniff.length) {
          const count = Math.min(sniff.length - sniffOffset, bytesRead);
          view.copy(sniff, sniffOffset, 0, count);
          sniffOffset += count;
        }
        offset += bytesRead;
      }
      await target.sync();
      const sha256 = hash.digest("hex");
      const storageDir = path.join(this.blobsDirectory, sha256.slice(0, 2));
      const destination = path.join(storageDir, sha256);
      await mkdir(storageDir, { recursive: true, mode: 0o700 });
      try {
        await rename(temporaryPath, destination);
      } catch (error) {
        if (!isDestinationExists(error)) throw error;
        await rm(temporaryPath, { force: true });
      }
      return {
        sha256,
        size: metadata.size,
        storageDir,
        fileName: sha256,
        sniffBytes: sniff,
      };
    } finally {
      await Promise.allSettled([source.close(), target.close()]);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  blobPath(sha256: string): string {
    assertSha256(sha256);
    return this.assertInside(this.blobsDirectory, path.join(this.blobsDirectory, sha256.slice(0, 2), sha256));
  }

  derivedTextPath(sha256: string): string {
    assertSha256(sha256);
    return this.assertInside(this.derivedDirectory, path.join(this.derivedDirectory, sha256, "text.txt"));
  }

  async writeDerivedText(sha256: string, text: string): Promise<string> {
    const destination = this.derivedTextPath(sha256);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!isDestinationExists(error)) throw error;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return destination;
  }

  async writeLinkPreviewImage(attachmentId: string, bytes: Uint8Array, extension: string): Promise<string> {
    if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) throw new Error("Ungültige Anhang-ID");
    const directory = this.assertInside(this.linkPreviewsDirectory, path.join(this.linkPreviewsDirectory, attachmentId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = this.assertInside(directory, path.join(directory, `image.${extension}`));
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    return destination;
  }

  async removeUnreferenced(sha256: string): Promise<void> {
    await Promise.all([
      rm(this.blobPath(sha256), { force: true }),
      rm(path.dirname(this.derivedTextPath(sha256)), { recursive: true, force: true }),
    ]);
  }

  async removeLinkPreview(attachmentId: string): Promise<void> {
    const directory = this.assertInside(this.linkPreviewsDirectory, path.join(this.linkPreviewsDirectory, attachmentId));
    await rm(directory, { recursive: true, force: true });
  }

  async cleanup(referencedHashes: ReadonlySet<string>): Promise<void> {
    await this.initialize();
    const prefixes = await readdir(this.blobsDirectory, { withFileTypes: true });
    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/.test(prefix.name)) continue;
      const directory = path.join(this.blobsDirectory, prefix.name);
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && /^[0-9a-f]{64}$/.test(entry.name) && !referencedHashes.has(entry.name)) {
          await rm(path.join(directory, entry.name), { force: true });
        }
      }
    }
    const derived = await readdir(this.derivedDirectory, { withFileTypes: true });
    for (const entry of derived) {
      if (entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name) && !referencedHashes.has(entry.name)) {
        await rm(path.join(this.derivedDirectory, entry.name), { recursive: true, force: true });
      }
    }
  }

  async assertReadableFile(candidate: string, root: string): Promise<string> {
    const safe = this.assertInside(root, candidate);
    const linkMetadata = await lstat(safe);
    if (linkMetadata.isSymbolicLink()) {
      throw new Error("Symbolische Links sind im geschützten Anhangsspeicher nicht erlaubt.");
    }
    const [resolvedRoot, resolvedCandidate] = await Promise.all([realpath(root), realpath(safe)]);
    this.assertInside(resolvedRoot, resolvedCandidate);
    const metadata = await stat(resolvedCandidate);
    if (!metadata.isFile()) throw new Error("Die gespeicherte Datei ist nicht mehr verfügbar.");
    return resolvedCandidate;
  }

  private assertInside(root: string, candidate: string): string {
    const relative = path.relative(root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Der gespeicherte Anhangspfad liegt außerhalb des geschützten Speichers.");
    }
    return candidate;
  }
}

function assertSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError("Expected a SHA-256 value");
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function isDestinationExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}
