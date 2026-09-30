import { randomUUID } from "node:crypto";
import { AppError } from "../../errors.js";
import type {
  Account,
  AuthMethod,
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
import { getCodexUsage } from "@omniroute/open-sse/services/usage/codex.ts";
import { refreshCodexToken } from "@omniroute/open-sse/services/tokenRefresh/providers/codex.ts";
import { getRefreshLeadMs } from "@omniroute/open-sse/services/tokenRefresh.ts";
import { codex, type CodexOAuthTokens } from "@omniroute/src/lib/oauth/providers/codex.ts";
import { parseAndValidateCodexAuth } from "@omniroute/src/lib/oauth/utils/codexAuthImport.ts";
import { generatePKCE } from "@omniroute/src/lib/oauth/utils/pkce.ts";
import {
  exchangeCodeForTokens,
  pollForAuthorization,
  requestUserCode,
} from "@omniroute/src/lib/oauth/codexDeviceFlow.ts";

interface JsonRecord {
  [key: string]: unknown;
}

export interface CodexProvisioningResult {
  authMethod: Exclude<AuthMethod, "api-key">;
  stableIdentity: string;
  displayName: string;
  maskedIdentifier: string;
  publicMetadata: PublicMetadata;
  credentials: Omit<CredentialEnvelope, "accountId">;
}

export interface BrowserAuthorization {
  url: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface DeviceAuthorization {
  deviceAuthId: string;
  userCode: string;
  intervalSec: number;
  verificationUri: string;
}

function maskIdentifier(value: string): string {
  const at = value.indexOf("@");
  if (at > 1) return `${value.slice(0, 2)}***${value.slice(at)}`;
  if (value.length <= 6) return `${value.slice(0, 1)}***`;
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildStableIdentity(
  workspaceId: string | null,
  userId: string | null,
  email: string,
): string {
  return `${workspaceId ?? "personal"}:${userId ?? email.toLowerCase()}`;
}

function normalizeQuotas(value: unknown): UsageQuota[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, JsonRecord>).map(([key, quota]) => {
    const used = typeof quota.used === "number" ? quota.used : 0;
    const total = typeof quota.total === "number" ? quota.total : 0;
    const remaining = typeof quota.remaining === "number" ? quota.remaining : null;
    return {
      key,
      displayName: stringValue(quota.displayName),
      windowSeconds:
        typeof quota.windowSeconds === "number" && Number.isFinite(quota.windowSeconds)
          ? quota.windowSeconds
          : null,
      used,
      total,
      remaining,
      remainingPercentage:
        remaining !== null && total > 0
          ? Math.max(0, Math.min(100, (remaining / total) * 100))
          : null,
      resetAt: stringValue(quota.resetAt),
      unlimited: quota.unlimited === true,
    };
  });
}

export class CodexAdapter implements UsageProviderAdapter {
  readonly provider: ProviderId = "codex";
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: ClockPort = { now: () => new Date() },
  ) {}

  createBrowserAuthorization(
    redirectUri = "http://localhost:1455/auth/callback",
  ): BrowserAuthorization {
    const { codeVerifier, codeChallenge, state } = generatePKCE();
    return {
      url: codex.buildAuthUrl(codex.config, redirectUri, state, codeChallenge),
      state,
      codeVerifier,
      redirectUri,
    };
  }

  async finishBrowserAuthorization(
    authorization: BrowserAuthorization,
    code: string,
  ): Promise<CodexProvisioningResult> {
    const tokens = await codex.exchangeToken(
      codex.config,
      code,
      authorization.redirectUri,
      authorization.codeVerifier,
      this.fetchImpl,
    );
    return this.fromBrowserTokens(tokens);
  }

  requestDeviceAuthorization(signal?: AbortSignal): Promise<DeviceAuthorization> {
    return requestUserCode(undefined, signal, this.fetchImpl);
  }

  async finishDeviceAuthorization(
    authorization: DeviceAuthorization,
    signal?: AbortSignal,
  ): Promise<CodexProvisioningResult> {
    const result = await pollForAuthorization(
      authorization.deviceAuthId,
      authorization.userCode,
      authorization.intervalSec,
      { signal, fetchImpl: this.fetchImpl },
    );
    const tokens = await exchangeCodeForTokens(
      result.authorizationCode,
      result.codeVerifier,
      undefined,
      signal,
      this.fetchImpl,
    );
    return this.fromDeviceTokens({ ...tokens });
  }

  fromBrowserTokens(tokens: CodexOAuthTokens): CodexProvisioningResult {
    return this.fromOAuthTokens(tokens, "browser-oauth");
  }

  fromDeviceTokens(tokens: CodexOAuthTokens): CodexProvisioningResult {
    return this.fromOAuthTokens(tokens, "device-code");
  }

  fromCliAuth(raw: unknown): CodexProvisioningResult {
    try {
      const parsed = parseAndValidateCodexAuth(raw);
      const email = parsed.email ?? parsed.userId ?? parsed.accountId;
      const publicMetadata: PublicMetadata = { workspaceId: parsed.accountId };
      if (parsed.userId) publicMetadata.userId = parsed.userId;
      return {
        authMethod: "cli-import",
        stableIdentity: buildStableIdentity(parsed.accountId, parsed.userId, email),
        displayName: email,
        maskedIdentifier: maskIdentifier(email),
        publicMetadata,
        credentials: {
          version: 1,
          provider: "codex",
          authMethod: "cli-import",
          expiresAt: parsed.expiresAt,
          secrets: {
            accessToken: parsed.accessToken,
            refreshToken: parsed.refreshToken,
            idToken: parsed.idToken,
          },
        },
      };
    } catch (error) {
      throw new AppError("validation", "Codex CLI authorization data is invalid", false, {
        cause: error,
      });
    }
  }

  async refreshCredentials(
    account: Account,
    envelope: CredentialEnvelope,
    force = false,
  ): Promise<CredentialRefreshResult> {
    const expiry = envelope.expiresAt ? Date.parse(envelope.expiresAt) : Number.NaN;
    const lead = getRefreshLeadMs("codex", account.publicMetadata);
    if (!force && Number.isFinite(expiry) && expiry - this.clock.now().getTime() > lead) {
      return { envelope, changed: false };
    }
    const refreshToken = envelope.secrets.refreshToken;
    if (!refreshToken) {
      throw new AppError("authentication", "Codex refresh token is missing");
    }
    const result = await refreshCodexToken(refreshToken, {}, this.fetchImpl);
    if (!result) throw new AppError("network", "Codex token refresh failed", true);
    if ("error" in result) {
      throw new AppError("authentication", "Codex authorization must be renewed");
    }
    const expiresAt =
      result.expiresIn === undefined
        ? envelope.expiresAt
        : new Date(this.clock.now().getTime() + result.expiresIn * 1000).toISOString();
    return {
      changed:
        result.refreshToken !== refreshToken ||
        result.accessToken !== undefined ||
        expiresAt !== envelope.expiresAt,
      envelope: {
        ...envelope,
        expiresAt,
        secrets: {
          ...envelope.secrets,
          accessToken: result.accessToken ?? envelope.secrets.accessToken,
          refreshToken: result.refreshToken,
        },
      },
    };
  }

  async fetchUsage(account: Account, envelope: CredentialEnvelope): Promise<UsageSnapshot> {
    const result = await getCodexUsage(
      envelope.secrets.accessToken,
      { workspaceId: account.publicMetadata.workspaceId },
      this.fetchImpl,
    );
    if ("message" in result) {
      const message = typeof result.message === "string" ? result.message : "";
      const authentication = /expired|access denied|re-authenticate/i.test(message);
      throw new AppError(
        authentication ? "authentication" : "upstream",
        authentication ? "Codex authorization is no longer valid" : "Codex usage request failed",
        !authentication,
      );
    }
    const quotas = normalizeQuotas(result.quotas);
    return {
      accountId: account.id,
      plan: result.plan,
      overallRemainingPercentage: quotas[0]?.remainingPercentage ?? null,
      groups: [{ key: "default", displayName: null, quotas }],
      extras:
        typeof result.bankedResetCredits === "number"
          ? [
              {
                key: "reset-credits",
                value: String(result.bankedResetCredits),
              },
            ]
          : [],
      fetchedAt: this.clock.now().toISOString(),
    };
  }

  private fromOAuthTokens(
    tokens: CodexOAuthTokens,
    authMethod: "browser-oauth" | "device-code",
  ): CodexProvisioningResult {
    const mapped = codex.mapTokens(tokens);
    if (!mapped.accessToken) throw new AppError("validation", "Codex access token is missing");
    const metadata = mapped.providerSpecificData as JsonRecord;
    const workspaceId = stringValue(metadata.workspaceId);
    const userId = stringValue(metadata.chatgptUserId);
    const email = mapped.email ?? userId ?? workspaceId ?? "Codex account";
    const publicMetadata: PublicMetadata = {};
    if (workspaceId) publicMetadata.workspaceId = workspaceId;
    const planType = stringValue(metadata.workspacePlanType);
    if (planType) publicMetadata.planType = planType;
    if (userId) publicMetadata.userId = userId;
    return {
      authMethod,
      stableIdentity: buildStableIdentity(workspaceId, userId, email),
      displayName: email,
      maskedIdentifier: maskIdentifier(email),
      publicMetadata,
      credentials: {
        version: 1,
        provider: "codex",
        authMethod,
        expiresAt:
          mapped.expiresIn === undefined
            ? null
            : new Date(this.clock.now().getTime() + mapped.expiresIn * 1000).toISOString(),
        secrets: {
          accessToken: mapped.accessToken,
          ...(mapped.refreshToken ? { refreshToken: mapped.refreshToken } : {}),
          ...(mapped.idToken ? { idToken: mapped.idToken } : {}),
        },
      },
    };
  }
}

export class CodexAccountProvisioner {
  constructor(
    private readonly storage: StoragePort,
    private readonly vault: CredentialVault,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async save(input: CodexProvisioningResult): Promise<Account> {
    const timestamp = this.now().toISOString();
    const existing = this.storage.accounts.findByStableIdentity("codex", input.stableIdentity);
    const account: Account = {
      id: existing?.id ?? this.createId(),
      provider: "codex",
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
