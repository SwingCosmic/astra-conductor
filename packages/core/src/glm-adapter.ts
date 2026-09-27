import { createHash, randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import type {
  Account,
  CredentialEnvelope,
  GlmRegion,
  ProviderId,
  PublicMetadata,
  UsageQuota,
  UsageSnapshot,
} from "./models.js";
import type {
  ClockPort,
  CredentialRefreshResult,
  StoragePort,
  UsageProviderAdapter,
} from "./ports.js";
import { CredentialVault } from "./credential-vault.js";
import { redeemGlmResetCard } from "./glm-reset-card-redemption.js";
import { getGlmUsage } from "@omniroute/open-sse/services/usage/glm.ts";

interface VendorQuota {
  used: number;
  total: number;
  remaining?: number;
  remainingPercentage?: number;
  resetAt: string | null;
  unlimited: boolean;
  displayName?: string;
}

export interface GlmProvisioningResult {
  authMethod: "api-key" | "cli-import";
  stableIdentity: string;
  displayName: string;
  maskedIdentifier: string;
  publicMetadata: PublicMetadata;
  credentials: Omit<CredentialEnvelope, "accountId">;
}

function metadataRegion(account: Account): GlmRegion {
  return account.publicMetadata.region === "china" ? "china" : "international";
}

function presentationId(region: GlmRegion): string {
  return region === "china" ? "bigmodel-coding-plan" : "zai-coding-plan";
}

function serviceName(region: GlmRegion): string {
  return region === "china" ? "BigModel Coding Plan" : "Z.ai Coding Plan";
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return `${apiKey.slice(0, 2)}***`;
  return `${apiKey.slice(0, 4)}***${apiKey.slice(-4)}`;
}

function stableIdentity(apiKey: string, region: GlmRegion): string {
  const fingerprint = createHash("sha256").update(apiKey).digest("hex").slice(0, 32);
  return `coding-plan:${region}:${fingerprint}`;
}

function windowSeconds(key: string): number | null {
  if (key === "session") return 18_000;
  if (key === "weekly") return 604_800;
  return null;
}

function normalizeQuotas(value: Record<string, VendorQuota>): UsageQuota[] {
  return Object.entries(value).map(([key, quota]) => ({
    key,
    displayName: quota.displayName?.trim() || null,
    windowSeconds: windowSeconds(key),
    used: quota.used,
    total: quota.total,
    remaining: typeof quota.remaining === "number" ? quota.remaining : null,
    remainingPercentage:
      typeof quota.remainingPercentage === "number" ? quota.remainingPercentage : null,
    resetAt: quota.resetAt,
    unlimited: quota.unlimited,
  }));
}

export class GlmAdapter implements UsageProviderAdapter {
  readonly provider: ProviderId = "glm";

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: ClockPort = { now: () => new Date() },
  ) {}

  async createProvisioning(
    apiKeyInput: string,
    region: GlmRegion,
    authMethod: "api-key" | "cli-import" = "api-key",
  ): Promise<GlmProvisioningResult> {
    const apiKey = apiKeyInput.trim();
    if (!apiKey) throw new AppError("validation", "请输入 Coding Plan API Key");
    if (apiKey.length > 4096) throw new AppError("validation", "API Key 长度不正确");
    await this.requestUsage(apiKey, region);
    return {
      authMethod,
      stableIdentity: stableIdentity(apiKey, region),
      displayName: serviceName(region),
      maskedIdentifier: maskApiKey(apiKey),
      publicMetadata: {
        region,
        product: "coding-plan",
        presentationId: presentationId(region),
      },
      credentials: {
        version: 1,
        provider: "glm",
        authMethod,
        expiresAt: null,
        secrets: { apiKey },
      },
    };
  }

  async refreshCredentials(
    _account: Account,
    envelope: CredentialEnvelope,
  ): Promise<CredentialRefreshResult> {
    if (!envelope.secrets.apiKey) {
      throw new AppError("authentication", "GLM Coding Plan API Key 不可用");
    }
    return { envelope, changed: false };
  }

  async fetchUsage(account: Account, envelope: CredentialEnvelope): Promise<UsageSnapshot> {
    const apiKey = envelope.secrets.apiKey;
    if (!apiKey) throw new AppError("authentication", "GLM Coding Plan API Key 不可用");
    const result = await this.requestUsage(apiKey, metadataRegion(account));
    const quotas = normalizeQuotas(result.quotas);
    const percentages = quotas
      .map((quota) => quota.remainingPercentage)
      .filter((value): value is number => value !== null);
    return {
      accountId: account.id,
      plan: result.plan,
      overallRemainingPercentage: percentages.length ? Math.min(...percentages) : null,
      groups: [{ key: "default", displayName: null, quotas }],
      extras: result.resetCards
        ? [
            {
              key: "reset-credits",
              value: String(result.resetCards.availableCount),
              items: result.resetCards.cards.map((card, index) => ({
                key: `${card.resetType.toLowerCase()}:${index}`,
                kind: card.resetType === "FIVE_HOUR" ? "five-hour" : "weekly",
                expiresAt: card.expiresAt,
                actionToken: card.id,
              })),
            },
          ]
        : [],
      fetchedAt: this.clock.now().toISOString(),
    };
  }

  async redeemResetCard(
    account: Account,
    envelope: CredentialEnvelope,
    selectionToken: string,
  ): Promise<void> {
    if (account.provider !== "glm" || envelope.provider !== "glm") {
      throw new AppError("validation", "只有 GLM Coding Plan 账号支持使用重置卡");
    }
    const apiKey = envelope.secrets.apiKey;
    if (!apiKey) throw new AppError("authentication", "GLM Coding Plan API Key 不可用");
    const token = selectionToken.trim();
    if (!token || token.length > 256) {
      throw new AppError("validation", "GLM 重置卡选择标识无效");
    }
    await redeemGlmResetCard(
      apiKey,
      { ...account.publicMetadata, apiRegion: metadataRegion(account) },
      token,
      this.fetchImpl,
    );
  }

  private async requestUsage(apiKey: string, region: GlmRegion) {
    try {
      const result = await getGlmUsage(apiKey, { apiRegion: region }, this.fetchImpl);
      if ("message" in result) {
        const message = typeof result.message === "string" ? result.message : "Unknown error";
        const authentication = /invalid api key|api key not available/i.test(message);
        throw new AppError(
          authentication ? "authentication" : "upstream",
          authentication ? "Coding Plan API Key 无效" : `GLM 用量请求失败：${message}`,
          !authentication,
        );
      }
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("network", "无法获取 GLM Coding Plan 用量", true, { cause: error });
    }
  }
}

export class GlmAccountProvisioner {
  constructor(
    private readonly storage: StoragePort,
    private readonly vault: CredentialVault,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async save(input: GlmProvisioningResult): Promise<Account> {
    const timestamp = this.now().toISOString();
    const existing = this.storage.accounts.findByStableIdentity("glm", input.stableIdentity);
    const account: Account = {
      id: existing?.id ?? this.createId(),
      provider: "glm",
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
