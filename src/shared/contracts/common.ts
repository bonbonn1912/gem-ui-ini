import { z } from "zod";

export const EntityIdSchema = z.uuid();
export const ClientRequestIdSchema = z.uuid();
export const IsoTimestampSchema = z.iso.datetime({ offset: true });
export const RootRevisionSchema = z.int().min(1);
export const RootFingerprintSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 fingerprint");

export const DisplayNameSchema = z.string().trim().min(1).max(200);
export const FileSystemPathSchema = z.string().min(1).max(32_768);
export const Sha256Schema = RootFingerprintSchema;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const AppErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(2_000),
    retryable: z.boolean().default(false),
    details: JsonValueSchema.optional(),
  })
  .strict();

export type AppError = z.infer<typeof AppErrorSchema>;

export const VoidResultSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export type VoidResult = z.infer<typeof VoidResultSchema>;
