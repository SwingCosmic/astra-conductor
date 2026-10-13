import { createHash, randomUUID } from "node:crypto";
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
import { parseAndValidateClaudeAuth } from "@omniroute/src/lib/oauth/utils/claudeAuthImport.ts";
import { refreshClaudeOAuthToken } from "@omniroute/open-sse/services/tokenRefresh/providers/claude.ts";
import { getRefreshLeadMs } from "@omniroute/open-sse/services/tokenRefresh.ts";
import {
  getClaudeUsage,
  type ClaudeBootstrap,
  type ClaudeUsageQuota,
} from "@omniroute/open-sse/services/usage/claude.ts";

export interface ClaudeProvisioningResult {
  authMethod: "cli-import";
  offeringId: string;
  stableIdentity: string;
  displayName: string;
  maskedIdentifier: string;
  publicMetadata: PublicMetadata;
  credentials: Omit<CredentialEnvelope, "accountId">;
}

function maskIdentifier(value: string): string {
  const at = value.indexOf("@");
  if (at > 1) return `${value.slice(0, 2)}***${value.slice(at)}`;
  if (value.length <= 6) return `${value.slice(0, 1)}***`;
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

function addMetadata(target: PublicMetadata, key: string, value: string | null): void {
  if (value) target[key] = value;
}

function normalizeQuota(key: string, value: ClaudeUsageQuota): UsageQuota {
  return {
    key,
    displayName: value.displayName,
    windowSeconds: key === "session" ? 18_000 : key.startsWith("weekly") ? 604_800 : null,
    used: value.used,
    total: value.total,
    remaining: value.remaining,
    remainingPercentage: value.remainingPercentage,
    resetAt: value.resetAt,
    unlimited: value.unlimited,
  };
}

function stableIdentity(bootstrap: ClaudeBootstrap | null, refreshToken: string): string {
  if (bootstrap?.accountUuid) return `account:${bootstrap.accountUuid}`;
  return `credential:${createHash("sha256").update(refreshToken).digest("hex").slice(0, 32)}`;
}

export class ClaudeAdapter implements UsageProviderAdapter {
  readonly provider: ProviderId = "claude";

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: ClockPort = { now: () => new Date() },
  ) {}

  async createProvisioningFromCli(raw: unknown): Promise<ClaudeProvisioningResult> {
    let parsed;
    try {
      parsed = parseAndValidateClaudeAuth(raw);
    } catch (error) {
      throw new AppError("validation", "Claude Code 凭据格式无效", false, { cause: error });
    }

    let accessToken = parsed.accessToken;
    let refreshToken = parsed.refreshToken;
    let expiresAt = parsed.expiresAt;
    const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    if (Number.isFinite(expiry) && expiry - this.clock.now().getTime() <= 300_000) {
      const refreshed = await this.refreshToken(refreshToken);
      accessToken = refreshed.accessToken;
      refreshToken = refreshed.refreshToken;
      expiresAt = refreshed.expiresAt;
    }

    let usage = await this.requestUsage(accessToken);
    if ("message" in usage && (usage.status === 401 || usage.status === 403)) {
      const refreshed = await this.refreshToken(refreshToken);
      accessToken = refreshed.accessToken;
      refreshToken = refreshed.refreshToken;
      expiresAt = refreshed.expiresAt;
      usage = await this.requestUsage(accessToken);
    }
    if ("message" in usage) throw this.usageError(usage.message, usage.status);

    const identity = stableIdentity(usage.bootstrap, refreshToken);
    const label =
      usage.bootstrap?.accountEmail ?? usage.bootstrap?.organizationName ?? "Claude Code account";
    const publicMetadata: PublicMetadata = {};
    addMetadata(publicMetadata, "accountUuid", usage.bootstrap?.accountUuid ?? null);
    addMetadata(publicMetadata, "organizationUuid", usage.bootstrap?.organizationUuid ?? null);
    addMetadata(publicMetadata, "organizationName", usage.bootstrap?.organizationName ?? null);
    addMetadata(publicMetadata, "organizationType", usage.bootstrap?.organizationType ?? null);
    addMetadata(
      publicMetadata,
      "rateLimitTier",
      usage.bootstrap?.rateLimitTier ?? parsed.rateLimitTier,
    );
    addMetadata(publicMetadata, "subscriptionType", parsed.subscriptionType);
    addMetadata(publicMetadata, "plan", usage.plan);

    return {
      authMethod: "cli-import",
      offeringId: "claude",
      stableIdentity: identity,
      displayName: label,
      maskedIdentifier: maskIdentifier(usage.bootstrap?.accountEmail ?? identity),
      publicMetadata,
      credentials: {
        version: 1,
        provider: "claude",
        authMethod: "cli-import",
        expiresAt,
        secrets: { accessToken, refreshToken },
      },
    };
  }

  async refreshCredentials(
    account: Account,
    envelope: CredentialEnvelope,
    force = false,
  ): Promise<CredentialRefreshResult> {
    const expiry = envelope.expiresAt ? Date.parse(envelope.expiresAt) : Number.NaN;
    const lead = getRefreshLeadMs("claude", account.publicMetadata);
    if (!force && Number.isFinite(expiry) && expiry - this.clock.now().getTime() > lead) {
      return { envelope, changed: false };
    }
    const refreshToken = envelope.secrets.refreshToken;
    if (!refreshToken) throw new AppError("authentication", "Claude refresh token 不可用");
    const refreshed = await this.refreshToken(refreshToken);
    return {
      changed:
        refreshed.accessToken !== envelope.secrets.accessToken ||
        refreshed.refreshToken !== refreshToken ||
        refreshed.expiresAt !== envelope.expiresAt,
      envelope: {
        ...envelope,
        expiresAt: refreshed.expiresAt,
        secrets: {
          ...envelope.secrets,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
        },
      },
    };
  }

  async fetchUsage(account: Account, envelope: CredentialEnvelope): Promise<UsageSnapshot> {
    const accessToken = envelope.secrets.accessToken;
    if (!accessToken) throw new AppError("authentication", "Claude access token 不可用");
    const result = await this.requestUsage(accessToken);
    if ("message" in result) throw this.usageError(result.message, result.status);
    const quotas = Object.entries(result.quotas).map(([key, value]) => normalizeQuota(key, value));
    const modelQuotas = Object.entries(result.modelQuotas).map(([key, value]) =>
      normalizeQuota(key, value),
    );
    return {
      accountId: account.id,
      plan:
        result.plan ??
        (typeof account.publicMetadata.plan === "string"
          ? account.publicMetadata.plan
          : "Claude Code"),
      overallRemainingPercentage: quotas.length
        ? Math.min(...quotas.map((quota) => quota.remainingPercentage ?? 100))
        : null,
      groups: [
        { key: "default", displayName: null, quotas },
        ...(modelQuotas.length
          ? [{ key: "model-limits", displayName: "Model limits", quotas: modelQuotas }]
          : []),
      ],
      extras: [],
      resetCredits: null,
      fetchedAt: this.clock.now().toISOString(),
    };
  }

  private requestUsage(accessToken: string) {
    return getClaudeUsage(accessToken, this.fetchImpl);
  }

  private async refreshToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: string | null;
  }> {
    try {
      const result = await refreshClaudeOAuthToken(refreshToken, this.fetchImpl);
      if (!result) throw new AppError("network", "Claude 令牌刷新失败", true);
      if ("error" in result) {
        throw new AppError("authentication", "Claude 授权已失效，请重新运行 claude 登录");
      }
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt:
          result.expiresIn === undefined
            ? null
            : new Date(this.clock.now().getTime() + result.expiresIn * 1000).toISOString(),
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("network", "Claude 令牌刷新失败", true, { cause: error });
    }
  }

  private usageError(message: string, status: number | null): AppError {
    const authentication = status === 401 || status === 403;
    return new AppError(
      authentication ? "authentication" : status === null ? "network" : "upstream",
      authentication
        ? "Claude 授权已失效，请重新运行 claude 登录"
        : `Claude 用量请求失败：${message}`,
      !authentication,
    );
  }
}

export class ClaudeAccountProvisioner {
  constructor(
    private readonly storage: StoragePort,
    private readonly vault: CredentialVault,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async save(input: ClaudeProvisioningResult): Promise<Account> {
    const timestamp = this.now().toISOString();
    const existing = this.storage.accounts.findByStableIdentity("claude", input.stableIdentity);
    const account: Account = {
      id: existing?.id ?? this.createId(),
      provider: "claude",
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
