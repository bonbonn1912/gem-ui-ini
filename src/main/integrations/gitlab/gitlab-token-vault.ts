import { safeStorage, app } from "electron";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ISecretStorageAdapter {
  isAvailable(): boolean;
  encrypt(plaintext: string): Promise<Buffer>;
  decrypt(cipher: Buffer): Promise<string>;
}

const MAGIC_SAFE_STORAGE = 0x01;
const MAGIC_AES_GCM = 0x02;

export class ElectronSafeStorageAdapter implements ISecretStorageAdapter {
  isAvailable(): boolean {
    try {
      return (
        typeof safeStorage?.isEncryptionAvailable === "function" &&
        safeStorage.isEncryptionAvailable()
      );
    } catch {
      return false;
    }
  }

  async encrypt(plaintext: string): Promise<Buffer> {
    if (!this.isAvailable()) {
      throw new Error(
        "Sichere Verschlüsselung (safeStorage) ist auf diesem System derzeit nicht verfügbar.",
      );
    }
    return safeStorage.encryptString(plaintext);
  }

  async decrypt(cipher: Buffer): Promise<string> {
    if (!this.isAvailable()) {
      throw new Error(
        "Sichere Entschlüsselung (safeStorage) ist auf diesem System derzeit nicht verfügbar.",
      );
    }
    return safeStorage.decryptString(cipher);
  }
}

let cachedFallbackKey: Buffer | null = null;

function getOrCreateVaultKey(customKeyPath?: string): Buffer {
  if (cachedFallbackKey) return cachedFallbackKey;

  let keyPath = customKeyPath;
  if (!keyPath) {
    try {
      if (typeof app?.getPath === "function") {
        const userData = app.getPath("userData");
        keyPath = path.join(userData, "keys", "vault.key");
      }
    } catch {
      // app not ready or running outside Electron process
    }
  }

  if (!keyPath) {
    const home = process.env.HOME || process.env.USERPROFILE || ".";
    keyPath = path.join(home, ".geminui", "keys", "vault.key");
  }

  try {
    if (fs.existsSync(keyPath)) {
      const existing = fs.readFileSync(keyPath);
      if (existing.length === 32) {
        cachedFallbackKey = existing;
        return existing;
      }
    }
    const dir = path.dirname(keyPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const newKey = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, newKey, { mode: 0o600 });
    cachedFallbackKey = newKey;
    return newKey;
  } catch {
    // If file system is restricted, create an ephemeral in-memory key
    const ephemeralKey = crypto.randomBytes(32);
    cachedFallbackKey = ephemeralKey;
    return ephemeralKey;
  }
}

export class AesGcmSecretStorageAdapter implements ISecretStorageAdapter {
  readonly #key: Buffer;

  constructor(key?: Buffer) {
    this.#key = key ?? getOrCreateVaultKey();
  }

  isAvailable(): boolean {
    return true;
  }

  async encrypt(plaintext: string): Promise<Buffer> {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.#key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // Format: [12 bytes IV][16 bytes AuthTag][Ciphertext]
    return Buffer.concat([iv, tag, encrypted]);
  }

  async decrypt(cipher: Buffer): Promise<string> {
    if (cipher.length < 28) {
      throw new Error("Ungültiges Chiffrat: Mindestlänge für AES-GCM nicht erreicht.");
    }
    const iv = cipher.subarray(0, 12);
    const tag = cipher.subarray(12, 28);
    const data = cipher.subarray(28);

    const decipher = crypto.createDecipheriv("aes-256-gcm", this.#key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(data),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  }
}

export class HybridSecretStorageAdapter implements ISecretStorageAdapter {
  readonly #safeStorage: ElectronSafeStorageAdapter;
  readonly #aesGcm: AesGcmSecretStorageAdapter;

  constructor(
    safeStorageAdapter?: ElectronSafeStorageAdapter,
    aesGcmAdapter?: AesGcmSecretStorageAdapter,
  ) {
    this.#safeStorage = safeStorageAdapter ?? new ElectronSafeStorageAdapter();
    this.#aesGcm = aesGcmAdapter ?? new AesGcmSecretStorageAdapter();
  }

  isAvailable(): boolean {
    return true;
  }

  async encrypt(plaintext: string): Promise<Buffer> {
    if (this.#safeStorage.isAvailable()) {
      try {
        const encrypted = await this.#safeStorage.encrypt(plaintext);
        return Buffer.concat([Buffer.from([MAGIC_SAFE_STORAGE]), encrypted]);
      } catch (err) {
        console.warn(
          "[GitLabTokenVault] safeStorage.encrypt fehlgeschlagen, verwende AES-GCM Fallback:",
          err,
        );
      }
    }

    const encrypted = await this.#aesGcm.encrypt(plaintext);
    return Buffer.concat([Buffer.from([MAGIC_AES_GCM]), encrypted]);
  }

  async decrypt(cipher: Buffer): Promise<string> {
    if (!cipher || cipher.length === 0) {
      throw new Error("Ungültiger leerer Token-Ciphertext.");
    }

    const magic = cipher[0];
    if (magic === MAGIC_SAFE_STORAGE) {
      return this.#safeStorage.decrypt(cipher.subarray(1));
    }
    if (magic === MAGIC_AES_GCM) {
      return this.#aesGcm.decrypt(cipher.subarray(1));
    }

    // Legacy format without magic byte header
    if (this.#safeStorage.isAvailable()) {
      try {
        return await this.#safeStorage.decrypt(cipher);
      } catch {
        // Fall through to try AES-GCM
      }
    }
    return this.#aesGcm.decrypt(cipher);
  }
}

export class GitLabTokenVault {
  readonly #adapter: ISecretStorageAdapter;

  constructor(adapter?: ISecretStorageAdapter) {
    this.#adapter = adapter ?? new HybridSecretStorageAdapter();
  }

  isEncryptionAvailable(): boolean {
    return this.#adapter.isAvailable();
  }

  async encryptToken(token: string): Promise<Buffer> {
    const trimmed = token.trim();
    if (!trimmed) {
      throw new Error("Ein leerer Token kann nicht gespeichert werden.");
    }
    return this.#adapter.encrypt(trimmed);
  }

  async withDecryptedToken<T>(
    cipher: Buffer,
    fn: (token: string) => Promise<T>,
  ): Promise<T> {
    if (!cipher || cipher.length === 0) {
      throw new Error("Ungültiger Token-Ciphertext.");
    }
    const token = await this.#adapter.decrypt(cipher);
    try {
      return await fn(token);
    } finally {
      // Ephemeral token usage
    }
  }
}
