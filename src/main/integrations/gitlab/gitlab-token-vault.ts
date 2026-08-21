import { safeStorage } from "electron";

export interface ISecretStorageAdapter {
  isAvailable(): boolean;
  encrypt(plaintext: string): Promise<Buffer>;
  decrypt(cipher: Buffer): Promise<string>;
}

class ElectronSafeStorageAdapter implements ISecretStorageAdapter {
  isAvailable(): boolean {
    return typeof safeStorage?.isEncryptionAvailable === "function" && safeStorage.isEncryptionAvailable();
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

export class GitLabTokenVault {
  readonly #adapter: ISecretStorageAdapter;

  constructor(adapter?: ISecretStorageAdapter) {
    this.#adapter = adapter ?? new ElectronSafeStorageAdapter();
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
