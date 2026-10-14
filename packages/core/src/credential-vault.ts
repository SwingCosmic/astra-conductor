import { AppError } from "./errors.js";
import {
  credentialSecretKeys,
  type Account,
  type CredentialEnvelope,
  type EncryptedCredential,
} from "./models.js";
import type { CredentialCipherPort, StoragePort } from "./ports.js";

const secretKeys = new Set<string>(credentialSecretKeys);

function validateEnvelope(account: Account, envelope: CredentialEnvelope): void {
  if (
    envelope.version !== 1 ||
    envelope.accountId !== account.id ||
    envelope.provider !== account.provider ||
    envelope.authMethod !== account.authMethod
  ) {
    throw new AppError("secure-storage", "Credential ownership mismatch");
  }
  const keys = Object.keys(envelope.secrets);
  const invalid = keys.filter((key) => !secretKeys.has(key));
  if (keys.length === 0 || invalid.length) {
    const detail = invalid.length ? `: ${invalid.join(", ")}` : "";
    throw new AppError("validation", `Credential envelope contains invalid fields${detail}`);
  }
  for (const value of Object.values(envelope.secrets)) {
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      throw new AppError("validation", "Credential values must be non-empty strings");
    }
  }
}

function parseEnvelope(plaintext: string): CredentialEnvelope {
  try {
    const parsed = JSON.parse(plaintext) as CredentialEnvelope;
    if (!parsed || typeof parsed !== "object" || !parsed.secrets) {
      throw new Error("invalid envelope");
    }
    return parsed;
  } catch (error) {
    throw new AppError("secure-storage", "Credential data is damaged", false, { cause: error });
  }
}

export class CredentialVault {
  constructor(
    private readonly storage: StoragePort,
    private readonly cipher: CredentialCipherPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async seal(account: Account, envelope: CredentialEnvelope): Promise<EncryptedCredential> {
    validateEnvelope(account, envelope);
    if (!(await this.cipher.isAvailable())) {
      throw new AppError("secure-storage", "System credential protection is unavailable");
    }
    try {
      return {
        accountId: account.id,
        encryptionVersion: 1,
        ciphertext: await this.cipher.encrypt(JSON.stringify(envelope)),
        updatedAt: this.now().toISOString(),
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("secure-storage", "Credential encryption failed", false, {
        cause: error,
      });
    }
  }

  async save(account: Account, envelope: CredentialEnvelope): Promise<void> {
    const encrypted = await this.seal(account, envelope);
    this.storage.credentials.save(encrypted);
  }

  async load(accountId: string): Promise<CredentialEnvelope> {
    const account = this.storage.accounts.get(accountId);
    const encrypted = this.storage.credentials.get(accountId);
    if (!account || !encrypted) {
      throw new AppError("secure-storage", "Credential record is missing");
    }
    if (!(await this.cipher.isAvailable())) {
      throw new AppError("secure-storage", "System credential protection is unavailable");
    }
    try {
      const decrypted = await this.cipher.decrypt(encrypted.ciphertext);
      const envelope = parseEnvelope(decrypted.plaintext);
      validateEnvelope(account, envelope);
      if (decrypted.shouldReEncrypt) {
        const replacement = await this.seal(account, envelope);
        this.storage.credentials.save(replacement);
      }
      return envelope;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("secure-storage", "Credential decryption failed", false, {
        cause: error,
      });
    }
  }
}
