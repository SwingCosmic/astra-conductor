import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  AppError,
  AuthCoordinator,
  CommonProviderApplicationService,
  CredentialMutationGate,
  MemoryStorage,
  ProviderRegistry,
  providerCatalog,
  type Account,
  type CredentialService,
  type ProviderAccountCapability,
} from "../src/internal.js";
import {
  createProviderRoutes,
  createCredentialRoutes,
  installCommonMiddleware,
} from "../src/http/index.js";

const sessions: AuthCoordinator[] = [];
afterEach(async () => {
  await Promise.all(
    sessions.splice(0).map(async (auth) => {
      auth.cancelAll();
      await auth.drain();
    }),
  );
});

function fixture(
  refreshCredentials?: ProviderAccountCapability["refreshCredentials"],
  mutations?: CredentialMutationGate,
) {
  const storage = new MemoryStorage();
  const descriptor = providerCatalog.find((item) => item.provider === "glm")!;
  const account: Account = {
    id: "account-1",
    provider: "glm",
    offeringId: "zai-coding-plan",
    authMethod: "api-key",
    stableIdentity: "fixture",
    displayName: "Fixture",
    maskedIdentifier: "fi***re",
    enabled: true,
    credentialState: "available",
    publicMetadata: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const vault: CredentialService = {
    load: vi.fn(async () => {
      throw new Error("Snapshot must not decrypt credentials");
    }),
    save: vi.fn(),
    saveAccount: vi.fn(),
  };
  const registry = new ProviderRegistry([
    {
      descriptor: { ...descriptor, capabilities: ["account"] },
      account: {
        providerId: "glm",
        supportedMethods: ["cli-import", "api-key"],
        async startAuth() {
          storage.accounts.save(account);
          return { status: "completed", account };
        },
        ...(refreshCredentials ? { refreshCredentials } : {}),
      },
    },
  ]);
  const auth = new AuthCoordinator(registry);
  sessions.push(auth);
  let contextId = "backend-1";
  let writable = true;
  const service = new CommonProviderApplicationService({
    storage,
    credentials: vault,
    registry,
    auth,
    mutations,
    backend: () => ({
      contextId,
      selected: writable ? "private" : "shared",
      active: writable ? "private" : "unavailable",
    }),
    assertWritable() {
      if (!writable) throw new AppError("permission", "Readonly backend");
    },
  });
  const app = new Hono();
  installCommonMiddleware(app);
  const options = { assertContext: service.assertContext.bind(service) };
  app.route("/", createProviderRoutes(service, options));
  app.route(
    "/",
    createCredentialRoutes({ getStatus: async () => ({}), install: vi.fn() }, options),
  );
  const post = (path: string, body: object) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    service,
    app,
    post,
    vault,
    storage,
    account,
    switchBackend() {
      contextId = "backend-2";
      writable = false;
    },
  };
}

describe("common provider application and HTTP composition", () => {
  it("supports common account CRUD independently in each product and keeps list reads secret-free", async () => {
    const polyquota = fixture();
    const graphAgent = fixture();
    for (const product of [polyquota, graphAgent]) {
      const snapshot = await product.service.getSnapshot();
      const context = {
        instanceId: snapshot.stamp.instanceId,
        contextId: snapshot.backend.contextId,
      };
      const added = await product.post("/api/v1/auth/sessions/start", {
        ...context,
        offeringId: "zai-coding-plan",
        method: "api-key",
        apiKey: "fictional-secret",
      });
      expect(added.status).toBe(200);
      expect(await added.text()).not.toContain("fictional-secret");
      const list = await product.service.getSnapshot();
      expect(list.accounts).toHaveLength(1);
      expect(list.connections[0]?.actions.refreshCredentials).toEqual({ state: "hidden" });
      expect(product.vault.load).not.toHaveBeenCalled();
      expect(
        (
          await product.post("/api/v1/accounts/account-1/set-enabled", {
            ...context,
            enabled: false,
          })
        ).status,
      ).toBe(200);
      expect(product.storage.accounts.get("account-1")?.enabled).toBe(false);
    }
    const snapshot = await polyquota.service.getSnapshot();
    expect(
      (
        await polyquota.post("/api/v1/accounts/account-1/delete", {
          instanceId: snapshot.instanceId,
          contextId: snapshot.backend.contextId,
          expectedRecordRevision: snapshot.connections[0]!.recordRevision,
        })
      ).status,
    ).toBe(200);
    expect(polyquota.storage.accounts.list()).toHaveLength(0);
    expect(graphAgent.storage.accounts.list()).toHaveLength(1);
    expect((await graphAgent.app.request("/api/v1/polyquota/snapshot")).status).toBe(404);
  });

  it("rejects missing, other-instance and retired backend contexts without writes", async () => {
    const product = fixture();
    const snapshot = await product.service.getSnapshot();
    const path = "/api/v1/auth/sessions/start";
    const request = {
      offeringId: "zai-coding-plan",
      method: "api-key",
      apiKey: "fictional-secret",
    };
    expect((await product.post(path, request)).status).toBe(400);
    const otherInstance = await product.post(path, {
      ...request,
      instanceId: "other",
      contextId: snapshot.backend.contextId,
    });
    expect(otherInstance.status).toBe(409);
    expect(await otherInstance.json()).toMatchObject({ error: { code: "stale-context" } });
    product.switchBackend();
    expect(
      (
        await product.post(path, {
          ...request,
          instanceId: snapshot.instanceId,
          contextId: snapshot.backend.contextId,
        })
      ).status,
    ).toBe(409);
    expect(product.storage.accounts.list()).toHaveLength(0);
    const current = await product.service.getSnapshot();
    expect(current.actions.startAuth.state).toBe("disabled");
    expect(
      (
        await product.post(path, {
          ...request,
          instanceId: current.instanceId,
          contextId: current.backend.contextId,
        })
      ).status,
    ).toBe(403);
  });

  it("enforces backend capabilities behind the UI and never refreshes an unavailable backend", async () => {
    const product = fixture();
    product.storage.accounts.save(product.account);
    product.switchBackend();
    const snapshot = await product.service.getSnapshot();
    const context = { instanceId: snapshot.instanceId, contextId: snapshot.backend.contextId };
    for (const [path, request] of [
      ["/api/v1/accounts/account-1/set-enabled", { enabled: false }],
      ["/api/v1/accounts/account-1/refresh-credentials", {}],
    ] as const) {
      const response = await product.post(path, { ...context, ...request });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "service-unavailable" } });
    }
    expect(product.vault.load).not.toHaveBeenCalled();
    expect(product.storage.accounts.get("account-1")?.enabled).toBe(true);
    const unsupported = await product.post("/api/v1/credential-sharing/export", {
      ...context,
      vaultDirectory: "C:/fictional-shared",
    });
    expect(unsupported.status).toBe(409);
    expect(await unsupported.json()).toMatchObject({ error: { code: "capability-unavailable" } });
  });

  it("requires the deletion baseline and rejects a record changed after confirmation", async () => {
    const product = fixture();
    product.storage.accounts.save(product.account);
    const snapshot = await product.service.getSnapshot();
    const context = { instanceId: snapshot.instanceId, contextId: snapshot.backend.contextId };
    const revision = snapshot.connections[0]!.recordRevision;
    const endpoint = "/api/v1/accounts/account-1/delete";
    expect((await product.post(endpoint, context)).status).toBe(400);
    await product.service.setAccountEnabled("account-1", false);
    const stale = await product.post(endpoint, { ...context, expectedRecordRevision: revision });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "conflict" } });
    expect(product.storage.accounts.get("account-1")?.enabled).toBe(false);
    const current = await product.service.getSnapshot();
    expect(
      (
        await product.post(endpoint, {
          ...context,
          expectedRecordRevision: current.connections[0]!.recordRevision,
        })
      ).status,
    ).toBe(200);
    expect(product.storage.accounts.list()).toHaveLength(0);
  });

  it("publishes disabled mutations during an export freeze and rejects direct writes", async () => {
    const mutations = new CredentialMutationGate();
    const product = fixture(undefined, mutations);
    product.storage.accounts.save(product.account);
    await mutations.freeze();
    const snapshot = await product.service.getSnapshot();
    for (const action of ["startAuth", "deleteAccount", "setAccountEnabled", "refreshCredentials"])
      expect(snapshot.actions[action]?.state).toBe("disabled");
    const response = await product.post("/api/v1/accounts/account-1/set-enabled", {
      instanceId: snapshot.instanceId,
      contextId: snapshot.backend.contextId,
      enabled: false,
    });
    expect(response.status).toBe(409);
    expect(product.storage.accounts.get("account-1")?.enabled).toBe(true);
  });

  it("serializes enable and deletion with credential refresh so late saves cannot overwrite account edits", async () => {
    const releases: (() => void)[] = [];
    const product = fixture(async (_account, envelope) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { changed: true, envelope };
    });
    product.storage.accounts.save(product.account);
    product.vault.load = async () => ({
      version: 1,
      accountId: product.account.id,
      provider: "glm",
      authMethod: "api-key",
      expiresAt: null,
      secrets: { apiKey: "fictional-secret" },
    });
    product.vault.saveAccount = async (account) => {
      product.storage.accounts.save(account);
    };
    const refreshing = product.service.refreshCredentials("account-1");
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const disabling = product.service.setAccountEnabled("account-1", false);
    releases[0]!();
    await Promise.all([refreshing, disabling]);
    expect(product.storage.accounts.get("account-1")?.enabled).toBe(false);
    const refreshingAgain = product.service.refreshCredentials("account-1");
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const deleting = product.service.deleteAccount("account-1");
    releases[1]!();
    await Promise.all([refreshingAgain, deleting]);
    expect(product.storage.accounts.get("account-1")).toBeNull();
  });

  it("uses the same strict validation and null response for credential routes", async () => {
    const product = fixture();
    const snapshot = await product.service.getSnapshot();
    const context = { instanceId: snapshot.instanceId, contextId: snapshot.backend.contextId };
    const stale = await product.post("/api/v1/credential-sharing/install", {
      ...context,
      operationId: "retired-export",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "stale-context" } });
    const installed = await product.post("/api/v1/credential-sharing/install", context);
    expect(await installed.json()).toEqual({ ok: true, value: null });
    expect(
      (
        await product.post("/api/v1/credential-sharing/install", {
          ...context,
          secret: "unexpected",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await product.post("/api/v1/auth/sessions/start", {
          ...context,
          offeringId: "zai-coding-plan",
          method: "api-key",
          apiKey: "",
        })
      ).status,
    ).toBe(400);
    const response = await product.app.request("/api/v1/providers");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
