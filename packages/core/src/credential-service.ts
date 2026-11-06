import type { Account, CredentialEnvelope } from "./models.js";
import type { CredentialRefreshResult } from "./ports.js";
import { AppError } from "./errors.js";

export type CredentialRefresh = (
  current: CredentialEnvelope,
  account: Account,
) => Promise<CredentialRefreshResult>;

/** Semantic credentials API; callers never manage ciphertext or a selected storage backend. */
export interface CredentialService {
  load(accountId: string): Promise<CredentialEnvelope>;
  save(account: Account, envelope: CredentialEnvelope): Promise<void>;
  saveAccount(account: Account, envelope: CredentialEnvelope): Promise<void>;
  /** Shared backends acquire a record lease before reading and invoking the provider. */
  refresh?(account: Account, operation: CredentialRefresh): Promise<CredentialRefreshResult>;
}

/** Keeps provider dependencies stable while the host changes the active backend. */
export class SwitchingCredentialService implements CredentialService {
  private shared?: CredentialService;
  constructor(private readonly privateService: CredentialService) {}
  get isShared(): boolean {
    return this.shared !== undefined;
  }
  useShared(service: CredentialService): void {
    this.shared = service;
  }
  usePrivate(): void {
    this.shared = undefined;
  }
  /** Preserve an explicit shared selection even while its broker cannot be reached. */
  useUnavailable(): void {
    const unavailable = async (): Promise<never> => {
      throw new AppError(
        "service-unavailable",
        "共享凭据暂不可用，请重试连接或明确返回内置存储",
        true,
      );
    };
    this.shared = {
      load: unavailable,
      save: unavailable,
      saveAccount: unavailable,
      refresh: unavailable,
    };
  }
  private get active(): CredentialService {
    return this.shared ?? this.privateService;
  }
  load(accountId: string): Promise<CredentialEnvelope> {
    return this.active.load(accountId);
  }
  save(account: Account, envelope: CredentialEnvelope): Promise<void> {
    return this.active.save(account, envelope);
  }
  saveAccount(account: Account, envelope: CredentialEnvelope): Promise<void> {
    return this.active.saveAccount(account, envelope);
  }
  async refresh(account: Account, operation: CredentialRefresh): Promise<CredentialRefreshResult> {
    const active = this.active;
    if (active.refresh) return active.refresh(account, operation);
    const result = await operation(await active.load(account.id), account);
    if (result.changed) {
      await active.saveAccount(
        { ...account, credentialState: "available", updatedAt: new Date().toISOString() },
        result.envelope,
      );
    }
    return result;
  }
}
