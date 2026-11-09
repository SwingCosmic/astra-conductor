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
  sharedCredentialMetadata,
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
  createCredential = vi.fn(async () => this.value);
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
          Object.assign(this.value.description.metadata, response.commit.setMetadata);
          this.value.description.revision = String(Number(this.value.description.revision) + 1);
        }
        return {
          value: response.value,
          operation: {
            ...operation,
            resultRevision: response.commit ? this.value.description.revision : null,
          },
        };
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
  canUseCurrentCredentials?: (account: Account, envelope: CredentialEnvelope) => boolean,
): ProviderRegistry {
  return new ProviderRegistry([
    {
      descriptor: providerCatalog.find((item) => item.provider === "codex")!,
      account: {
        providerId: "codex",
        canUseCurrentCredentials,
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
  it("never persists tokens, serializes concurrent refreshes and invalidates the other client on C3", async () => {
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
    second.invalidate(account.id, broker.value.description.revision);
    expect((await second.load(account.id)).secrets.accessToken).toBe("access-C3");
  });

  it("coalesces cold reads per account, keeps cached envelopes private and rereads near expiry", async () => {
    const broker = new FakeBroker();
    let clock = Date.parse(now);
    const expiresAt = new Date(clock + 600_000).toISOString();
    broker.value.payload = encodeSharedCredential(account, { ...credential("C1"), expiresAt });
    const shared = new SharedCredentialService(broker, { now: () => new Date(clock) });
    expect(shared.knownExpiry(account.id)).toBeUndefined();
    const [first, second] = await Promise.all([shared.load(account.id), shared.load(account.id)]);
    expect(broker.reads).toBe(1);
    expect(broker.listCredentials).toHaveBeenCalledTimes(1);
    first.secrets.accessToken = "different";
    expect(second.secrets.accessToken).toBe("access-C1");
    expect((await shared.load(account.id)).secrets.accessToken).toBe("access-C1");
    shared.invalidate(account.id, "1");
    expect(shared.knownExpiry(account.id)).toBe(expiresAt);
    clock += 300_000;
    broker.value.payload = encodeSharedCredential(account, credential("C2"));
    expect((await shared.load(account.id)).secrets.accessToken).toBe("access-C2");
    clock += 90 * 86_400_000;
    expect((await shared.load(account.id)).secrets.accessToken).toBe("access-C2");
    expect(broker.reads).toBe(2);
    expect(broker.listCredentials).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect a payload arriving after revocation or disposal", async () => {
    const broker = new FakeBroker();
    const shared = new SharedCredentialService(broker);
    let release!: (value: BrokerCredential) => void;
    const pending = new Promise<BrokerCredential>((resolve) => {
      release = resolve;
    });
    const read = vi.spyOn(broker, "getCredential").mockImplementationOnce(() => pending);
    const started = shared.load(account.id);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    shared.invalidate(account.id);
    broker.listCredentials.mockResolvedValue([]);
    release(record());
    await expect(started).rejects.toThrow("stale-revision");
    await expect(shared.load(account.id)).rejects.toThrow("credential-not-available");
    expect(shared.knownExpiry(account.id)).toBeUndefined();
    shared.dispose();
    await expect(shared.load(account.id)).rejects.toThrow("client-closed");
    expect(read).toHaveBeenCalledOnce();
  });

  it("reuses revision-verified public projections at startup and fetches only a changed projection", async () => {
    const broker = new FakeBroker();
    const registry = providers(async (envelope) => ({ envelope, changed: false }));
    const storage = new MemoryStorage();
    const options = { storage, providers: registry, persistProjectionRevisions: true };
    const first = new SharedCredentialService(broker, options);
    const [legacy] = await first.listAccounts();
    storage.accounts.save(legacy!);
    expect(broker.reads).toBe(1);
    expect(storage.credentials.get(account.id)).toBeNull();
    first.dispose();
    const shared = new SharedCredentialService(broker, options);
    expect((await shared.listAccounts())[0]).toEqual(account);
    expect(broker.reads).toBe(1);
    await shared.load(account.id);
    expect(broker.reads).toBe(2);
    broker.value.description.revision = "2";
    broker.value.description.metadata = sharedCredentialMetadata(account, registry, "2");
    broker.value.payload = encodeSharedCredential(account, credential("C2"));
    shared.invalidate(account.id, "2");
    await shared.listAccounts();
    expect(broker.reads).toBe(2);
    expect((await shared.load(account.id)).secrets.accessToken).toBe("access-C2");
    const renamed = { ...account, displayName: "Renamed account" };
    broker.value.description.revision = "3";
    broker.value.description.metadata = sharedCredentialMetadata(renamed, registry, "3");
    broker.value.payload = encodeSharedCredential(renamed, credential("C3"));
    expect((await shared.listAccounts())[0]?.displayName).toBe(renamed.displayName);
    expect(broker.reads).toBe(4);
    // An older writer preserves unknown metadata while replacing the account in its payload.
    broker.value.description.revision = "4";
    broker.value.payload = encodeSharedCredential(account, credential("C4"));
    expect((await shared.listAccounts())[0]?.displayName).toBe(account.displayName);
    expect(broker.reads).toBe(5);
    expect(
      JSON.stringify(storage.settings.get("credentialSharing.accountProjections.v1")),
    ).not.toContain("access-C");
  });

  it("keeps a newer broker read when a committed lease response arrives late", async () => {
    const broker = new FakeBroker();
    broker.value.payload = encodeSharedCredential(account, { ...credential("C1"), expiresAt: now });
    let committed!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    const shared = new SharedCredentialService(
      {
        listCredentials: broker.listCredentials,
        getCredential: (id) => broker.getCredential(id),
        createCredential: broker.createCredential,
        update: async (id, revision, run, _options) => {
          const result = await broker.update(id, revision, run);
          committed();
          await response;
          return result;
        },
      },
      { now: () => new Date(now) },
    );
    await shared.load(account.id);
    const updating = shared.refreshById(account.id, async () => ({
      envelope: credential("C2"),
      changed: true,
    }));
    await ready;
    broker.value.description.revision = "3";
    broker.value.payload = encodeSharedCredential(account, credential("C3"));
    expect((await shared.load(account.id)).secrets.accessToken).toBe("access-C3");
    release();
    expect((await updating).envelope.secrets.accessToken).toBe("access-C3");
    shared.invalidate(account.id, "3");
    expect(shared.recordRevision(account.id)).toBe("3");
    expect((await shared.load(account.id)).secrets.accessToken).toBe("access-C3");
    expect(broker.reads).toBe(2);
  });

  it("never starts the provider when the session is lost while waiting for a lease", async () => {
    const broker = new FakeBroker();
    let release!: () => void;
    broker.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const update = vi.spyOn(broker, "update");
    const shared = new SharedCredentialService(broker);
    const operation = vi.fn(async () => ({ envelope: credential("C2"), changed: true }));
    const queued = shared.refreshById(account.id, operation);
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    shared.clearCache();
    release();
    await expect(queued).rejects.toThrow("client-closed");
    expect(operation).not.toHaveBeenCalled();
    expect(broker.value.description.revision).toBe("1");
  });

  it("rotates legacy records when their broker metadata has no room for the projection stamp", async () => {
    const broker = new FakeBroker();
    for (let i = Object.keys(broker.value.description.metadata).length; i < 64; i++)
      broker.value.description.metadata["extension" + i] = "value";
    const shared = new SharedCredentialService(broker);
    await shared.refreshById(account.id, async () => ({
      envelope: credential("C2"),
      changed: true,
    }));
    expect(broker.value.description.revision).toBe("2");
    expect(broker.value.description.metadata).not.toHaveProperty("accountProjectionHash");
    expect(Object.keys(broker.value.description.metadata)).toHaveLength(64);
  });

  it("invalidates a single account while leaving the sibling envelope hot", async () => {
    const broker = new FakeBroker();
    const sibling = { ...account, id: "sibling" };
    const other = {
      ...broker.value,
      description: { ...broker.value.description, credentialId: sibling.id },
      payload: encodeSharedCredential(sibling, { ...credential("sibling"), accountId: sibling.id }),
    };
    broker.listCredentials.mockImplementation(async () => [
      broker.value.description,
      other.description,
    ]);
    const read = vi
      .spyOn(broker, "getCredential")
      .mockImplementation(async (id) => structuredClone(id === account.id ? broker.value : other));
    const shared = new SharedCredentialService(broker);
    await Promise.all([shared.load(account.id), shared.load(sibling.id)]);
    broker.value.description.revision = "2";
    broker.value.payload = encodeSharedCredential(account, credential("C2"));
    shared.invalidate(account.id, "2");
    await shared.load(sibling.id);
    expect((await shared.load(account.id)).secrets.accessToken).toBe("access-C2");
    expect(read.mock.calls.map(([id]) => id)).toEqual([account.id, sibling.id, account.id]);
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

  it("replaces a shared credential inside a record lease", async () => {
    const broker = new FakeBroker();
    const shared = new SharedCredentialService(broker);
    await shared.saveAccount(account, credential("C2"));
    expect(broker.updates).toBe(1);
    expect((await shared.load(account.id)).secrets.accessToken).toBe("access-C2");
  });

  it("rejects a newly allocated ID for the same legacy provider identity before a second create", async () => {
    const broker = new FakeBroker();
    const shared = new SharedCredentialService(broker);
    const duplicate = { ...account, id: "new-local-id" };
    await expect(
      shared.saveAccount(duplicate, { ...credential("C2"), accountId: duplicate.id }),
    ).rejects.toThrow("credential-identity-exists");
    expect(broker.createCredential).not.toHaveBeenCalled();
    expect(broker.updates).toBe(0);
  });

  it("checks the broker revision for deletion even when local settings timestamps change", async () => {
    const broker = new FakeBroker();
    const shared = new SharedCredentialService(broker);
    await shared.listAccounts();
    expect(shared.recordRevision(account.id)).toBe("1");
    await expect(shared.removeShared(account.id, "0")).rejects.toThrow("账号记录已变更");
    expect(broker.updates).toBe(0);
    await shared.removeShared(account.id, "1");
    expect(broker.updates).toBe(1);
    expect(shared.recordRevision(account.id)).toBeUndefined();
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

  it("serves repeated usage from memory and leases only a forced or authentication retry refresh", async () => {
    const broker = new FakeBroker();
    const storage = new MemoryStorage();
    storage.accounts.save(account);
    let unauthorized = false;
    const refresh = vi.fn(async (_envelope: CredentialEnvelope, force: boolean) => {
      expect(force && broker.leased).toBe(true);
      return { envelope: credential("refreshed"), changed: true };
    });
    const registry = providers(
      refresh,
      async (envelope) => {
        if (unauthorized && envelope.secrets.accessToken === "access-C1")
          throw new AppError("authentication", "expired");
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
      () => true,
    );
    const shared = new SharedCredentialService(broker, { providers: registry, storage });
    const credentials = new SwitchingCredentialService(shared);
    credentials.useShared(shared);
    const coordinator = new RefreshCoordinator(storage, credentials, registry);
    for (let i = 0; i < 2; i++)
      await expect(coordinator.refresh(account.id)).resolves.toMatchObject({ status: "updated" });
    expect(broker.reads).toBe(1);
    expect(broker.updates).toBe(0);
    expect(broker.listCredentials).toHaveBeenCalledOnce();
    unauthorized = true;
    await expect(coordinator.refresh(account.id)).resolves.toMatchObject({ status: "updated" });
    await expect(coordinator.refreshCredentials(account.id)).resolves.toMatchObject({
      status: "updated",
    });
    expect(broker.updates).toBe(2);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(broker.reads).toBe(2);
    expect(broker.listCredentials).toHaveBeenCalledOnce();
  });

  it("honors sequential manual rotations before event delivery and coalesces concurrent requests", async () => {
    const broker = new FakeBroker();
    const rotated: string[] = [];
    function client() {
      const storage = new MemoryStorage();
      storage.accounts.save(account);
      const registry = providers(async (current, force) => {
        expect(force && broker.leased).toBe(true);
        rotated.push(current.secrets.accessToken!);
        return { envelope: credential("C" + (rotated.length + 1)), changed: true };
      });
      const shared = new SharedCredentialService(broker, { storage, providers: registry });
      const vault = new SwitchingCredentialService(shared);
      vault.useShared(shared);
      return { shared, coordinator: new RefreshCoordinator(storage, vault, registry) };
    }
    const a = client();
    const b = client();
    await Promise.all([a.shared.load(account.id), b.shared.load(account.id)]);
    expect((await a.coordinator.refreshCredentials(account.id)).status).toBe("updated");
    expect((await b.coordinator.refreshCredentials(account.id)).status).toBe("updated");
    const pending = a.coordinator.refreshCredentials(account.id);
    expect(a.coordinator.refreshCredentials(account.id)).toBe(pending);
    const results = await Promise.all([pending, b.coordinator.refreshCredentials(account.id)]);
    expect(results.map((result) => result.status).sort()).toEqual(["unchanged", "updated"]);
    expect(rotated).toEqual(["access-C1", "access-C2", "access-C3"]);
  });

  it("does not try a lease or directory scan when the targeted manual baseline is forbidden", async () => {
    const broker = new FakeBroker();
    const shared = new SharedCredentialService(broker);
    await shared.load(account.id);
    broker.listCredentials.mockClear();
    vi.spyOn(broker, "getCredential").mockRejectedValue(new BrokerError("forbidden"));
    const operation = vi.fn();
    await expect(
      shared.refreshById(account.id, operation, { requestedByUser: true }),
    ).rejects.toThrow("forbidden");
    expect(broker.listCredentials).not.toHaveBeenCalled();
    expect(broker.updates).toBe(0);
    expect(operation).not.toHaveBeenCalled();
    expect(shared.recordRevision(account.id)).toBeUndefined();
  });

  it.each(["token rotation", "display name change"])(
    "recovers a usage 401 during a peer %s",
    async (change) => {
      const broker = new FakeBroker();
      const storage = new MemoryStorage();
      storage.accounts.save(account);
      const shared = new SharedCredentialService(broker, { storage });
      const refresh = vi.fn(async () => {
        expect(broker.leased).toBe(true);
        return { envelope: credential("C2"), changed: true };
      });
      const used: string[] = [];
      const registry = providers(
        refresh,
        async (envelope) => {
          used.push(envelope.secrets.accessToken!);
          if (used.length === 1) {
            broker.value.description.revision = "2";
            if (change === "token rotation") {
              broker.value.payload = encodeSharedCredential(account, credential("C2"));
              shared.invalidate(account.id, "2");
            } else {
              broker.value.payload = encodeSharedCredential(
                { ...account, displayName: "Renamed" },
                credential("C1"),
              );
            }
            throw new AppError("authentication", "rejected token");
          }
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
        () => true,
      );
      const coordinator = new RefreshCoordinator(storage, shared, registry);
      expect((await coordinator.refresh(account.id)).status).toBe("updated");
      expect(used).toEqual(["access-C1", "access-C2"]);
      const rotations = change === "token rotation" ? 0 : 1;
      expect(refresh).toHaveBeenCalledTimes(rotations);
      expect(broker.updates).toBe(rotations);
      expect(broker.listCredentials).toHaveBeenCalledTimes(change === "token rotation" ? 2 : 1);
    },
  );

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
