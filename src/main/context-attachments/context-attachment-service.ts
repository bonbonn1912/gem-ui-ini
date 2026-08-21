import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  AddContextFilesInputSchema,
  AddContextLinkInputSchema,
  ContextAttachmentBytesInputSchema,
  ListContextAttachmentsInputSchema,
  MAX_CONTEXT_ATTACHMENTS_PER_PROMPT,
  RemoveContextAttachmentInputSchema,
  SetContextInclusionInputSchema,
  UpdateContextAttachmentInputSchema,
  type AddContextFilesInput,
  type AddContextLinkInput,
  type ContextAttachmentBytesInput,
  type ContextAttachmentList,
  type ListContextAttachmentsInput,
  type RemoveContextAttachmentInput,
  type SetContextInclusionInput,
  type UpdateContextAttachmentInput,
} from "../../shared";
import type { ProjectService } from "../projects";
import type {
  ContextAttachmentRepository,
  SessionRepository,
  StoredContextAttachment,
} from "../storage";
import { LinkMetadataFetcher, normalizeUrl } from "../links";
import { ContextBlobStore } from "./blob-store";
import { sniffMime } from "./mime-sniffer";
import {
  buildContextParts,
  type ContextAttachmentSnapshot,
  type PromptContextSource,
} from "./prompt-context-builder";
import { ContextTextExtractor } from "./text-extractor";
import type { PromptPart } from "../gemini";

type ChangeListener = (projectId: string) => void;

export class ContextAttachmentService {
  readonly blobs: ContextBlobStore;
  readonly #extractor: ContextTextExtractor;
  readonly #listeners = new Set<ChangeListener>();
  readonly #previewJobs = new Set<string>();

  constructor(
    userDataDirectory: string,
    private readonly repository: ContextAttachmentRepository,
    private readonly projects: ProjectService,
    private readonly sessions: SessionRepository,
    private readonly linkFetcher: LinkMetadataFetcher,
  ) {
    this.blobs = new ContextBlobStore(userDataDirectory);
    this.#extractor = new ContextTextExtractor(
      this.blobs,
      repository,
      (projectId) => this.#emit(projectId),
    );
  }

  async initialize(): Promise<void> {
    await this.blobs.initialize();
    void this.blobs.cleanup(this.repository.referencedHashes()).catch(() => undefined);
  }

  dispose(): void {
    this.#extractor.dispose();
    this.#listeners.clear();
  }

  subscribe(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  list(input: ListContextAttachmentsInput): ContextAttachmentList {
    const parsed = ListContextAttachmentsInputSchema.parse(input);
    this.#assertTarget(parsed.projectId, parsed.sessionId);
    return this.repository.list(parsed.projectId, parsed.sessionId);
  }

  async addFiles(input: AddContextFilesInput): Promise<ContextAttachmentList> {
    const parsed = AddContextFilesInputSchema.parse(input);
    this.#assertTarget(parsed.projectId, parsed.sessionId, parsed.scope);
    for (const filePath of parsed.paths) {
      const blob = await this.blobs.ingest(filePath);
      const duplicate = this.repository.findDuplicate(parsed.projectId, parsed.sessionId, blob.sha256);
      if (duplicate) continue;
      const displayName = safeDisplayName(path.basename(filePath));
      const mimeType = sniffMime(blob.sniffBytes, displayName);
      const attachment = this.repository.insertFile({
        id: randomUUID(),
        projectId: parsed.projectId,
        scope: parsed.scope,
        sessionId: parsed.sessionId,
        title: displayName,
        displayName,
        mimeType,
        size: blob.size,
        sha256: blob.sha256,
        storageDir: blob.storageDir,
        fileName: blob.fileName,
        defaultInclude: parsed.scope === "session",
        createdAt: new Date().toISOString(),
      });
      this.#extractor.enqueue(attachment.id);
    }
    this.#emit(parsed.projectId);
    return this.repository.list(parsed.projectId, parsed.sessionId);
  }

  async addLink(input: AddContextLinkInput): Promise<ContextAttachmentList> {
    const parsed = AddContextLinkInputSchema.parse(input);
    this.#assertTarget(parsed.projectId, parsed.sessionId, parsed.scope);
    const normalized = normalizeUrl(parsed.url);
    const normalizedValue = normalized.toString();
    let attachment = this.repository.findDuplicate(parsed.projectId, parsed.sessionId, normalizedValue);
    if (!attachment) {
      attachment = this.repository.insertLink({
        id: randomUUID(),
        projectId: parsed.projectId,
        scope: parsed.scope,
        sessionId: parsed.sessionId,
        title: parsed.title ?? titleFromUrl(normalized),
        url: parsed.url,
        normalizedUrl: normalizedValue,
        host: normalized.hostname,
        defaultInclude: parsed.scope === "session",
        createdAt: new Date().toISOString(),
      });
      void this.refreshLinkPreviewById(attachment.id).catch(() => undefined);
    }
    this.#emit(parsed.projectId);
    return this.repository.list(parsed.projectId, parsed.sessionId);
  }

  update(input: UpdateContextAttachmentInput): ContextAttachmentList {
    const parsed = UpdateContextAttachmentInputSchema.parse(input);
    const existing = this.repository.getInternal(parsed.attachmentId);
    const sessionId = parsed.sessionId === undefined ? existing.sessionId : parsed.sessionId;
    const scope = parsed.scope ?? existing.scope;
    this.#assertTarget(existing.projectId, sessionId, scope);
    this.repository.update({
      attachmentId: existing.id,
      title: parsed.title,
      note: parsed.note,
      scope: parsed.scope,
      sessionId: parsed.sessionId,
      sortOrder: parsed.sortOrder,
      updatedAt: new Date().toISOString(),
    });
    this.#emit(existing.projectId);
    return this.repository.list(existing.projectId, sessionId);
  }

  setInclusion(input: SetContextInclusionInput): ContextAttachmentList {
    const parsed = SetContextInclusionInputSchema.parse(input);
    const session = this.sessions.getById(parsed.sessionId);
    const visible = this.repository.list(session.projectId, session.id);
    const all = [...visible.projectAttachments, ...visible.sessionAttachments];
    const requestedIds = parsed.attachmentIds.length === 0 && !parsed.included
      ? all.map((attachment) => attachment.id)
      : parsed.attachmentIds;
    const visibleIds = new Set(all.map((attachment) => attachment.id));
    if (requestedIds.some((id) => !visibleIds.has(id))) {
      throw new Error("Mindestens ein Anhang gehört nicht zu dieser Session.");
    }
    this.repository.setInclusion(session.id, requestedIds, parsed.included, new Date().toISOString());
    this.#emit(session.projectId);
    return this.repository.list(session.projectId, session.id);
  }

  async remove(input: RemoveContextAttachmentInput): Promise<ContextAttachmentList> {
    const parsed = RemoveContextAttachmentInputSchema.parse(input);
    const existing = this.repository.remove(parsed.attachmentId);
    await this.#removeStoredFiles(existing);
    this.#emit(existing.projectId);
    return this.repository.list(existing.projectId, existing.sessionId);
  }

  async refreshLinkPreview(attachmentId: string): Promise<ContextAttachmentList> {
    const existing = this.repository.getInternal(attachmentId);
    if (!existing.link) throw new Error("Dieser Anhang ist kein Link.");
    void this.refreshLinkPreviewById(attachmentId).catch(() => undefined);
    return this.repository.list(existing.projectId, existing.sessionId);
  }

  async refreshLinkPreviewById(attachmentId: string): Promise<void> {
    if (this.#previewJobs.has(attachmentId)) return;
    const existing = this.repository.getInternal(attachmentId);
    if (!existing.link) throw new Error("Dieser Anhang ist kein Link.");
    this.#previewJobs.add(attachmentId);
    this.repository.updateLinkPreview({ attachmentId, state: "pending" });
    this.#emit(existing.projectId);
    try {
      const metadata = await this.linkFetcher.fetch(existing.link.url);
      await this.blobs.removeLinkPreview(attachmentId);
      let imageFile: string | null = null;
      if (metadata.image) {
        imageFile = await this.blobs.writeLinkPreviewImage(
          attachmentId,
          metadata.image.bytes,
          metadata.image.extension,
        );
      }
      this.repository.updateLinkPreview({
        attachmentId,
        state: metadata.unauthorized ? "unauthorized" : "ready",
        title: metadata.title,
        description: metadata.description,
        siteName: metadata.siteName,
        imageFile,
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      await this.blobs.removeLinkPreview(attachmentId).catch(() => undefined);
      const message = error instanceof Error ? error.message : "Link-Vorschau fehlgeschlagen";
      this.repository.updateLinkPreview({
        attachmentId,
        state: message.includes("Sicherheitsgründen") ? "blocked" : "failed",
        error: message,
        fetchedAt: new Date().toISOString(),
      });
    } finally {
      this.#previewJobs.delete(attachmentId);
      this.#emit(existing.projectId);
    }
  }

  async getBytes(input: ContextAttachmentBytesInput): Promise<Uint8Array> {
    const parsed = ContextAttachmentBytesInputSchema.parse(input);
    const attachment = this.repository.getInternal(parsed.attachmentId);
    if (parsed.variant === "link_image") {
      const file = attachment.internalLink?.previewImageFile;
      if (!file) throw new Error("Für diesen Link gibt es kein Vorschaubild.");
      const safe = await this.blobs.assertReadableFile(file, this.blobs.linkPreviewsDirectory);
      return new Uint8Array(await readFile(safe));
    }
    if (!attachment.file) throw new Error("Dieser Anhang enthält keine Datei.");
    if (parsed.variant === "text_excerpt") {
      if (!attachment.file.sha256 || !["ready", "empty"].includes(attachment.file.extractionState)) {
        throw new Error("Für diesen Anhang ist noch kein Text verfügbar.");
      }
      const derived = await this.blobs.assertReadableFile(
        this.blobs.derivedTextPath(attachment.file.sha256),
        this.blobs.derivedDirectory,
      );
      return new TextEncoder().encode(await readFile(derived, "utf8"));
    }
    if (!attachment.file.renderable) {
      throw new Error("Originalbytes werden nur für geprüfte Bildformate bereitgestellt.");
    }
    const original = await this.blobs.assertReadableFile(
      this.blobs.blobPath(attachment.file.sha256),
      this.blobs.blobsDirectory,
    );
    return new Uint8Array(await readFile(original));
  }

  async getOriginalPath(attachmentId: string): Promise<string> {
    const attachment = this.repository.getInternal(attachmentId);
    if (!attachment.file) throw new Error("Dieser Anhang enthält keine Datei.");
    return this.blobs.assertReadableFile(
      this.blobs.blobPath(attachment.file.sha256),
      this.blobs.blobsDirectory,
    );
  }

  getLinkPreviewTarget(attachmentId: string): { url: string; host: string } {
    const attachment = this.repository.getInternal(attachmentId);
    if (!attachment.link) throw new Error("Dieser Anhang ist kein Link.");
    return { url: attachment.link.url, host: attachment.link.host };
  }

  async buildPromptContext(input: {
    projectId: string;
    sessionId: string;
    attachmentIds: readonly string[];
    imagesSupported: boolean;
  }): Promise<{ parts: PromptPart[]; snapshots: ContextAttachmentSnapshot[] }> {
    if (input.attachmentIds.length > MAX_CONTEXT_ATTACHMENTS_PER_PROMPT) {
      throw new Error(`Pro Prompt sind höchstens ${MAX_CONTEXT_ATTACHMENTS_PER_PROMPT} Kontextanhänge möglich.`);
    }
    const list = this.repository.list(input.projectId, input.sessionId);
    const visible = new Map(
      [...list.projectAttachments, ...list.sessionAttachments].map((attachment) => [attachment.id, attachment]),
    );
    const ids = [...new Set(input.attachmentIds)];
    if (ids.some((id) => !visible.has(id))) {
      throw new Error("Mindestens ein Kontextanhang gehört nicht zu diesem Projekt oder dieser Session.");
    }
    const sources: PromptContextSource[] = [];
    for (const id of ids) {
      const attachment = visible.get(id)!;
      let text: string | null = null;
      let imageData: string | null = null;
      if (attachment.file?.renderable) {
        const original = await this.blobs.assertReadableFile(
          this.blobs.blobPath(attachment.file.sha256),
          this.blobs.blobsDirectory,
        );
        imageData = (await readFile(original)).toString("base64");
      } else if (attachment.file && ["ready", "empty"].includes(attachment.file.extractionState)) {
        const derived = await this.blobs.assertReadableFile(
          this.blobs.derivedTextPath(attachment.file.sha256),
          this.blobs.derivedDirectory,
        );
        text = await readFile(derived, "utf8");
      }
      sources.push({ attachment, text, imageData });
    }
    return buildContextParts({ sources, imagesSupported: input.imagesSupported });
  }

  async removeSessionAttachments(sessionId: string): Promise<void> {
    for (const attachment of this.repository.listForSessionDeletion(sessionId)) {
      this.repository.remove(attachment.id);
      await this.#removeStoredFiles(attachment);
    }
  }

  async removeProjectAttachments(projectId: string): Promise<void> {
    for (const attachment of this.repository.listForProjectDeletion(projectId)) {
      this.repository.remove(attachment.id);
      await this.#removeStoredFiles(attachment);
    }
  }

  async #removeStoredFiles(attachment: StoredContextAttachment): Promise<void> {
    if (attachment.file && this.repository.countFileReferences(attachment.file.sha256) === 0) {
      await this.blobs.removeUnreferenced(attachment.file.sha256);
    }
    if (attachment.link) await this.blobs.removeLinkPreview(attachment.id);
  }

  #assertTarget(
    projectId: string,
    sessionId: string | null,
    scope?: "project" | "session",
  ): void {
    this.projects.get(projectId);
    if (sessionId !== null) {
      const session = this.sessions.getById(sessionId);
      if (session.projectId !== projectId) throw new Error("Die Session gehört nicht zu diesem Projekt.");
    }
    if (scope && ((scope === "project") !== (sessionId === null))) {
      throw new Error("Die Anhangsebene passt nicht zur Session-ID.");
    }
  }

  #emit(projectId: string): void {
    for (const listener of this.#listeners) listener(projectId);
  }
}

function safeDisplayName(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return cleaned || "Anhang";
}

function titleFromUrl(url: URL): string {
  const encoded = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  let tail = encoded;
  try {
    tail = decodeURIComponent(encoded);
  } catch {
    // A valid URL may still contain an incomplete escape in its path.
  }
  tail = tail.trim();
  return safeDisplayName(tail || url.hostname);
}
