import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../../errors.js";
import type {
  Account,
  CredentialEnvelope,
  PublicMetadata,
  ProviderId,
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
import {
  getGitHubCopilotChatUserAgent,
  getGitHubCopilotInternalUserHeaders,
} from "@omniroute/open-sse/config/providerHeaderProfiles.ts";
import { resolvePublicCred } from "@omniroute/open-sse/utils/publicCreds.ts";
import { getGitHubUsage } from "@omniroute/open-sse/services/usage/github.ts";

/** 与 OmniRoute GITHUB_CONFIG 同源的端点；client id 是公共 CLI 凭据。 */
const COPILOT_CONFIG = {
  clientId: resolvePublicCred("github_copilot_id", "GITHUB_OAUTH_CLIENT_ID"),
  deviceCodeUrl: "https://github.com/login/device/code",
  tokenUrl: "https://github.com/login/oauth/access_token",
  copilotUserUrl: "https://api.github.com/copilot_internal/user",
  scopes: "read:user",
} as const;

export interface CopilotDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  intervalSec: number;
  expiresAtMs: number;
}

export interface CopilotProvisioningResult {
  authMethod: "device-code";
  offeringId: string;
  stableIdentity: string;
  displayName: string;
  maskedIdentifier: string;
  publicMetadata: PublicMetadata;
  credentials: Omit<CredentialEnvelope, "accountId">;
}

function stringMetadata(value: unknown): string | null {
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
        reject(new AppError("authentication", "GitHub Copilot 授权已取消"));
      },
      { once: true },
    );
  });
}

/** 月度配额窗口；GitHub 语义上按 quota_reset_date 重置而非固定 30 天。 */
const MONTHLY_WINDOW_SECONDS = 2_592_000;

const quotaDisplayNames: Record<string, string> = {
  premium_interactions: "高级请求",
  chat: "对话补全",
  completions: "代码补全",
};

interface GitHubUserInfo {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

export class CopilotAdapter implements UsageProviderAdapter {
  readonly provider: ProviderId = "github-copilot";

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: ClockPort = { now: () => new Date() },
  ) {}

  async requestDeviceAuthorization(): Promise<CopilotDeviceAuthorization> {
    const response = await this.fetchImpl(COPILOT_CONFIG.deviceCodeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: COPILOT_CONFIG.clientId,
        scope: COPILOT_CONFIG.scopes,
      }),
    });
    if (!response.ok) {
      throw new AppError("network", "GitHub 设备码申请失败", true);
    }
    const data = (await response.json()) as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      verification_uri_complete?: string;
      expires_in?: number;
      interval?: number;
    };
    if (!data.device_code || !data.user_code || !data.verification_uri) {
      throw new AppError("upstream", "GitHub 设备码响应不完整", true);
    }
    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete ?? data.verification_uri,
      intervalSec: data.interval ?? 5,
      expiresAtMs: this.clock.now().getTime() + (data.expires_in ?? 900) * 1000,
    };
  }

  async finishDeviceAuthorization(
    authorization: CopilotDeviceAuthorization,
    signal?: AbortSignal,
  ): Promise<CopilotProvisioningResult> {
    let intervalMs = authorization.intervalSec * 1000;
    while (this.clock.now().getTime() < authorization.expiresAtMs) {
      if (signal?.aborted) throw new AppError("authentication", "GitHub Copilot 授权已取消");
      const poll = await this.pollDeviceToken(authorization.deviceCode);
      if (poll.status === "granted") return this.authorize(poll.accessToken);
      if (poll.slowDown) intervalMs += 5_000;
      await delay(intervalMs, signal);
    }
    throw new AppError("authentication", "GitHub Copilot 设备授权已超时");
  }

  private async pollDeviceToken(
    deviceCode: string,
  ): Promise<
    { status: "granted"; accessToken: string } | { status: "pending"; slowDown: boolean }
  > {
    const response = await this.fetchImpl(COPILOT_CONFIG.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: COPILOT_CONFIG.clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
    };
    if (data.access_token) return { status: "granted", accessToken: data.access_token };
    if (data.error === "authorization_pending") return { status: "pending", slowDown: false };
    if (data.error === "slow_down") return { status: "pending", slowDown: true };
    throw new AppError("authentication", "GitHub Copilot 设备授权失败");
  }

  /**
   * GitHub 设备流的 OAuth 令牌长期有效且无刷新令牌。`copilot_internal/v2/token`
   * 会话令牌交换已被 GitHub 收紧拒斥（openclaw 已同步弃用，"The retired
   * `/v2/token` exchange"），现行 CLI/SDK 口径是用原始 OAuth 令牌直接访问
   * `/user`。接入时以一次 `/user` 探测确认令牌可访问 Copilot，不再铸造会话
   * 令牌；凭据形态因此无过期跟踪（信封 `expiresAt` 为 null）。
   */
  private async validateCopilotAccess(accessToken: string): Promise<void> {
    const response = await this.fetchImpl(COPILOT_CONFIG.copilotUserUrl, {
      headers: getGitHubCopilotInternalUserHeaders(`Bearer ${accessToken}`),
    });
    if (response.status === 401 || response.status === 403) {
      throw new AppError("authentication", "GitHub 授权已失效，请重新接入");
    }
    if (!response.ok) throw new AppError("upstream", "Copilot 访问校验失败", true);
  }

  /**
   * /user 与上游 OmniRoute 一致按尽力而为处理：它对 copilot 编辑器指纹头
   * 不友好，失败时不阻断授权，依次退回会话令牌 annotations 中的 user id、
   * 再退回 OAuth 令牌指纹建档（后者跨重新授权不稳定，属降级形态）。
   */
  private async fetchUserInfo(accessToken: string): Promise<GitHubUserInfo | null> {
    const response = await this.fetchImpl("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": getGitHubCopilotChatUserAgent(),
      },
    });
    if (!response.ok) return null;
    const user = (await response.json().catch(() => null)) as GitHubUserInfo | null;
    return user && typeof user.login === "string" ? user : null;
  }

  private provision(accessToken: string, user: GitHubUserInfo | null): CopilotProvisioningResult {
    const metadata: PublicMetadata = {};
    if (user) {
      metadata.githubLogin = user.login;
      if (typeof user.id === "number") metadata.githubUserId = user.id;
      const name = stringMetadata(user.name);
      const email = stringMetadata(user.email);
      if (name) metadata.githubName = name;
      if (email) metadata.githubEmail = email;
    }
    const identity =
      user && typeof user.id === "number"
        ? `github:${user.id}`
        : `github-token:${createHash("sha256").update(accessToken).digest("hex").slice(0, 24)}`;
    const name = stringMetadata(user?.name);
    const email = stringMetadata(user?.email);
    const fallbackLabel = "GitHub Copilot 账号";
    return {
      authMethod: "device-code",
      offeringId: "github-copilot",
      stableIdentity: identity,
      displayName: name ?? user?.login ?? fallbackLabel,
      maskedIdentifier: maskIdentifier(email ?? user?.login ?? "github-account"),
      publicMetadata: metadata,
      credentials: {
        version: 1,
        provider: "github-copilot",
        authMethod: "device-code",
        expiresAt: null,
        secrets: {
          accessToken,
        },
      },
    };
  }

  private async authorize(accessToken: string): Promise<CopilotProvisioningResult> {
    await this.validateCopilotAccess(accessToken);
    return this.provision(accessToken, await this.fetchUserInfo(accessToken));
  }

  /**
   * GitHub 设备流的 OAuth 令牌长期有效且无刷新令牌；v2/token 会话令牌层退役
   * 后没有可轮换的凭据。此方法只负责把历史信封（`expiresAt` 跟踪会话令牌
   * 过期 + `copilotToken` 密钥）迁移为无过期形态，之后是幂等 no-op，不发
   * 网络请求。令牌真的失效时由用量刷新的 401/403 报"请重新接入"。
   */
  async refreshCredentials(
    account: Account,
    envelope: CredentialEnvelope,
    _force = false,
  ): Promise<CredentialRefreshResult> {
    if (account.provider !== "github-copilot") {
      throw new AppError("validation", "只有 GitHub Copilot 账号走该刷新协议");
    }
    if (envelope.expiresAt === null && envelope.secrets.copilotToken === undefined) {
      return { envelope, changed: false };
    }
    const { copilotToken: _legacySessionToken, ...secrets } = envelope.secrets;
    return {
      changed: true,
      envelope: { ...envelope, expiresAt: null, secrets },
    };
  }

  async fetchUsage(account: Account, envelope: CredentialEnvelope): Promise<UsageSnapshot> {
    const accessToken = envelope.secrets.accessToken;
    if (!accessToken) throw new AppError("authentication", "GitHub 访问令牌不可用");
    const result = await getGitHubUsage(accessToken);
    if ("message" in result) {
      const message = result.message ?? "Copilot 用量请求失败";
      const authentication = message.includes("re-authenticate");
      throw new AppError(
        authentication ? "authentication" : "upstream",
        authentication ? "GitHub 授权已失效，请重新接入" : `Copilot 用量请求失败：${message}`,
        !authentication,
      );
    }
    const quotas = Object.entries(result.quotas).map(([key, quota]) => ({
      key,
      displayName: quotaDisplayNames[key] ?? null,
      windowSeconds: MONTHLY_WINDOW_SECONDS,
      used: quota.used,
      total: quota.total,
      remaining: quota.remaining ?? 0,
      remainingPercentage: quota.remainingPercentage ?? null,
      resetAt: quota.resetAt,
      unlimited: quota.unlimited,
      rawAmounts: quota.rawAmounts === true,
    }));
    return {
      accountId: account.id,
      // plan 是叶子上游原始标识（copilot_plan / access_type_sku 透传），目录
      // 匹配按它进行；推断合成的展示名只作未命中回退（rawPlanLabel）。
      plan: result.plan,
      rawPlanLabel: result.planLabel?.trim() || null,
      overallRemainingPercentage: quotas.length
        ? Math.min(...quotas.map((quota) => quota.remainingPercentage ?? 100))
        : null,
      groups: [{ key: "default", displayName: null, quotas: includedQuotas(quotas) }],
      extras: [],
      resetCredits: null,
      fetchedAt: this.clock.now().toISOString(),
    };
  }
}

export class CopilotAccountProvisioner {
  constructor(
    private readonly storage: StoragePort,
    private readonly vault: CredentialVault,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async save(input: CopilotProvisioningResult): Promise<Account> {
    const timestamp = this.now().toISOString();
    const existing = this.storage.accounts.findByStableIdentity(
      "github-copilot",
      input.stableIdentity,
    );
    const account: Account = {
      id: existing?.id ?? this.createId(),
      provider: "github-copilot",
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
