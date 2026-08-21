import { z } from "zod";

import { FileSystemPathSchema, IsoTimestampSchema } from "./common";

export const GEMINI_SETTINGS_KEY = "gemini.binaryPath";
export const GIT_SETTINGS_KEY = "git.binaryPath";

export const GeminiSettingsSchema = z
  .object({
    binaryPath: FileSystemPathSchema.nullable(),
    updatedAt: IsoTimestampSchema,
  })
  .strict();

export type GeminiSettings = z.infer<typeof GeminiSettingsSchema>;

export const GitSettingsSchema = z
  .object({
    binaryPath: FileSystemPathSchema.nullable(),
    updatedAt: IsoTimestampSchema,
  })
  .strict();

export type GitSettings = z.infer<typeof GitSettingsSchema>;
