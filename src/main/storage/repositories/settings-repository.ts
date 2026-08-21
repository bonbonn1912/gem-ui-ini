import {
  GEMINI_SETTINGS_KEY,
  GeminiSettingsSchema,
  GIT_SETTINGS_KEY,
  GitSettingsSchema,
  IsoTimestampSchema,
  JsonValueSchema,
  type GeminiSettings,
  type GitSettings,
  type JsonValue,
} from "../../../shared";
import type { SqliteDatabase } from "../database";
import { StorageCorruptionError } from "../errors";

export type StoredSetting = {
  key: string;
  value: JsonValue;
  version: number;
  updatedAt: string;
};

export class SettingsRepository {
  constructor(private readonly database: SqliteDatabase) {}

  get(key: string): StoredSetting | null {
    validateKey(key);
    const row = this.database
      .prepare(
        "SELECT key, value_json, version, updated_at FROM settings WHERE key = ?",
      )
      .get(key) as
      | { key: string; value_json: string; version: number; updated_at: string }
      | undefined;
    if (!row) return null;

    try {
      return {
        key: row.key,
        value: JsonValueSchema.parse(JSON.parse(row.value_json)),
        version: row.version,
        updatedAt: IsoTimestampSchema.parse(row.updated_at),
      };
    } catch (error) {
      throw new StorageCorruptionError("setting", { cause: error });
    }
  }

  set(
    key: string,
    value: JsonValue,
    options?: { version?: number; updatedAt?: string },
  ): StoredSetting {
    validateKey(key);
    const parsedValue = JsonValueSchema.parse(value);
    const version = options?.version ?? 1;
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new RangeError("Setting version must be a positive safe integer");
    }
    const updatedAt = IsoTimestampSchema.parse(
      options?.updatedAt ?? new Date().toISOString(),
    );

    this.database
      .prepare(
        `INSERT INTO settings (key, value_json, version, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           version = excluded.version,
           updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(parsedValue), version, updatedAt);

    const stored = this.get(key);
    if (!stored) throw new Error(`Setting ${key} disappeared after upsert`);
    return stored;
  }

  delete(key: string): void {
    validateKey(key);
    this.database.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  getGeminiSettings(): GeminiSettings | null {
    const setting = this.get(GEMINI_SETTINGS_KEY);
    return setting
      ? GeminiSettingsSchema.parse({
          binaryPath: setting.value,
          updatedAt: setting.updatedAt,
        })
      : null;
  }

  setGeminiBinaryPath(
    binaryPath: string | null,
    updatedAt = new Date().toISOString(),
  ): GeminiSettings {
    const settings = GeminiSettingsSchema.parse({ binaryPath, updatedAt });
    this.set(GEMINI_SETTINGS_KEY, settings.binaryPath, { updatedAt });
    return settings;
  }

  getGitSettings(): GitSettings | null {
    const setting = this.get(GIT_SETTINGS_KEY);
    return setting
      ? GitSettingsSchema.parse({
          binaryPath: setting.value,
          updatedAt: setting.updatedAt,
        })
      : null;
  }

  setGitBinaryPath(
    binaryPath: string | null,
    updatedAt = new Date().toISOString(),
  ): GitSettings {
    const settings = GitSettingsSchema.parse({ binaryPath, updatedAt });
    this.set(GIT_SETTINGS_KEY, settings.binaryPath, { updatedAt });
    return settings;
  }
}

function validateKey(key: string): void {
  if (key.length < 1 || key.length > 200) {
    throw new RangeError("Setting keys must contain between 1 and 200 characters");
  }
}
