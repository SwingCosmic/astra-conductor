import type {
  Account,
  CredentialEnvelope,
  EncryptedCredential,
  NotificationState,
  ProviderId,
  ResetCreditRedemption,
  SettingValue,
  UsageSnapshot,
} from "./models.js";

export interface AccountRepository {
  list(): Account[];
  get(id: string): Account | null;
  findByStableIdentity(provider: Account["provider"], stableIdentity: string): Account | null;
  save(account: Account): void;
  setEnabled(id: string, enabled: boolean, updatedAt: string): void;
  setCredentialState(id: string, state: Account["credentialState"], updatedAt: string): void;
  delete(id: string): void;
}

export interface CredentialRepository {
  get(accountId: string): EncryptedCredential | null;
  save(credential: EncryptedCredential): void;
}

export interface UsageSnapshotRepository {
  get(accountId: string): UsageSnapshot | null;
  save(snapshot: UsageSnapshot): void;
}

export interface NotificationStateRepository {
  list(accountId: string): NotificationState[];
  save(state: NotificationState): void;
}

export interface SettingsRepository {
  get(key: string): SettingValue | null;
  save(key: string, value: SettingValue, updatedAt: string): void;
}

export interface StoragePort {
  readonly accounts: AccountRepository;
  readonly credentials: CredentialRepository;
  readonly snapshots: UsageSnapshotRepository;
  readonly notifications: NotificationStateRepository;
  readonly settings: SettingsRepository;
  transaction<T>(operation: () => T): T;
  close(): void;
}

export interface CredentialRefreshResult {
  envelope: CredentialEnvelope;
  changed: boolean;
}

/**
 * 用量侧适配器形状（usage facet 的内部形态）。凭据刷新属于账号能力
 * facet：没有主动刷新协议的 API Key 实现不再提供无效果刷新方法。
 */
export interface UsageProviderAdapter {
  readonly provider: ProviderId;
  fetchUsage(account: Account, envelope: CredentialEnvelope): Promise<UsageSnapshot>;
  redeemResetCard?(
    account: Account,
    envelope: CredentialEnvelope,
    request: ResetCreditRedemption,
  ): Promise<void>;
}

export interface DecryptionResult {
  plaintext: string;
  shouldReEncrypt: boolean;
}

export interface CredentialCipherPort {
  isAvailable(): Promise<boolean>;
  encrypt(plaintext: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array): Promise<DecryptionResult>;
}

export interface ClockPort {
  now(): Date;
}

export interface HttpPort {
  fetch: typeof fetch;
}

export interface ProxyPort {
  resolveProxy(url: string): Promise<string>;
}

export interface BrowserAuthPort {
  openExternal(url: string): Promise<void>;
  waitForCallback(input: {
    port: number;
    path: string;
    expectedState: string;
    signal?: AbortSignal;
  }): Promise<{ code: string }>;
}

export interface CliAuthFilePort {
  readCodexAuth(): Promise<unknown>;
}

export type LogContext = Partial<{
  provider: string;
  account: string;
  stage: string;
  durationMs: number;
  status: number;
  code: string;
  offering: string;
  method: string;
  sessionId: string;
}>;

export interface LoggerPort {
  info(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}
