import { CoreServices } from "../../services/contracts.js";
import type { ServiceResolver } from "../../services/registry.js";
import { randomUUID } from "node:crypto";
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
import { generateState } from "@omniroute/src/lib/oauth/utils/pkce.ts";
import {
  buildAntigravityAuthUrl,
  exchangeAntigravityToken,
  finishAntigravityExchange,
} from "@omniroute/src/lib/oauth/providers/antigravity.ts";
import { ANTIGRAVITY_CONFIG } from "@omniroute/src/lib/oauth/constants/oauth.ts";
import { refreshGoogleToken } from "@omniroute/open-sse/services/tokenRefresh/providers/google.ts";
import { getAntigravityUsage } from "@omniroute/open-sse/services/usage/antigravity.ts";

export interface AntigravityBrowserAuthorization {
  url: string;
  state: string;
  redirectUri: string;
}

export interface AntigravityProvisioningResult {
  authMethod: "browser-oauth";
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
  return value.length > 6 ? `${value.slice(0, 3)}***${value.slice(-2)}` : `${value[0] ?? "A"}***`;
}

function metadataText(account: Account, key: string): string | null {
  const value = account.publicMetadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export class AntigravityAdapter implements UsageProviderAdapter {
  readonly provider: ProviderId = "antigravity";

  private readonly fetchImpl: typeof fetch;
  private readonly clock: ClockPort;

  constructor(services: ServiceResolver) {
    this.fetchImpl = services.get(CoreServices.http).fetch;
    this.clock = services.get(CoreServices.clock);
  }

  createBrowserAuthorization(redirectUri: string): AntigravityBrowserAuthorization {
    const state = generateState();
    return { url: buildAntigravityAuthUrl(redirectUri, state), state, redirectUri };
  }

  async finishBrowserAuthorization(
    authorization: AntigravityBrowserAuthorization,
    code: string,
  ): Promise<AntigravityProvisioningResult> {
    const tokens = await exchangeAntigravityToken(code, authorization.redirectUri, this.fetchImpl);
    const discovered = await finishAntigravityExchange(tokens, this.fetchImpl);
    if (!discovered.projectId) {
      const message =
        discovered.projectDiscoveryOutcome === "requires_manual_project"
          ? "Antigravity 账号需要先配置 Cloud Code 项目"
          : "未能发现 Antigravity Cloud Code 项目";
      throw new AppError("authentication", message);
    }
    if (!tokens.refresh_token) {
      throw new AppError("authentication", "Antigravity 未返回 refresh token，请重新授权");
    }
    const email = discovered.email ?? discovered.projectId;
    return {
      authMethod: "browser-oauth",
      offeringId: "antigravity",
      stableIdentity: `${discovered.projectId}:${email.toLowerCase()}`,
      displayName: email,
      maskedIdentifier: maskIdentifier(email),
      publicMetadata: {
        projectId: discovered.projectId,
        clientProfile: "ide",
        tier: discovered.tierId,
        oauthClient: discovered.oauthClient,
      },
      credentials: {
        version: 1,
        provider: "antigravity",
        authMethod: "browser-oauth",
        expiresAt: new Date(
          this.clock.now().getTime() + (tokens.expires_in ?? 3600) * 1000,
        ).toISOString(),
        secrets: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
        },
      },
    };
  }

  async refreshCredentials(
    _account: Account,
    envelope: CredentialEnvelope,
    force = false,
  ): Promise<CredentialRefreshResult> {
    const expiry = envelope.expiresAt ? Date.parse(envelope.expiresAt) : Number.NaN;
    if (!force && Number.isFinite(expiry) && expiry - this.clock.now().getTime() > 900_000) {
      return { envelope, changed: false };
    }
    const refreshToken = envelope.secrets.refreshToken;
    if (!refreshToken) throw new AppError("authentication", "Antigravity refresh token 不可用");
    const result = await refreshGoogleToken(
      refreshToken,
      ANTIGRAVITY_CONFIG.clientId,
      ANTIGRAVITY_CONFIG.clientSecret,
      this.fetchImpl,
    );
    if (!result) throw new AppError("network", "Antigravity 令牌刷新失败", true);
    if ("error" in result) {
      throw new AppError("authentication", "Antigravity 授权已失效，请重新接入");
    }
    const expiresAt = new Date(
      this.clock.now().getTime() + (result.expiresIn ?? 3600) * 1000,
    ).toISOString();
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
    const result = await getAntigravityUsage(
      envelope.secrets.accessToken,
      metadataText(account, "projectId") ?? undefined,
      metadataText(account, "tier"),
      this.fetchImpl,
    );
    if ("message" in result) {
      throw new AppError("upstream", result.message ?? "Antigravity 用量请求失败", true);
    }
    const groups = result.groups.map((group) => ({
      ...group,
      quotas: includedQuotas(group.quotas),
    }));
    const percentages = groups
      .flatMap((group) => group.quotas)
      .map((quota) => quota.remainingPercentage)
      .filter((value): value is number => value !== null);
    return {
      accountId: account.id,
      plan: result.plan,
      overallRemainingPercentage: percentages.length ? Math.min(...percentages) : null,
      groups,
      extras: [],
      resetCredits: null,
      fetchedAt: this.clock.now().toISOString(),
    };
  }
}

export class AntigravityAccountProvisioner {
  constructor(
    private readonly storage: StoragePort,
    private readonly vault: CredentialVault,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async save(input: AntigravityProvisioningResult): Promise<Account> {
    const timestamp = this.now().toISOString();
    const existing = this.storage.accounts.findByStableIdentity(
      "antigravity",
      input.stableIdentity,
    );
    const account: Account = {
      id: existing?.id ?? this.createId(),
      provider: "antigravity",
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
