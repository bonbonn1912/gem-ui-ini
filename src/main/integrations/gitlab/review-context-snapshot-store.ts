import { randomUUID } from "node:crypto";
import type {
  ExternalPromptContextSnapshot,
  PreparedExternalContext,
} from "../../../shared/contracts";
import type { PromptPart } from "../../gemini/types";

type StoredContext = {
  refId: string;
  prepared: PreparedExternalContext;
  parts: PromptPart[];
  expiresAt: number;
};

export class ReviewContextSnapshotStore {
  readonly #store = new Map<string, StoredContext>();
  readonly #ttlMs: number;

  constructor(ttlMs = 10 * 60 * 1000) {
    this.#ttlMs = ttlMs;
  }

  saveSnapshot(
    prepared: PreparedExternalContext,
    parts: PromptPart[],
  ): string {
    this.#cleanupExpired();
    const refId = prepared.ref.id || randomUUID();
    const now = Date.now();

    this.#store.set(refId, {
      refId,
      prepared: {
        ...prepared,
        ref: { kind: "gitlab_review", id: refId },
        expiresAt: new Date(now + this.#ttlMs).toISOString(),
      },
      parts,
      expiresAt: now + this.#ttlMs,
    });

    return refId;
  }

  consumeSnapshot(
    refId: string,
  ): { parts: PromptPart[]; snapshot: ExternalPromptContextSnapshot } | null {
    this.#cleanupExpired();
    const item = this.#store.get(refId);
    if (!item) return null;

    // One-time consumption
    this.#store.delete(refId);

    const snapshot: ExternalPromptContextSnapshot = {
      kind: "gitlab_review",
      id: item.refId,
      title: item.prepared.title,
      repositoryLabel: item.prepared.repositoryLabel,
      mergeRequestReference: item.prepared.mergeRequestReference,
      filePath: item.prepared.filePath,
      startLine: item.prepared.startLine,
      endLine: item.prepared.endLine,
      contextMode: item.prepared.contextMode,
    };

    return {
      parts: item.parts,
      snapshot,
    };
  }

  #cleanupExpired(): void {
    const now = Date.now();
    for (const [id, item] of this.#store.entries()) {
      if (item.expiresAt <= now) {
        this.#store.delete(id);
      }
    }
  }
}
