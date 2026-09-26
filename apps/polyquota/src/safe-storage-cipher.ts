import { app, safeStorage } from "electron";
import {
  AppError,
  type CredentialCipherPort,
  type DecryptionResult,
} from "@astra-conductor/core/internal";

export class ElectronSafeStorageCipher implements CredentialCipherPort {
  async isAvailable(): Promise<boolean> {
    if (!app.isReady()) return false;
    try {
      return await safeStorage.isAsyncEncryptionAvailable();
    } catch {
      return false;
    }
  }

  async encrypt(plaintext: string): Promise<Uint8Array> {
    if (!(await this.isAvailable())) {
      throw new AppError("secure-storage", "System credential protection is unavailable");
    }
    return safeStorage.encryptStringAsync(plaintext);
  }

  async decrypt(ciphertext: Uint8Array): Promise<DecryptionResult> {
    if (!(await this.isAvailable())) {
      throw new AppError("secure-storage", "System credential protection is unavailable");
    }
    const result = await safeStorage.decryptStringAsync(Buffer.from(ciphertext));
    return { plaintext: result.result, shouldReEncrypt: result.shouldReEncrypt };
  }
}
