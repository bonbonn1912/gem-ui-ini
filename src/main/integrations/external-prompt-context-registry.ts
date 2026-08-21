import type {
  ExternalPromptContextRef,
  ExternalPromptContextSnapshot,
} from "../../shared/contracts";
import type { PromptPart } from "../gemini/types";

export type ExternalPromptContextProvider = {
  resolveContext(refId: string): Promise<{
    parts: PromptPart[];
    snapshot: ExternalPromptContextSnapshot;
  }>;
};

export class ExternalPromptContextRegistry {
  readonly #providers = new Map<string, ExternalPromptContextProvider>();

  registerProvider(kind: string, provider: ExternalPromptContextProvider): void {
    this.#providers.set(kind, provider);
  }

  async resolve(refs: ExternalPromptContextRef[]): Promise<{
    parts: PromptPart[];
    snapshots: ExternalPromptContextSnapshot[];
  }> {
    const allParts: PromptPart[] = [];
    const snapshots: ExternalPromptContextSnapshot[] = [];

    for (const ref of refs) {
      const provider = this.#providers.get(ref.kind);
      if (!provider) {
        throw new Error(`Kein Provider für externen Promptkontext „${ref.kind}“ registriert.`);
      }
      const resolved = await provider.resolveContext(ref.id);
      allParts.push(...resolved.parts);
      snapshots.push(resolved.snapshot);
    }

    return { parts: allParts, snapshots };
  }
}
