import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../../errors.js";
import type {
  Account,
  CredentialEnvelope,
  ProviderId,
  PublicMetadata,
  ResetCreditRedemption,
  ResetCreditItem,
  ResetCredits,
  UsageQuota,
  UsageSnapshot,
} from "../../models.js";
import type {
  ClockPort,
  CredentialRefreshResult,
  StoragePort,
  UsageProviderAdapter,
} from "../../ports.js";
import { includedQuotas } from "../quota-inclusion.js";
import { CredentialVault } from "../../credential-vault.js";
import { redeemGlmResetCard } from "./reset-card-redemption.js";
import { glmRegionForOffering, type GlmRegion } from "./zcode-credentials.js";
import { getGlmUsage } from "@omniroute/open-sse/services/usage/glm.ts";

interface VendorQuota {
  used: number;
  total: number;
  remaining?: number;
  remainingPercentage?: number;
  resetAt: string | null;
  unlimited: boolean;
  displayName?: string;
  rawAmounts?: boolean;
}

export interface GlmProvisioningResult {
  authMethod: "api-key" | "cli-import";
  offeringId: string;
  stableIdentity: string;
  displayName: string;
  maskedIdentifier: string;
  publicMetadata: PublicMetadata;
  credentials: Omit<CredentialEnvelope, "accountId">;
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
    rawAmounts: quota.rawAmounts === true,
  }));
}

function normalizeResetCredits(
  cards: readonly { id: string; resetType: string; expiresAt: string | null }[],
): ResetCreditItem[] {
  return cards.map((card) => ({
    id: card.id,
    type: card.resetType === "FIVE_HOUR" ? "five-hour" : "weekly",
    expiresAt: card.expiresAt,
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
    offeringId: string,
    authMethod: "api-key" | "cli-import" = "api-key",
  ): Promise<GlmProvisioningResult> {
    const region = glmRegionForOffering(offeringId);
    const apiKey = apiKeyInput.trim();
    if (!apiKey) throw new AppError("validation", "请输入 Coding Plan API Key");
    if (apiKey.length > 4096) throw new AppError("validation", "API Key 长度不正确");
    await this.requestUsage(apiKey, region);
    return {
      authMethod,
      offeringId,
      stableIdentity: stableIdentity(apiKey, region),
      displayName: serviceName(region),
      maskedIdentifier: maskApiKey(apiKey),
      publicMetadata: {},
      credentials: {
        version: 1,
        provider: "glm",
        authMethod,
        expiresAt: null,
        secrets: { apiKey },
      },
    };
  }

  async fetchUsage(account: Account, envelope: CredentialEnvelope): Promise<UsageSnapshot> {
    const apiKey = envelope.secrets.apiKey;
    if (!apiKey) throw new AppError("authentication", "GLM Coding Plan API Key 不可用");
    const region = glmRegionForOffering(account.offeringId);
    const result = await this.requestUsage(apiKey, region);
    const quotas = normalizeQuotas(result.quotas);
    const percentages = quotas
      .map((quota) => quota.remainingPercentage)
      .filter((value): value is number => value !== null);
    const resetCredits: ResetCredits | null = result.resetCards
      ? { kind: "itemized", items: normalizeResetCredits(result.resetCards.cards) }
      : null;
    return {
      accountId: account.id,
      // plan 是目录匹配用的归一化标识；上游原始 planName（TitleCase 改写前）
      // 附带为 rawPlanLabel，仅在目录未命中时作展示回退。
      plan: result.plan,
      rawPlanLabel: result.planLabel ?? null,
      overallRemainingPercentage: percentages.length ? Math.min(...percentages) : null,
      groups: [{ key: "default", displayName: null, quotas: includedQuotas(quotas) }],
      extras: [],
      resetCredits,
      fetchedAt: this.clock.now().toISOString(),
    };
  }

  /**
   * GLM 的重置额度是分体形态：快照 `resetCredits.kind === "itemized"`，消耗
   * 必须携带对应重置卡 id；兑换前重新校验列表，失效即报“请刷新”。
   */
  async redeemResetCard(
    account: Account,
    envelope: CredentialEnvelope,
    request: ResetCreditRedemption,
  ): Promise<void> {
    if (request.kind !== "item") {
      throw new AppError("validation", "GLM 重置卡为逐张使用，请选择具体重置卡");
    }
    if (account.provider !== "glm" || envelope.provider !== "glm") {
      throw new AppError("validation", "只有 GLM Coding Plan 账号支持使用重置卡");
    }
    const apiKey = envelope.secrets.apiKey;
    if (!apiKey) throw new AppError("authentication", "GLM Coding Plan API Key 不可用");
    const itemId = request.itemId.trim();
    if (!itemId || itemId.length > 256) {
      throw new AppError("validation", "GLM 重置卡选择标识无效");
    }
    await redeemGlmResetCard(
      apiKey,
      { apiRegion: glmRegionForOffering(account.offeringId) },
      itemId,
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
