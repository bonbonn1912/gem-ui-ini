import { z } from "zod";
import { EntityIdSchema } from "./common";

export const ElicitationValueSchema = z.union([
  z.string().max(16_384), z.number().finite(), z.boolean(),
  z.array(z.string().max(2_000)).max(100),
]);
const ChoiceSchema = z.object({ const: z.string().max(2_000), title: z.string().max(500) });
export const ElicitationFieldSchema = z.object({
  type: z.enum(["string", "number", "integer", "boolean", "array"]),
  title: z.string().max(500).nullish(), description: z.string().max(2_000).nullish(),
  minLength: z.number().int().nonnegative().nullish(), maxLength: z.number().int().nonnegative().nullish(),
  pattern: z.string().max(256).nullish(),
  format: z.enum(["email", "uri", "date", "date-time"]).nullish(),
  minimum: z.number().finite().nullish(), maximum: z.number().finite().nullish(),
  minItems: z.number().int().nonnegative().nullish(), maxItems: z.number().int().nonnegative().nullish(),
  default: ElicitationValueSchema.nullish(),
  enum: z.array(z.string().max(2_000)).max(100).nullish(),
  oneOf: z.array(ChoiceSchema).max(100).nullish(),
  items: z.object({ type: z.literal("string").optional(), enum: z.array(z.string().max(2_000)).max(100).optional(), anyOf: z.array(ChoiceSchema).max(100).optional() }).nullish(),
});
export const ElicitationFormSchema = z.object({
  type: z.literal("object").optional(), title: z.string().max(500).nullish(),
  description: z.string().max(2_000).nullish(),
  properties: z.record(z.string().min(1).max(200), ElicitationFieldSchema).refine((value) => Object.keys(value).length <= 50).default({}),
  required: z.array(z.string().max(200)).max(50).nullish(),
});
export const ElicitationRequestSchema = z.object({
  requestId: EntityIdSchema, sessionId: EntityIdSchema,
  message: z.string().max(8_000), mode: z.enum(["form", "url"]),
  schema: ElicitationFormSchema.optional(), url: z.url().max(2_048).optional(),
}).strict();
export const RespondToElicitationInputSchema = z.object({
  sessionId: EntityIdSchema, requestId: EntityIdSchema,
  action: z.enum(["accept", "decline", "cancel"]),
  content: z.record(z.string().max(200), ElicitationValueSchema).optional(),
}).strict();
export type ElicitationRequest = z.infer<typeof ElicitationRequestSchema>;
export type ElicitationField = z.infer<typeof ElicitationFieldSchema>;
export type RespondToElicitationInput = z.infer<typeof RespondToElicitationInputSchema>;

export function validateElicitationContent(request: ElicitationRequest, content: RespondToElicitationInput["content"]): void {
  if (request.mode !== "form") return;
  const properties = request.schema?.properties ?? {};
  for (const key of Object.keys(content ?? {})) {
    if (!Object.hasOwn(properties, key)) throw new Error(`Unbekanntes Feld: ${key}`);
  }
  for (const [key, field] of Object.entries(properties)) {
    const value = content?.[key];
    if (value === undefined) {
      if (request.schema?.required?.includes(key)) throw new Error(`Bitte ${field.title ?? key} ausfüllen.`);
      continue;
    }
    const invalid = () => { throw new Error(`Ungültiger Wert für ${field.title ?? key}.`); };
    if (field.type === "boolean") { if (typeof value !== "boolean") invalid(); }
    else if (field.type === "number" || field.type === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value) ||
          (field.type === "integer" && !Number.isInteger(value)) ||
          (field.minimum != null && value < field.minimum) || (field.maximum != null && value > field.maximum)) invalid();
    } else if (field.type === "array") {
      const allowed = field.items?.enum ?? field.items?.anyOf?.map((option) => option.const) ?? [];
      if (!Array.isArray(value) || value.some((entry) => !allowed.includes(entry)) ||
          new Set(value).size !== value.length || (field.minItems != null && value.length < field.minItems) ||
          (field.maxItems != null && value.length > field.maxItems)) invalid();
    } else {
      if (typeof value !== "string") { invalid(); continue; }
      if ((field.minLength != null && value.length < field.minLength) ||
          (field.maxLength != null && value.length > field.maxLength)) invalid();
      const allowed = field.enum ?? field.oneOf?.map((option) => option.const);
      if (allowed && !allowed.includes(value)) invalid();
      if (field.pattern && !new RegExp(field.pattern, "u").test(value)) invalid();
      if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) invalid();
      if (field.format === "uri") { try { new URL(value); } catch { invalid(); } }
      if (field.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))) invalid();
      if (field.format === "date-time" && Number.isNaN(Date.parse(value))) invalid();
    }
  }
}
