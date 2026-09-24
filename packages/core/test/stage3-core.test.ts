import { describe, expect, it } from "vitest";
import {
  AppError,
  CodexAccountProvisioner,
  CodexAdapter,
  CredentialVault,
  MemoryStorage,
  RefreshCoordinator,
  toPublicAccount,
  type Account,
  type CredentialCipherPort,
  type CredentialEnvelope,
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

function account(id: string, enabled = true): Account {
  return {
    id,
    provider: "codex",
    authMethod: "cli-import",
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

function envelope(accountId: string, suffix = "old"): CredentialEnvelope {
  return {
    version: 1,
    accountId,
    provider: "codex",
    authMethod: "cli-import",
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
      adapter,
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
