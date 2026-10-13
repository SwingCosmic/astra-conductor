import { randomUUID } from "node:crypto";
import { AppError } from "../../errors.js";
import type {
  Account,
  CredentialEnvelope,
  PublicMetadata,
  ProviderId,
  UsageQuota,
  UsageSnapshot,
} from "../../models.js";
import type {
  ClockPort,
  CredentialRefreshResult,
  StoragePort,
  UsageProviderAdapter,
} from "../../ports.js";
import { CredentialVault } from "../../credential-vault.js";
import { generatePKCE } from "@omniroute/src/lib/oauth/utils/pkce.ts";
import {
  buildGrokBuildAuthUrl,
  exchangeGrokBuildToken,
  mapGrokBrowserTokens,
  mapGrokImportedToken,
  pollGrokDeviceToken,
  requestGrokDeviceCode,
  type GrokDeviceAuthorization as VendorDeviceAuthorization,
  type GrokMappedTokens,
} from "@omniroute/src/lib/oauth/providers/grok-cli.ts";
import { parseGrokCliAuthJson } from "@omniroute/src/lib/oauth/utils/grokCliAuthJson.ts";
import { refreshGrokBuildToken } from "@omniroute/open-sse/services/tokenRefresh/providers/grok.ts";
import { getGrokCliUsage } from "@omniroute/open-sse/services/usage/grokCli.ts";

export interface GrokBrowserAuthorization {
  url: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface GrokDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  intervalSec: number;
  expiresAtMs: number;
}

export interface GrokProvisioningResult {
  authMethod: "browser-oauth" | "device-code" | "cli-import";
  offeringId: string;
  stableIdentity: string;
  displayName: string;
  maskedIdentifier: string;
  publicMetadata: PublicMetadata;
  credentials: Omit<CredentialEnvelope, "accountId">;
}

function stringMetadata(value: PublicMetadata[string]): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function maskIdentifier(value: string): string {
  const at = value.indexOf("@");
  if (at > 1) return `${value.slice(0, 2)}***${value.slice(at)}`;
  if (value.length <= 6) return `${value.slice(0, 1)}***`;
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new AppError("authentication", "Grok Build 授权已取消"));
      },
      { once: true },
    );
  });
}

export class GrokBuildAdapter implements UsageProviderAdapter {
  readonly provider: ProviderId = "grok-build";

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: ClockPort = { now: () => new Date() },
  ) {}

  createBrowserAuthorization(
    redirectUri = "http://127.0.0.1:56122/callback",
  ): GrokBrowserAuthorization {
    const { codeVerifier, codeChallenge, state } = generatePKCE(96);
    return {
      url: buildGrokBuildAuthUrl(redirectUri, state, codeChallenge),
      state,
      codeVerifier,
      redirectUri,
    };
  }

  async finishBrowserAuthorization(
    authorization: GrokBrowserAuthorization,
    code: string,
  ): Promise<GrokProvisioningResult> {
    const tokens = await exchangeGrokBuildToken(
      code,
      authorization.redirectUri,
      authorization.codeVerifier,
      this.fetchImpl,
    );
    return this.fromTokens(mapGrokBrowserTokens(tokens), "browser-oauth");
  }

  async requestDeviceAuthorization(): Promise<GrokDeviceAuthorization> {
    const result: VendorDeviceAuthorization = await requestGrokDeviceCode(this.fetchImpl);
    return {
      deviceCode: result.deviceCode,
      userCode: result.userCode,
      verificationUri: result.verificationUri,
      verificationUriComplete: result.verificationUriComplete,
      intervalSec: result.interval,
      expiresAtMs: this.clock.now().getTime() + result.expiresIn * 1000,
    };
  }

  async finishDeviceAuthorization(
    authorization: GrokDeviceAuthorization,
    signal?: AbortSignal,
  ): Promise<GrokProvisioningResult> {
    let intervalMs = authorization.intervalSec * 1000;
    while (this.clock.now().getTime() < authorization.expiresAtMs) {
      if (signal?.aborted) throw new AppError("authentication", "Grok Build 授权已取消");
      const result = await pollGrokDeviceToken(authorization.deviceCode, this.fetchImpl);
      if (result.ok) return this.fromTokens(mapGrokBrowserTokens(result.data), "device-code");
      const code = typeof result.data.error === "string" ? result.data.error : "";
      if (code === "authorization_pending") {
        await delay(intervalMs, signal);
        continue;
      }
      if (code === "slow_down") {
        intervalMs += 5_000;
        await delay(intervalMs, signal);
        continue;
      }
      throw new AppError("authentication", "Grok Build 设备授权失败");
    }
    throw new AppError("authentication", "Grok Build 设备授权已超时");
  }

  fromCliAuth(raw: unknown): GrokProvisioningResult {
    const parsed = parseGrokCliAuthJson(raw);
    if (!parsed.ok) throw new AppError("validation", parsed.error);
    try {
      return this.fromTokens(mapGrokImportedToken(parsed.token), "cli-import");
    } catch (error) {
      throw new AppError("validation", "Grok CLI 凭据无效", false, { cause: error });
    }
  }

  async refreshCredentials(
    account: Account,
    envelope: CredentialEnvelope,
    force = false,
  ): Promise<CredentialRefreshResult> {
    const expiry = envelope.expiresAt ? Date.parse(envelope.expiresAt) : Number.NaN;
    if (!force && Number.isFinite(expiry) && expiry - this.clock.now().getTime() > 300_000) {
      return { envelope, changed: false };
    }
    const refreshToken = envelope.secrets.refreshToken;
    if (!refreshToken) throw new AppError("authentication", "Grok Build refresh token 不可用");
    const result = await refreshGrokBuildToken(
      refreshToken,
      account.publicMetadata,
      this.fetchImpl,
    );
    if (!result) throw new AppError("network", "Grok Build 令牌刷新失败", true);
    if ("error" in result) {
      throw new AppError("authentication", "Grok Build 授权已失效，请重新接入");
    }
    const expiresAt = new Date(this.clock.now().getTime() + result.expiresIn * 1000).toISOString();
    return {
      changed:
        result.accessToken !== envelope.secrets.accessToken ||
        result.refreshToken !== refreshToken ||
        expiresAt !== envelope.expiresAt,
      envelope: {
        ...envelope,
        expiresAt,
        secrets: {
          ...envelope.secrets,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        },
      },
    };
  }

  async fetchUsage(account: Account, envelope: CredentialEnvelope): Promise<UsageSnapshot> {
    const result = await getGrokCliUsage(
      envelope.secrets.accessToken,
      {
        userId: stringMetadata(account.publicMetadata.userId),
        email: stringMetadata(account.publicMetadata.email),
        principalType: stringMetadata(account.publicMetadata.principalType),
      },
      this.fetchImpl,
    );
    if ("message" in result) {
      throw new AppError("upstream", result.message ?? "Grok Build 用量请求失败", true);
    }
    const quotas: UsageQuota[] = result.quotas.map((quota) => {
      const used = Math.max(0, Math.min(100, quota.usedPercentage));
      return {
        key: quota.key,
        displayName: quota.displayName,
        windowSeconds: quota.key === "weekly" ? 604_800 : null,
        used,
        total: 100,
        remaining: 100 - used,
        remainingPercentage: 100 - used,
        resetAt: quota.resetAt,
        unlimited: false,
      };
    });
    const extras = [];
    if (result.resetCredits?.ok) {
      extras.push({
        key: "reset-credits",
        value: String(result.resetCredits.snapshot.count),
      });
    }
    if (result.billing.extraCreditsMinorUnits !== null) {
      extras.push({
        key: "extra-credits",
        value: new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
        }).format(result.billing.extraCreditsMinorUnits / 100),
      });
    }
    if (result.billing.autoTopUpAvailable) {
      extras.push({
        key: "auto-top-up",
        value: result.billing.autoTopUpEnabled ? "已启用" : "已停用",
      });
    }
    return {
      accountId: account.id,
      plan: result.plan,
      overallRemainingPercentage: quotas.length
        ? Math.min(...quotas.map((quota) => quota.remainingPercentage ?? 100))
        : null,
      groups: [{ key: "default", displayName: null, quotas }],
      extras,
      // grok 的重置额度暂以计数展示在 extras；grpc 帧已能解出逐项 token 与
      // 过期时间但无类型字段且未接入消耗协议，升级分体时另行评估。
      resetCredits: null,
      fetchedAt: this.clock.now().toISOString(),
    };
  }

  private fromTokens(
    tokens: GrokMappedTokens,
    authMethod: GrokProvisioningResult["authMethod"],
  ): GrokProvisioningResult {
    if (!tokens.accessToken || !tokens.refreshToken) {
      throw new AppError("validation", "Grok Build 凭据缺少可刷新令牌");
    }
    const metadata: PublicMetadata = {};
    for (const [key, value] of Object.entries(tokens.providerSpecificData)) {
      if (value !== undefined) metadata[key] = value;
    }
    const principalType = stringMetadata(metadata.principalType);
    const principalId = stringMetadata(metadata.principalId);
    const userId = stringMetadata(metadata.userId);
    const email = tokens.email ?? stringMetadata(metadata.email);
    const identity = principalId ?? userId ?? email ?? "grok-build";
    const stableIdentity = principalType ? `${principalType}:${identity}` : `user:${identity}`;
    const label = tokens.name ?? email ?? userId ?? "Grok Build account";
    return {
      authMethod,
      offeringId: "grok-build",
      stableIdentity,
      displayName: label,
      maskedIdentifier: maskIdentifier(email ?? identity),
      publicMetadata: metadata,
      credentials: {
        version: 1,
        provider: "grok-build",
        authMethod,
        expiresAt: new Date(this.clock.now().getTime() + tokens.expiresIn * 1000).toISOString(),
        secrets: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
        },
      },
    };
  }
}

export class GrokBuildAccountProvisioner {
  constructor(
    private readonly storage: StoragePort,
    private readonly vault: CredentialVault,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async save(input: GrokProvisioningResult): Promise<Account> {
    const timestamp = this.now().toISOString();
    const existing = this.storage.accounts.findByStableIdentity("grok-build", input.stableIdentity);
    const account: Account = {
      id: existing?.id ?? this.createId(),
      provider: "grok-build",
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
