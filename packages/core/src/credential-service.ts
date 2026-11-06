import type { Account, CredentialEnvelope } from "./models.js";

/** Semantic credentials API; callers never manage ciphertext or a selected storage backend. */
export interface CredentialService {
  load(accountId: string): Promise<CredentialEnvelope>;
  save(account: Account, envelope: CredentialEnvelope): Promise<void>;
  saveAccount(account: Account, envelope: CredentialEnvelope): Promise<void>;
}
