import { describe, expect, it, vi } from "vitest";
import {
  BrokerError,
  type BrokerCredential,
  type BrokerOperation,
  type CredentialFilter,
  type CredentialPatch,
} from "@astra-conductor/credentials";
import {
  AppError,
  MemoryStorage,
  ProviderRegistry,
  RefreshCoordinator,
  SharedCredentialService,
  SwitchingCredentialService,
  decodeSharedCredential,
  encodeSharedCredential,
  providerCatalog,
  sharedCredentialContentType,
  type Account,
  type CredentialEnvelope,
  type CredentialService,
  type UsageSnapshot,
} from "../src/internal.js";

const now = "2026-11-06T00:00:00.000Z";
const account: Account = {
  id: "shared-account",
  provider: "codex",
  offeringId: "codex",
  authMethod: "cli-import",
  stableIdentity: "workspace:test",
  displayName: "Test",
  maskedIdentifier: "t***",
  enabled: true,
  credentialState: "available",
  publicMetadata: { workspaceId: "workspace-test" },
  createdAt: now,
  updatedAt: now,
};
const credential = (version: string): CredentialEnvelope => ({
  version: 1,
  accountId: account.id,
  provider: "codex",
  authMethod: "cli-import",
  expiresAt: null,
  secrets: { accessToken: `access-${version}`, refreshToken: `refresh-${version}` },
});
const record = (version = "C1"): BrokerCredential => ({
  description: {
    credentialId: account.id,
    revision: "1",
    createdByClientId: "polyquota",
    lastUpdatedByClientId: "polyquota",
    contentType: sharedCredentialContentType,
    payloadFormatVersion: 1,
    metadata: {
      provider: "codex",
      offeringId: "codex",
      authMethod: "cli-import",
      supportsUsage: "true",
      extension: "preserved",
    },
  },
  payload: encodeSharedCredential(account, credential(version)),
});
const operation: BrokerOperation = {
  operationId: "operation",
  credentialId: account.id,
  clientId: "client",
  instanceId: "instance",
  status: "committed",
  leaseId: "lease",
  fence: "1",
  generation: "generation",
  baseRevision: "1",
  grantedAt: 1,
  expiresAt: 30_001,
  hardDeadline: 120_001,
  resultRevision: "2",
  requestHash: null,
  failureCode: null,
  retryable: null,
  upstreamOutcome: null,
};

class FakeBroker {
  value = record();
  leased = false;
  updates = 0;
  reads = 0;
  tail: Promise<void> = Promise.resolve();
  listCredentials = vi.fn(async (filter?: CredentialFilter) =>
    Object.entries(filter?.metadataEquals ?? {}).every(
      ([key, value]) => this.value.description.metadata[key] === value,
    )
      ? [structuredClone(this.value.description)]
      : [],
  );
  async getCredential(_id: string): Promise<BrokerCredential> {
    this.reads++;
    return structuredClone(this.value);
  }
  update<T>(
    _id: string,
    revision: string | undefined,
    callback: (
      value: BrokerCredential,
      context: { signal: AbortSignal; operationId: string },
    ) => Promise<{ value: T; commit?: CredentialPatch }>,
  ): Promise<{ value: T; operation: BrokerOperation }> {
    const run = this.tail.then(async () => {
      if (revision !== undefined && revision !== this.value.description.revision)
        throw new BrokerError("stale-revision");
      this.leased = true;
      this.updates++;
      try {
        const response = await callback(structuredClone(this.value), {
          signal: new AbortController().signal,
          operationId: "operation",
        });
        if (response.commit) {
          if (response.commit.payload) this.value.payload = response.commit.payload;
          this.value.description.revision = String(Number(this.value.description.revision) + 1);
        }
        return { value: response.value, operation };
      } finally {
        this.leased = false;
      }
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function providers(
  refresh: (
    envelope: CredentialEnvelope,
    force: boolean,
  ) => Promise<{ envelope: CredentialEnvelope; changed: boolean }>,
  usage?: (envelope: CredentialEnvelope) => Promise<UsageSnapshot>,
): ProviderRegistry {
  return new ProviderRegistry([
    {
      descriptor: providerCatalog.find((item) => item.provider === "codex")!,
      account: {
        providerId: "codex",
        supportedMethods: ["browser-oauth", "device-code", "cli-import"],
        startAuth: async () => {
          throw new Error("not used");
        },
        refreshCredentials: (_account, envelope, options) => refresh(envelope, options.force),
      },
      usage: {
        providerId: "codex",
        fetchUsage: (_account, envelope) =>
          usage ? usage(envelope) : Promise.reject(new Error("not used")),
      },
    },
  ]);
}

describe("shared credential backend", () => {
  it("never persists tokens, serializes concurrent C1 refreshes and reads C3 without a cache", async () => {
    const broker = new FakeBroker();
    const storage = new MemoryStorage();
    storage.accounts.save(account);
    const first = new SharedCredentialService(broker, { storage });
    const second = new SharedCredentialService(broker);
    const refresh = vi.fn(async (current: CredentialEnvelope) => {
      expect(broker.leased).toBe(true);
      expect(broker.reads).toBe(0);
      expect(current.secrets.accessToken).toBe("access-C1");
      return { envelope: credential("C2"), changed: true };
    });
    const results = await Promise.all([
      first.refreshById(account.id, refresh),
      second.refresh(account, refresh),
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.envelope.secrets.accessToken)).toEqual([
      "access-C2",
      "access-C2",
    ]);
    expect(storage.credentials.get(account.id)).toBeNull();
    expect(broker.value.description.metadata.extension).toBe("preserved");
    await first.refresh(account, async () => ({ envelope: credential("C3"), changed: true }));
    expect((await second.load(account.id)).secrets.accessToken).toBe("access-C3");
  });

  it("checks usage declarations and local providers before requesting any payload", async () => {
    const broker = new FakeBroker();
    const registry = providers(async (envelope) => ({ envelope, changed: false }));
    const shared = new SharedCredentialService(broker, { providers: registry, usageOnly: true });
    for (const value of ["false", "TRUE", " true ", ""]) {
      broker.value.description.metadata.supportsUsage = value;
      expect(await shared.listAccounts()).toEqual([]);
      await expect(shared.load(account.id)).rejects.toThrow("credential-not-available");
    }
    broker.value.description.metadata.supportsUsage = "true";
    broker.value.description.metadata.provider = "unknown-provider";
    expect(await shared.listAccounts()).toEqual([]);
    expect(broker.reads).toBe(0);
    expect(broker.listCredentials).toHaveBeenCalledWith({
      metadataEquals: { supportsUsage: "true" },
    });
  });

  it("validates payload identities and projects only recognized non-secret account metadata", () => {
    const value = record();
    const payload = JSON.parse(Buffer.from(value.payload, "base64url").toString()) as {
      account: Account;
    };
    payload.account.publicMetadata = {
      workspaceId: "public",
      accessToken: "never-expose",
      custom: "unknown",
    };
    value.payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    expect(decodeSharedCredential(value).account.publicMetadata).toEqual({ workspaceId: "public" });
    payload.account.publicMetadata.workspaceId = "access-C1";
    value.payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    expect(() => decodeSharedCredential(value)).toThrow("secret-in-account-metadata");
    value.description.credentialId = "different-account";
    expect(() => decodeSharedCredential(value)).toThrow("credential-ownership-mismatch");
  });

  it("rejects direct provider writes outside a refresh permit", async () => {
    const broker = new FakeBroker();
    const shared = new SharedCredentialService(broker);
    await expect(shared.saveAccount(account, credential("C2"))).rejects.toThrow("共享模式");
    expect(broker.updates).toBe(0);
  });

  it("runs both automatic and authentication-retry refreshes inside the shared permit", async () => {
    const broker = new FakeBroker();
    const storage = new MemoryStorage();
    storage.accounts.save(account);
    const calls: boolean[] = [];
    const registry = providers(
      async (current, force) => {
        expect(broker.leased).toBe(true);
        calls.push(force);
        return { envelope: force ? credential("C2") : current, changed: force };
      },
      async (current) => {
        expect(broker.leased).toBe(false);
        if (current.secrets.accessToken === "access-C1")
          throw new AppError("authentication", "Expired");
        return {
          accountId: account.id,
          plan: "plus",
          overallRemainingPercentage: null,
          groups: [],
          extras: [],
          resetCredits: null,
          fetchedAt: now,
        };
      },
    );
    const shared = new SharedCredentialService(broker, {
      providers: registry,
      storage,
      usageOnly: true,
    });
    const coordinator = new RefreshCoordinator(storage, shared, registry);
    await expect(coordinator.refresh(account.id)).resolves.toMatchObject({ status: "updated" });
    expect(calls).toEqual([false, true]);
    expect(broker.updates).toBe(2);
    expect(storage.credentials.get(account.id)).toBeNull();
  });

  it("does not commit a provider failure and permits the following retry", async () => {
    const broker = new FakeBroker();
    const shared = new SharedCredentialService(broker);
    await expect(
      shared.refresh(account, async () => {
        throw new AppError("network", "offline");
      }),
    ).rejects.toThrow("offline");
    expect(broker.value.description.revision).toBe("1");
    await shared.refresh(account, async () => ({ envelope: credential("C2"), changed: true }));
    expect(broker.value.description.revision).toBe("2");
  });

  it("switches a stable provider dependency back to an independent private backend", async () => {
    const save = vi.fn(async () => undefined);
    const privateService: CredentialService = {
      load: async () => credential("private"),
      save,
      saveAccount: save,
    };
    const switching = new SwitchingCredentialService(privateService);
    const broker = new FakeBroker();
    switching.useShared(new SharedCredentialService(broker));
    expect(switching.isShared).toBe(true);
    expect((await switching.load(account.id)).secrets.accessToken).toBe("access-C1");
    switching.usePrivate();
    await switching.refresh(account, async () => ({
      envelope: credential("private2"),
      changed: true,
    }));
    expect(save).toHaveBeenCalledOnce();
    expect(broker.value.description.revision).toBe("1");
    switching.useUnavailable();
    await expect(switching.load(account.id)).rejects.toThrow("共享凭据暂不可用");
    await expect(
      switching.refresh(account, async () => ({ envelope: credential("unused"), changed: true })),
    ).rejects.toThrow("共享凭据暂不可用");
    expect(save).toHaveBeenCalledOnce();
  });
});
