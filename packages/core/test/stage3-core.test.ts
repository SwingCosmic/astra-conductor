import { describe, expect, it, vi } from "vitest";
import {
  AppError,
  CodexAccountProvisioner,
  CodexAdapter,
  CredentialVault,
  MemoryStorage,
  ProviderRegistry,
  RefreshCoordinator,
  providerCatalog,
  toPublicAccount,
  toPublicUsage,
  type Account,
  type AuthMethod,
  type CredentialCipherPort,
  type CredentialEnvelope,
  type ProviderContribution,
} from "../src/internal.js";

const now = new Date("2026-09-24T00:00:00.000Z");

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

function idToken(email: string, workspace: string, user: string): string {
  return jwt({
    email,
    exp: Math.floor(now.getTime() / 1000) + 3600,
    "https://api.openai.com/auth": {
      chatgpt_account_id: workspace,
      chatgpt_user_id: user,
      chatgpt_plan_type: "plus",
    },
  });
}

class FakeCipher implements CredentialCipherPort {
  available = true;
  rotate = false;

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async encrypt(plaintext: string): Promise<Uint8Array> {
    return Buffer.from(`sealed:${Buffer.from(plaintext).toString("base64")}`);
  }

  async decrypt(ciphertext: Uint8Array): Promise<{ plaintext: string; shouldReEncrypt: boolean }> {
    const value = Buffer.from(ciphertext).toString();
    if (!value.startsWith("sealed:")) throw new Error("damaged ciphertext");
    return {
      plaintext: Buffer.from(value.slice(7), "base64").toString(),
      shouldReEncrypt: this.rotate,
    };
  }
}

function catalogDescriptor(provider: string): ProviderContribution["descriptor"] {
  const descriptor = providerCatalog.find((item) => item.provider === provider);
  if (!descriptor) throw new Error(`missing catalog descriptor: ${provider}`);
  return descriptor;
}

/** 用本地构造的 CodexAdapter 拼出一份与真实目录一致的 contribution。 */
function codexContribution(adapter: CodexAdapter): ProviderContribution {
  return {
    descriptor: catalogDescriptor("codex"),
    account: {
      providerId: "codex",
      supportedMethods: ["browser-oauth", "device-code", "cli-import"],
      startAuth: async () => {
        throw new Error("not used in this test");
      },
      refreshCredentials: (account, envelope, options) =>
        adapter.refreshCredentials(account, envelope, options.force),
    },
    usage: {
      providerId: "codex",
      fetchUsage: (account, envelope) => adapter.fetchUsage(account, envelope),
    },
  };
}

function account(id: string, enabled = true, authMethod: AuthMethod = "cli-import"): Account {
  return {
    id,
    provider: "codex",
    offeringId: "codex",
    authMethod,
    stableIdentity: `workspace:${id}`,
    displayName: `${id}@example.test`,
    maskedIdentifier: `${id.slice(0, 2)}***@example.test`,
    enabled,
    credentialState: "available",
    publicMetadata: { workspaceId: `workspace-${id}` },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function envelope(
  accountId: string,
  suffix = "old",
  authMethod: AuthMethod = "cli-import",
): CredentialEnvelope {
  return {
    version: 1,
    accountId,
    provider: "codex",
    authMethod,
    expiresAt: new Date(now.getTime() - 60_000).toISOString(),
    secrets: {
      accessToken: `access-${suffix}`,
      refreshToken: `refresh-${suffix}`,
      idToken: `id-${suffix}`,
    },
  };
}

describe("stage 3 core boundaries", () => {
  it("provisions every Codex credential source and deduplicates stable identities", async () => {
    const storage = new MemoryStorage();
    const cipher = new FakeCipher();
    const vault = new CredentialVault(storage, cipher, () => now);
    let sequence = 0;
    const provisioner = new CodexAccountProvisioner(
      storage,
      vault,
      () => now,
      () => `account-${++sequence}`,
    );
    const adapter = new CodexAdapter(fetch, { now: () => now });

    const browser = adapter.fromBrowserTokens({
      access_token: "browser-access",
      refresh_token: "browser-refresh",
      id_token: idToken("browser@example.test", "workspace-browser", "user-browser"),
      expires_in: 3600,
    });
    const browserAccount = await provisioner.save(browser);
    const repeated = await provisioner.save({
      ...browser,
      credentials: {
        ...browser.credentials,
        secrets: { ...browser.credentials.secrets, accessToken: "browser-access-new" },
      },
    });
    const deviceAccount = await provisioner.save(
      adapter.fromDeviceTokens({
        access_token: "device-access",
        refresh_token: "device-refresh",
        id_token: idToken("device@example.test", "workspace-device", "user-device"),
        expires_in: 3600,
      }),
    );
    const cliAccount = await provisioner.save(
      adapter.fromCliAuth({
        auth_mode: "chatgpt",
        tokens: {
          access_token: jwt({ exp: Math.floor(now.getTime() / 1000) + 3600 }),
          refresh_token: "cli-refresh",
          id_token: idToken("cli@example.test", "workspace-cli", "user-cli"),
          account_id: "workspace-cli",
        },
      }),
    );

    expect(repeated.id).toBe(browserAccount.id);
    expect(storage.accounts.list().map((item) => item.id)).toEqual([
      browserAccount.id,
      deviceAccount.id,
      cliAccount.id,
    ]);
    expect(
      Buffer.from(storage.credentials.get(browserAccount.id)!.ciphertext).toString(),
    ).not.toContain("browser-access-new");
    expect(JSON.stringify(toPublicAccount(browserAccount))).not.toMatch(
      /accessToken|refreshToken|idToken|apiKey|stableIdentity/,
    );
  });

  it("rejects unavailable, damaged, and cross-account credential data without deleting it", async () => {
    const storage = new MemoryStorage();
    const cipher = new FakeCipher();
    const vault = new CredentialVault(storage, cipher, () => now);
    const first = account("first");
    const second = account("second");
    storage.accounts.save(first);
    storage.accounts.save(second);
    await vault.save(first, envelope(first.id));
    await vault.save(second, envelope(second.id));
    const firstRecord = storage.credentials.get(first.id)!;
    const secondRecord = storage.credentials.get(second.id)!;

    storage.credentials.save({ ...secondRecord, ciphertext: firstRecord.ciphertext });
    await expect(vault.load(second.id)).rejects.toMatchObject({ code: "secure-storage" });
    expect(storage.credentials.get(second.id)).not.toBeNull();

    storage.credentials.save({ ...firstRecord, ciphertext: Buffer.from("damaged") });
    await expect(vault.load(first.id)).rejects.toMatchObject({ code: "secure-storage" });
    expect(Buffer.from(storage.credentials.get(first.id)!.ciphertext).toString()).toBe("damaged");

    cipher.available = false;
    await expect(vault.save(first, envelope(first.id, "replacement"))).rejects.toMatchObject({
      code: "secure-storage",
    });
    expect(Buffer.from(storage.credentials.get(first.id)!.ciphertext).toString()).toBe("damaged");
  });

  it("isolates refresh failures, persists rotated tokens first, and coalesces concurrency", async () => {
    const storage = new MemoryStorage();
    const cipher = new FakeCipher();
    const vault = new CredentialVault(storage, cipher, () => now);
    const first = account("first");
    const second = account("second");
    const disabled = account("disabled", false);
    for (const item of [first, second, disabled]) {
      storage.accounts.save(item);
      await vault.save(item, envelope(item.id, item.id));
    }

    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        const body = String(init?.body);
        const source = new URLSearchParams(body).get("refresh_token") ?? "";
        calls.push(`refresh:${source}`);
        return Response.json({
          access_token: source.replace("refresh", "access-new"),
          refresh_token: source.replace("refresh", "refresh-new"),
          expires_in: 3600,
        });
      }
      const authorization = new Headers(init?.headers).get("Authorization") ?? "";
      calls.push(`usage:${authorization}`);
      if (authorization.includes("second")) return new Response("failure", { status: 500 });
      return Response.json({
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 96,
            limit_window_seconds: 18_000,
            reset_after_seconds: 100,
          },
          secondary_window: {
            used_percent: 25,
            limit_window_seconds: 604_800,
            reset_after_seconds: 200,
          },
        },
      });
    };
    const adapter = new CodexAdapter(fetchImpl, { now: () => now });
    const logs: unknown[] = [];
    const coordinator = new RefreshCoordinator(
      storage,
      vault,
      new ProviderRegistry([codexContribution(adapter)]),
      { now: () => now },
      {
        info: (message, context) => logs.push({ message, context }),
        error: (message, context) => logs.push({ message, context }),
      },
    );

    const firstRun = coordinator.refresh(first.id);
    expect(coordinator.refresh(first.id)).toBe(firstRun);
    const [firstOutcome, secondOutcome, disabledOutcome] = await Promise.all([
      firstRun,
      coordinator.refresh(second.id),
      coordinator.refresh(disabled.id),
    ]);

    expect(firstOutcome.status).toBe("updated");
    if (firstOutcome.status === "updated") {
      expect(firstOutcome.notifications[0]?.level).toBe("critical");
    }
    expect(secondOutcome.status).toBe("failed");
    expect(disabledOutcome.status).toBe("skipped");
    expect(storage.snapshots.get(first.id)?.plan).toBe("plus");
    expect(storage.snapshots.get(second.id)).toBeNull();
    expect((await vault.load(second.id)).secrets.refreshToken).toContain("refresh-new-second");
    expect(calls.some((call) => call.includes("disabled"))).toBe(false);
    expect(JSON.stringify([firstOutcome, secondOutcome, logs])).not.toMatch(
      /access-new-first|refresh-new-first|access-new-second|refresh-new-second/,
    );
  });

  it("refreshes an expired OAuth token before requesting usage", async () => {
    const storage = new MemoryStorage();
    const cipher = new FakeCipher();
    const vault = new CredentialVault(storage, cipher, () => now);
    const oauthAccount = account("oauth-expired", true, "browser-oauth");
    storage.accounts.save(oauthAccount);
    await vault.save(oauthAccount, envelope(oauthAccount.id, "oauth-expired", "browser-oauth"));

    const calls: string[] = [];
    const adapter = new CodexAdapter(
      async (input, init) => {
        const url = String(input);
        if (url.includes("/oauth/token")) {
          calls.push("refresh");
          return Response.json({
            access_token: "access-oauth-new",
            refresh_token: "refresh-oauth-new",
            expires_in: 3600,
          });
        }
        calls.push(new Headers(init?.headers).get("Authorization") ?? "");
        return Response.json({
          plan_type: "plus",
          rate_limit: {
            primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
          },
        });
      },
      { now: () => now },
    );
    const coordinator = new RefreshCoordinator(
      storage,
      vault,
      new ProviderRegistry([codexContribution(adapter)]),
      { now: () => now },
    );

    await expect(coordinator.refresh(oauthAccount.id)).resolves.toMatchObject({
      status: "updated",
    });
    expect(calls).toEqual(["refresh", "Bearer access-oauth-new"]);
    expect((await vault.load(oauthAccount.id)).secrets.refreshToken).toBe("refresh-oauth-new");
  });

  it("recovers from an OAuth usage 401 by forcing one token refresh", async () => {
    const storage = new MemoryStorage();
    const cipher = new FakeCipher();
    const vault = new CredentialVault(storage, cipher, () => now);
    const oauthAccount = account("oauth-retry", true, "browser-oauth");
    const current = envelope(oauthAccount.id, "oauth-retry", "browser-oauth");
    current.expiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();
    storage.accounts.save(oauthAccount);
    await vault.save(oauthAccount, current);

    const calls: string[] = [];
    const adapter = new CodexAdapter(
      async (input, init) => {
        const url = String(input);
        if (url.includes("/oauth/token")) {
          calls.push("refresh");
          return Response.json({
            access_token: "access-retry-new",
            refresh_token: "refresh-retry-new",
            expires_in: 3600,
          });
        }
        const authorization = new Headers(init?.headers).get("Authorization") ?? "";
        calls.push(authorization);
        if (authorization === "Bearer access-oauth-retry") {
          return new Response("expired", { status: 401 });
        }
        return Response.json({
          plan_type: "plus",
          rate_limit: {
            primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
          },
        });
      },
      { now: () => now },
    );
    const coordinator = new RefreshCoordinator(
      storage,
      vault,
      new ProviderRegistry([codexContribution(adapter)]),
      { now: () => now },
    );

    await expect(coordinator.refresh(oauthAccount.id)).resolves.toMatchObject({
      status: "updated",
    });
    expect(calls).toEqual(["Bearer access-oauth-retry", "refresh", "Bearer access-retry-new"]);
  });

  it("forces and persists a manual OAuth credential refresh", async () => {
    const storage = new MemoryStorage();
    const cipher = new FakeCipher();
    const vault = new CredentialVault(storage, cipher, () => now);
    const oauthAccount = account("oauth-manual", true, "browser-oauth");
    const current = envelope(oauthAccount.id, "oauth-manual", "browser-oauth");
    current.expiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();
    storage.accounts.save(oauthAccount);
    await vault.save(oauthAccount, current);
    const fetchMock = vi.fn(async () =>
      Response.json({
        access_token: "access-manual-new",
        refresh_token: "refresh-manual-new",
        expires_in: 7200,
      }),
    );
    const adapter = new CodexAdapter(fetchMock, { now: () => now });
    const coordinator = new RefreshCoordinator(
      storage,
      vault,
      new ProviderRegistry([codexContribution(adapter)]),
      { now: () => now },
    );

    await expect(coordinator.refreshCredentials(oauthAccount.id)).resolves.toEqual({
      status: "updated",
      accountId: oauthAccount.id,
      tokenExpiresAt: new Date(now.getTime() + 120 * 60_000).toISOString(),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((await vault.load(oauthAccount.id)).secrets.refreshToken).toBe("refresh-manual-new");
  });

  it("uses duration-correct Codex window titles without duplicating labels", async () => {
    const adapter = new CodexAdapter(async () =>
      Response.json({
        plan_type: "pro",
        rate_limit: {
          primary_window: {
            used_percent: 10,
            limit_window_seconds: 604_800,
            reset_after_seconds: 100,
          },
          secondary_window: {
            used_percent: 20,
            limit_window_seconds: 18_000,
            reset_after_seconds: 100,
          },
        },
      }),
    );
    const result = await adapter.fetchUsage(account("labels"), envelope("labels"));
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ key: "default", displayName: null });
    expect(result.groups[0]?.quotas).toMatchObject([
      { key: "session", displayName: "Weekly", windowSeconds: 604_800 },
      { key: "weekly", displayName: "Session", windowSeconds: 18_000 },
    ]);
  });

  it("dispatches refresh through the registered provider facets", async () => {
    const storage = new MemoryStorage();
    const cipher = new FakeCipher();
    const vault = new CredentialVault(storage, cipher, () => now);
    const glmAccount: Account = {
      ...account("glm-account"),
      provider: "glm",
      offeringId: "bigmodel-coding-plan",
      authMethod: "api-key",
    };
    const glmEnvelope: CredentialEnvelope = {
      ...envelope(glmAccount.id),
      provider: "glm",
      authMethod: "api-key",
      secrets: { apiKey: "glm-key" },
    };
    storage.accounts.save(glmAccount);
    await vault.save(glmAccount, glmEnvelope);
    const calls: string[] = [];
    const coordinator = new RefreshCoordinator(
      storage,
      vault,
      new ProviderRegistry([
        {
          descriptor: catalogDescriptor("glm"),
          account: {
            providerId: "glm",
            supportedMethods: ["cli-import", "api-key"],
            startAuth: async () => {
              throw new Error("not used in this test");
            },
            refreshCredentials: async (_account, current) => {
              calls.push("credentials");
              return { envelope: current, changed: false };
            },
          },
          usage: {
            providerId: "glm",
            fetchUsage: async (current) => {
              calls.push("usage");
              return {
                accountId: current.id,
                plan: "pro",
                overallRemainingPercentage: 80,
                groups: [],
                extras: [],
                resetCredits: null,
                fetchedAt: now.toISOString(),
              };
            },
          },
        },
      ]),
      { now: () => now },
    );

    await expect(coordinator.refresh(glmAccount.id)).resolves.toMatchObject({ status: "updated" });
    expect(calls).toEqual(["credentials", "usage"]);
  });

  it("upgrades stored flat quota snapshots at the public boundary", () => {
    const legacy = {
      accountId: "legacy",
      plan: "plus",
      quotas: [],
      resetCredits: 2,
      fetchedAt: now.toISOString(),
    } as unknown as Parameters<typeof toPublicUsage>[0];
    expect(toPublicUsage(legacy)).toMatchObject({
      overallRemainingPercentage: null,
      groups: [{ key: "default", displayName: null, quotas: [] }],
      extras: [{ key: "reset-credits", value: "2" }],
    });
  });

  it("projects pre-upgrade itemized reset-credit extras without adaptation", () => {
    const legacy = {
      accountId: "legacy",
      plan: "plus",
      overallRemainingPercentage: 80,
      groups: [],
      extras: [
        {
          key: "reset-credits",
          value: "2",
          items: [
            { key: "weekly:0", kind: "weekly", expiresAt: null, actionToken: "c-1" },
            { key: "five-hour:1", kind: "five-hour", expiresAt: null, actionToken: "c-2" },
          ],
        },
      ],
      fetchedAt: now.toISOString(),
    } as unknown as Parameters<typeof toPublicUsage>[0];
    // 破坏性结构更新：旧形态不做折算，resetCredits 为 null；旧结构由桌面端
    // 检测后触发刷新换取新数据，而不是在投影层适配。
    expect(toPublicUsage(legacy)).toMatchObject({
      resetCredits: null,
      extras: [
        {
          key: "reset-credits",
          value: "2",
          items: [
            { key: "weekly:0", kind: "weekly", expiresAt: null },
            { key: "five-hour:1", kind: "five-hour", expiresAt: null },
          ],
        },
      ],
    });
  });

  it("rolls back in-memory transactions", () => {
    const storage = new MemoryStorage();
    expect(() =>
      storage.transaction(() => {
        storage.accounts.save(account("rolled-back"));
        throw new AppError("storage", "rollback");
      }),
    ).toThrow("rollback");
    expect(storage.accounts.get("rolled-back")).toBeNull();
  });
});
