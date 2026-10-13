import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../../errors.js";
import type {
  Account,
  CredentialEnvelope,
  ProviderId,
  UsageQuota,
  UsageSnapshot,
} from "../../models.js";
import type { ClockPort, StoragePort, UsageProviderAdapter } from "../../ports.js";
import { CredentialVault } from "../../credential-vault.js";
import {
  getOpencodeUsage,
  type OpencodeUsageWindow,
} from "@omniroute/open-sse/services/usage/opencode.ts";

export interface OpencodeGoProvisioningResult {
  authMethod: "api-key";
  offeringId: string;
  stableIdentity: string;
  displayName: string;
  maskedIdentifier: string;
  publicMetadata: { product: "opencode-go" };
  credentials: Omit<CredentialEnvelope, "accountId">;
}

function normalizeApiKey(value: string): string {
  return value
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return `${apiKey.slice(0, 2)}***`;
  return `${apiKey.slice(0, 4)}***${apiKey.slice(-4)}`;
}

function quota(
  key: string,
  displayName: string,
  total: number,
  windowSeconds: number,
  window: OpencodeUsageWindow,
): UsageQuota {
  const used = (window.percentUsed / 100) * total;
  return {
    key,
    displayName,
    windowSeconds,
    used,
    total,
    remaining: total - used,
    remainingPercentage: 100 - window.percentUsed,
    resetAt: window.resetAt,
    unlimited: false,
  };
}

export class OpencodeGoAdapter implements UsageProviderAdapter {
  readonly provider: ProviderId = "opencode-go";

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: ClockPort = { now: () => new Date() },
  ) {}

  async createProvisioning(apiKeyInput: string): Promise<OpencodeGoProvisioningResult> {
    const apiKey = normalizeApiKey(apiKeyInput);
    if (!apiKey) throw new AppError("validation", "请输入 OpenCode Go API Key");
    if (apiKey.length > 4096) throw new AppError("validation", "API Key 长度不正确");
    await this.requestUsage(apiKey);
    const fingerprint = createHash("sha256").update(apiKey).digest("hex").slice(0, 32);
    return {
      authMethod: "api-key",
      offeringId: "opencode-go",
      stableIdentity: `opencode-go:${fingerprint}`,
      displayName: "OpenCode Go",
      maskedIdentifier: maskApiKey(apiKey),
      publicMetadata: { product: "opencode-go" },
      credentials: {
        version: 1,
        provider: "opencode-go",
        authMethod: "api-key",
        expiresAt: null,
        secrets: { apiKey },
      },
    };
  }

  async fetchUsage(account: Account, envelope: CredentialEnvelope): Promise<UsageSnapshot> {
    const apiKey = envelope.secrets.apiKey;
    if (!apiKey) throw new AppError("authentication", "OpenCode Go API Key 不可用");
    const result = await this.requestUsage(apiKey);
    const quotas = [
      quota("session", "$12 / 5-hour", 12, 18_000, result.session),
      quota("weekly", "$30 / week", 30, 604_800, result.weekly),
      quota("monthly", "$60 / month", 60, 2_592_000, result.monthly),
    ];
    return {
      accountId: account.id,
      plan: result.plan,
      overallRemainingPercentage: Math.min(
        ...quotas.map((item) => item.remainingPercentage ?? 100),
      ),
      groups: [{ key: "default", displayName: null, quotas }],
      extras: [],
      resetCredits: null,
      fetchedAt: this.clock.now().toISOString(),
    };
  }

  private async requestUsage(apiKey: string) {
    const result = await getOpencodeUsage(apiKey, this.fetchImpl);
    if (!("message" in result)) return result;
    const authentication = result.status === 401 || result.status === 403;
    throw new AppError(
      authentication ? "authentication" : result.status === null ? "network" : "upstream",
      authentication ? "OpenCode Go API Key 无效" : `OpenCode Go 用量请求失败：${result.message}`,
      !authentication,
    );
  }
}

export class OpencodeGoAccountProvisioner {
  constructor(
    private readonly storage: StoragePort,
    private readonly vault: CredentialVault,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async save(input: OpencodeGoProvisioningResult): Promise<Account> {
    const timestamp = this.now().toISOString();
    const existing = this.storage.accounts.findByStableIdentity(
      "opencode-go",
      input.stableIdentity,
    );
    const account: Account = {
      id: existing?.id ?? this.createId(),
      provider: "opencode-go",
      offeringId: input.offeringId,
      authMethod: input.authMethod,
      stableIdentity: input.stableIdentity,
      displayName: input.displayName,
      maskedIdentifier: input.maskedIdentifier,
      enabled: existing?.enabled ?? true,
      credentialState: "available",
      publicMetadata: input.publicMetadata,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    const encrypted = await this.vault.seal(account, {
      ...input.credentials,
      accountId: account.id,
    });
    this.storage.transaction(() => {
      this.storage.accounts.save(account);
      this.storage.credentials.save(encrypted);
    });
    return account;
  }
}
