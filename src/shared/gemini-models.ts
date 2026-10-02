/** Explicit choices supported by Gemini's legacy session/set_model transport.
 * Config-option transports must instead use the agent's advertised values. */
export const GEMINI_COMPATIBILITY_MODELS = [
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
] as const;

export function isGeminiCompatibilityModel(id: string): boolean {
  return GEMINI_COMPATIBILITY_MODELS.some((model) => model.id === id);
}

export function geminiModelLabel(id: string): string {
  return GEMINI_COMPATIBILITY_MODELS.find((model) => model.id === id)?.name ?? id;
}
