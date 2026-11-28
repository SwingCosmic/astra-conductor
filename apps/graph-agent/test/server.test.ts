import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { CredentialCipherPort } from "@astra-conductor/core/internal";
import { createGraphServices } from "../src/server/services.js";
import { readModelPackDirectory } from "../src/server/model-pack.js";
import type { GraphServicesOptions } from "../src/server/services.js";
import {
  BrokerError,
  type BrokerCredential,
  type InitialRecord,
} from "@astra-conductor/credentials";
import { createGraphHonoApp } from "../src/server/create-hono-app.js";
import { GraphBusinessDatabase } from "../src/platform/business-database.js";
import { startGraphServer } from "../src/platform/node/start-server.js";
import { claimGraphProfile } from "../src/platform/storage.js";
import { createGraphBrokerHost } from "../src/platform/broker-host.js";
import {
  testChatPath,
  type GraphModelSnapshot,
  type ModelEntryView,
  type PublicConnection,
  type TestChatRequest,
} from "@astra-conductor/contract/graph-agent";

const roots: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fictionalSecret = "fictional-stage-one-key-123456789";

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-provider-stage1-"));
  roots.push(directory);
  return directory;
}

function cipher(): CredentialCipherPort {
  const key = randomBytes(32);
  return {
    isAvailable: async () => true,
    encrypt: async (plaintext) => {
      const nonce = randomBytes(12);
      const operation = createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([
        nonce,
        operation.update(plaintext),
        operation.final(),
        operation.getAuthTag(),
      ]);
    },
    decrypt: async (ciphertext) => {
      const bytes = Buffer.from(ciphertext);
      const operation = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      operation.setAuthTag(bytes.subarray(-16));
      return {
        plaintext: Buffer.concat([
          operation.update(bytes.subarray(12, -16)),
          operation.final(),
        ]).toString(),
        shouldReEncrypt: false,
      };
    },
  };
}

async function fixture(
  directory: string,
  protection?: CredentialCipherPort,
  overrides: Partial<GraphServicesOptions> = {},
) {
  const upstream = vi.fn(async () =>
    Response.json({
      success: true,
      code: 200,
      data: { planName: "GLM Coding Pro Plan", limits: [] },
    }),
  );
  const services = await createGraphServices({
    directory,
    host: {
      localPackageDirectory: directory,
      inspect: async () => ({
        installState: "not-installed",
        installedVersion: null,
        installationDirectory: null,
      }),
      install: async () => undefined,
      uninstall: async () => undefined,
      connect: async () => {
        throw new Error("no broker configured");
      },
    },
    http: { fetch: upstream },
    cipher: protection,
    files: { readText: async () => "{}" },
    callbackServer: {
      start: async () => {
        throw new Error("not expected");
      },
    },
    authorization: { present: async () => "awaiting-user" },
    ...overrides,
  });
  cleanup.push(() => services.stop());
  const app = createGraphHonoApp(services);
  const snapshot = async () => (await (await app.request("/api/v1/providers")).json()).value;
  const command = async (route: string, body: Record<string, unknown> = {}) => {
    const current = await snapshot();
    const accountId = /^\/api\/v1\/accounts\/([^/]+)\/delete$/.exec(route)?.[1];
    const expectedRecordRevision = accountId
      ? current.connections.find(
          (connection: { accountId: string; recordRevision: string }) =>
            connection.accountId === accountId,
        )?.recordRevision
      : undefined;
    return app.request(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: current.instanceId,
        contextId: current.backend.contextId,
        ...(expectedRecordRevision ? { expectedRecordRevision } : {}),
        ...body,
      }),
    });
  };
  return { services, app, snapshot, command, upstream };
}

describe("GraphAgent common provider host", () => {
  it("restores an import as a writable private backend until an explicit, successful migration", async () => {
    const directory = await temporaryDirectory();
    const vault = await temporaryDirectory();
    const protection = cipher();
    const sharingDirectory = path.join(directory, "credential-sharing");
    await mkdir(sharingDirectory);
    const version = {
      vaultId: "vault",
      storageVersion: "version",
      attemptId: "attempt",
      keyId: "key",
    };
    const keyRef = "existing.key";
    await writeFile(
      path.join(sharingDirectory, keyRef),
      await protection.encrypt(
        JSON.stringify({
          version,
          masterKey: Buffer.alloc(32, 9).toString("base64url"),
        }),
      ),
    );
    const file = path.join(sharingDirectory, "migration-state.json");
    const binding = {
      vaultDirectory: vault,
      version,
      clientId: "existing-graph-client",
      sourceWatermark: "watermark",
      keyRef,
      recordCount: 1,
      accounts: [
        {
          id: "shared-preview",
          provider: "codex",
          maskedIdentifier: "test***",
          canRefresh: true,
          revision: "1",
        },
      ],
    };
    await writeFile(
      file,
      JSON.stringify({
        formatVersion: 1,
        product: "graph-agent",
        migrationState: "import-ready",
        selectedBackend: "private",
        binding,
      }),
    );
    const host = {
      localPackageDirectory: directory,
      inspect: async () => ({
        installState: "installed" as const,
        installedVersion: "0.3.0",
        installedApiLevel: "3",
        installationDirectory: directory,
      }),
      install: async () => undefined,
      uninstall: async () => undefined,
      connect: vi.fn(async () => {
        throw new BrokerError("broker-disconnected");
      }),
    };
    const graph = await fixture(directory, protection, { host });
    const status = await (await graph.app.request("/api/v1/credential-sharing/status")).json();
    expect(status.value).toMatchObject({
      role: "both",
      migrationState: "import-ready",
      selectedBackend: "private",
      activeBackend: "private",
      rememberedKey: true,
      accounts: [{ id: "shared-preview" }],
    });
    expect(host.connect).not.toHaveBeenCalled();
    const add = await graph.command("/api/v1/auth/sessions/start", {
      offeringId: "bigmodel-coding-plan",
      method: "api-key",
      apiKey: fictionalSecret,
    });
    expect(add.status).toBe(200);
    const before = await graph.snapshot();
    expect(before.accounts).toHaveLength(1);
    expect(before.backend.active).toBe("private");
    const failed = await graph.command("/api/v1/credential-sharing/enable-shared");
    expect(failed.ok).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      migrationState: "import-ready",
      selectedBackend: "private",
      binding,
    });
    await graph.services.stop();
    const restored = await fixture(directory, protection, { host });
    const after = await restored.snapshot();
    expect(after.accounts).toEqual(before.accounts);
    expect(after.actions.startAuth.state).toBe("enabled");
    expect(after.backend).toMatchObject({ selected: "private", active: "private" });
  });

  it("disables private authorization before calling a provider when OS protection is unavailable", async () => {
    const protection = cipher();
    protection.isAvailable = async () => false;
    const graph = await fixture(await temporaryDirectory(), protection);
    expect(await graph.snapshot()).toMatchObject({
      backend: { selected: "private", active: "unavailable" },
      actions: { startAuth: { state: "disabled" } },
    });
    expect(
      (
        await graph.command("/api/v1/auth/sessions/start", {
          offeringId: "bigmodel-coding-plan",
          method: "api-key",
          apiKey: fictionalSecret,
        })
      ).status,
    ).toBe(503);
    expect(graph.upstream).not.toHaveBeenCalled();
    const status = await (await graph.app.request("/api/v1/credential-sharing/status")).json();
    expect(status.value.privateAvailable).toBe(false);
    expect(status.value.capabilities.verifyImport.state).toBe("disabled");
  });
  it("does not mint a Web broker grant when its configured identity has no existing protected authorization", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({ vaultId: "fictional-vault" }),
    );
    const host = createGraphBrokerHost(directory, true);
    const inspect = vi.spyOn(host, "inspect");
    await expect(host.connect(directory, "unapproved-client", "instance")).rejects.toMatchObject({
      code: "access-denied",
    });
    expect(inspect).not.toHaveBeenCalled();
  });
  it("writes only protected private credentials and restores account identity, enablement and deletion independently", async () => {
    const directory = await temporaryDirectory();
    const protection = cipher();
    const first = await fixture(directory, protection);
    const response = await first.command("/api/v1/auth/sessions/start", {
      offeringId: "bigmodel-coding-plan",
      method: "api-key",
      apiKey: fictionalSecret,
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.ok).toBe(true);
    const accountId = result.value.account.id as string;
    expect(JSON.stringify(result)).not.toContain(fictionalSecret);
    await first.command(`/api/v1/accounts/${accountId}/set-enabled`, { enabled: false });
    expect((await first.snapshot()).accounts[0].enabled).toBe(false);
    const rawVault = await readFile(path.join(directory, "private-business.json"), "utf8");
    expect(rawVault).not.toContain(fictionalSecret);
    const savedVault = JSON.parse(rawVault);
    expect(Object.keys(savedVault).sort()).toEqual(["credentials", "version"]);
    expect(savedVault.credentials[0]).toMatchObject({ accountId, providerId: "glm" });
    expect(savedVault.credentials[0]).not.toHaveProperty("offeringId");
    await first.services.stop();
    const restored = await fixture(directory, protection);
    expect((await restored.snapshot()).accounts[0]).toMatchObject({
      id: accountId,
      enabled: false,
    });
    const otherDirectory = await temporaryDirectory();
    const other = await fixture(otherDirectory, protection);
    await other.command("/api/v1/auth/sessions/start", {
      offeringId: "bigmodel-coding-plan",
      method: "api-key",
      apiKey: fictionalSecret,
    });
    await restored.command(`/api/v1/accounts/${accountId}/delete`);
    expect((await restored.snapshot()).accounts).toHaveLength(0);
    expect((await other.snapshot()).accounts).toHaveLength(1);
    await restored.services.stop();
    const deleted = await fixture(directory, protection);
    expect((await deleted.snapshot()).accounts).toHaveLength(0);
  });

  it("keeps Web running without a private vault and rejects credential writes before any provider request", async () => {
    const directory = await temporaryDirectory();
    const web = await fixture(directory);
    expect(await web.snapshot()).toMatchObject({
      backend: { selected: "shared", active: "unavailable" },
      actions: { startAuth: { state: "disabled" } },
    });
    const response = await web.command("/api/v1/auth/sessions/start", {
      offeringId: "bigmodel-coding-plan",
      method: "api-key",
      apiKey: fictionalSecret,
    });
    expect(response.status).toBe(503);
    expect(web.upstream).not.toHaveBeenCalled();
    const status = await (await web.app.request("/api/v1/credential-sharing/status")).json();
    expect(status.value).toMatchObject({
      privateAvailable: false,
      activeBackend: "unavailable",
      role: "receiver",
    });
    expect(await readdir(directory)).not.toContain("private-business.json");
  });

  it("rejects stale mutation contexts and publishes a single mixed event stream", async () => {
    const fixtureData = await fixture(await temporaryDirectory(), cipher());
    const response = await fixtureData.app.request("/api/v1/auth/sessions/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: "old",
        contextId: "old",
        offeringId: "bigmodel-coding-plan",
        method: "api-key",
        apiKey: fictionalSecret,
      }),
    });
    expect(response.status).toBe(409);
    expect(fixtureData.upstream).not.toHaveBeenCalled();
    const events = await fixtureData.app.request("/api/v1/events");
    const reader = events.body!.getReader();
    const ready = new TextDecoder().decode((await reader.read()).value);
    expect(ready).toContain('"scope":"providers"');
    expect(ready).toContain('"scope":"credentials"');
    await fixtureData.command("/api/v1/auth/sessions/start", {
      offeringId: "bigmodel-coding-plan",
      method: "api-key",
      apiKey: fictionalSecret,
    });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: changed");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      '"scope":"credentials"',
    );
    await reader.cancel();
  });

  it("serves formal Web with a same-origin boundary and an exclusive business profile", async () => {
    const directory = await temporaryDirectory();
    const server = await startGraphServer({ port: 0, directory, env: {} });
    cleanup.push(() => server.stop());
    expect((await fetch(`${server.url}/api/v1/providers`)).status).toBe(200);
    expect(
      (
        await fetch(`${server.url}/api/v1/providers`, {
          headers: { Origin: "https://example.invalid" },
        })
      ).status,
    ).toBe(403);
    expect(() => claimGraphProfile(directory)).toThrow("GraphAgent 数据目录正在使用");
    await server.stop();
    const release = claimGraphProfile(directory);
    release();
  });

  it("reads using a restricted Web grant without requiring export, import or events permissions", async () => {
    const directory = await temporaryDirectory();
    const methods: string[] = [];
    let canRead = true;
    const opaque = {
      credentialId: "opaque",
      revision: "1",
      createdByClientId: "source",
      lastUpdatedByClientId: "source",
      contentType: "application/octet-stream",
      payloadFormatVersion: 1,
      metadata: { provider: "opaque", maskedIdentifier: fictionalSecret },
    };
    const web = await fixture(directory, undefined, {
      brokerBinding: { vaultDirectory: directory, clientId: "web-reader" },
      host: {
        localPackageDirectory: directory,
        inspect: async () => ({
          installState: "installed",
          installedVersion: "0.3.0",
          installationDirectory: directory,
        }),
        install: async () => undefined,
        uninstall: async () => undefined,
        connect: async () => ({
          close() {},
          call: async (method) => {
            methods.push(method);
            if (method === "status") return { ownership: "broker" };
            if (method === "listCredentials") return { items: [opaque], nextCursor: null };
            if (method === "getSnapshotWatermark" && canRead)
              return { vaultId: "vault", storageVersion: "version", watermark: "a".repeat(64) };
            if (method === "disconnect") return {};
            throw new BrokerError("forbidden");
          },
        }),
      },
    });
    await vi.waitFor(() => expect(methods).toContain("getSnapshotWatermark"));
    expect((await web.snapshot()).backend).toMatchObject({ selected: "shared", active: "shared" });
    expect(methods).not.toContain("getSharingState");
    const status = await (await web.app.request("/api/v1/credential-sharing/status")).json();
    expect(status.value).toMatchObject({ privateAvailable: false, accounts: [], recordCount: 0 });
    expect(JSON.stringify(status)).not.toContain(fictionalSecret);
    canRead = false;
    expect((await (await web.command("/api/v1/credential-sharing/retry")).json()).ok).toBe(false);
    expect((await web.snapshot()).backend.active).toBe("unavailable");
  });

  it("disables broker access during an event-stream outage and recovers without a private fallback", async () => {
    const directory = await temporaryDirectory();
    let offline = false;
    const web = await fixture(directory, undefined, {
      brokerBinding: { vaultDirectory: directory, clientId: "existing-graph-client" },
      host: {
        localPackageDirectory: directory,
        inspect: async () => ({
          installState: "installed",
          installedVersion: "1.0.0",
          installationDirectory: directory,
        }),
        install: async () => undefined,
        uninstall: async () => undefined,
        connect: async () => ({
          close() {},
          call: async (method) => {
            if (method === "status") return { ownership: "broker" };
            if (method === "listCredentials") return { items: [], nextCursor: null };
            if (method === "getSnapshotWatermark")
              return { vaultId: "vault", storageVersion: "version", watermark: "a".repeat(64) };
            if (method === "watchEvents") {
              await new Promise((resolve) => setTimeout(resolve, 20));
              if (offline) throw new BrokerError("access-denied");
              return { items: [], nextCursor: "0" };
            }
            if (method === "disconnect") return {};
            throw new Error("unexpected broker method");
          },
        }),
      },
    });
    expect((await web.snapshot()).backend.active).toBe("shared");
    offline = true;
    await vi.waitFor(() => expect(web.services.runtime.isConnected).toBe(false));
    expect((await web.snapshot()).backend).toMatchObject({
      selected: "shared",
      active: "unavailable",
    });
    expect(web.upstream).not.toHaveBeenCalled();
    offline = false;
    await vi.waitFor(() => expect(web.services.runtime.isConnected).toBe(true), { timeout: 3000 });
    expect((await web.snapshot()).backend.active).toBe("shared");
    expect(await readdir(directory)).not.toContain("private-business.json");
  });
});

async function relay(
  command: Awaited<ReturnType<typeof fixture>>["command"],
  name: string,
  baseUrl: string,
  operationId: string,
  offeringId = "default",
) {
  const routes = [{ protocol: "openai-chat", baseUrl }];
  const draft = { name, icon: null, offerings: [{ name: "Default", offeringId, routes }] };
  const provider = (
    await (
      await command("/api/v1/graph-agent/custom-providers/create", {
        ...draft,
        operationId: "provider-" + operationId,
      })
    ).json()
  ).value;
  const result = await command("/api/v1/accounts/connections/create", {
    displayName: name,
    operationId,
    apiKey: fictionalSecret,
    providerId: provider.providerId,
    offeringId,
  });
  const resultBody = await result.json();
  expect(result.status, JSON.stringify(resultBody.error)).toBe(200);
  const connection = resultBody.value as PublicConnection;
  return {
    connection,
    editUrl: (url: string) =>
      command("/api/v1/graph-agent/custom-providers/edit", {
        ...draft,
        providerId: provider.providerId,
        expectedRevision: provider.revision,
        offerings: [{ ...draft.offerings[0], routes: [{ protocol: "openai-chat", baseUrl: url }] }],
      }),
  };
}

describe("New API account operations", () => {
  const site = "https://station.example/prefix";
  const accessToken = "nap_fictional";
  const rawKey = "nextFictionalInferenceKey";
  const offeringSetup = async (
    upstream: typeof fetch,
    privateVault = true,
    options: Partial<GraphServicesOptions> = {},
  ) => {
    const directory = await temporaryDirectory();
    const graph = await fixture(directory, privateVault ? cipher() : undefined, {
      http: { fetch: upstream },
      ...options,
    });
    const draft = {
      templateKind: "new-api",
      name: "Station",
      icon: null,
      offerings: [
        {
          name: "Station",
          offeringId: "station",
          siteBaseUrl: site,
          routes: [{ protocol: "openai-chat", baseUrl: site + "/v1" }],
        },
      ],
    };
    const provider = graph.services.customProviders.create(draft, "station");
    return { graph, provider, draft, directory };
  };
  const accountSetup = async (upstream: typeof fetch) => {
    const { graph, provider, draft, directory } = await offeringSetup(upstream);
    const connection = await graph.services.providers.createConnection({
      providerId: provider.providerId,
      offeringId: "station",
      routes: [],
      operationId: "account",
      displayName: "Station account",
      apiKey: fictionalSecret,
    });
    const guard = {
      accountId: connection.accountId,
      providerId: provider.providerId,
      offeringId: "station",
      expectedRecordRevision: connection.recordRevision,
      expectedProviderRevision: provider.revision,
    };
    const call = async (
      kind: "usage" | "keys" | "select-key",
      extra: Record<string, unknown> = {},
    ) =>
      (await graph.command("/api/v1/graph-agent/new-api/" + kind, { ...guard, ...extra })).json();
    return { graph, guard, call, draft, provider, directory };
  };

  it("lists offering keys and creates the first account without an existing inference credential, with durable retries", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + accessToken);
      if (String(url) === site + "/api/token/?p=1&page_size=20")
        return Response.json({
          success: true,
          data: {
            page: 1,
            page_size: 20,
            total: 1,
            items: [{ id: 3, name: "Personal", key: rawKey }],
          },
        });
      expect(String(url)).toBe(site + "/api/token/3/key");
      return Response.json({ success: true, data: { key: rawKey } });
    });
    const { graph, provider, draft } = await offeringSetup(fetcher);
    const base = "/api/v1/graph-agent/new-api/offering/";
    const guard = {
      providerId: provider.providerId,
      offeringId: "station",
      expectedProviderRevision: provider.revision,
      accessToken,
    };
    expect((await graph.snapshot()).accounts).toHaveLength(0);
    const page = await (await graph.command(base + "keys", { ...guard, page: 1 })).json();
    expect(page.value.items[0]).toMatchObject({ id: 3, name: "Personal" });
    expect(JSON.stringify(page)).not.toContain(rawKey);
    const request = {
      ...guard,
      operationId: "first-station-key",
      tokenId: 3,
      displayName: "My first key",
    };
    const create = async (extra: Record<string, unknown> = {}) =>
      (await graph.command(base + "create-account", { ...request, ...extra })).json();
    expect(await create({ expectedProviderRevision: 99 })).toMatchObject({ ok: false });
    const first = await create();
    expect(first).toMatchObject({ ok: true, value: { displayName: "My first key" } });
    for (const secret of [accessToken, rawKey]) expect(JSON.stringify(first)).not.toContain(secret);
    expect(await create()).toEqual(first);
    const secondSite = "https://second.example";
    const offering = draft.offerings[0];
    const changed = graph.services.customProviders.edit(provider.providerId, provider.revision, {
      ...draft,
      offerings: [
        {
          ...offering,
          siteBaseUrl: secondSite,
          routes: offering.routes.map((route) => ({ ...route, baseUrl: secondSite + "/v1" })),
        },
      ],
    });
    expect(await create({ expectedProviderRevision: changed.revision })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    const restored = graph.services.customProviders.edit(
      provider.providerId,
      changed.revision,
      draft,
    );
    request.expectedProviderRevision = restored.revision;
    expect(await create({ tokenId: 4 })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((await graph.snapshot()).accounts).toHaveLength(1);
    await graph.services.providers.deleteAccount(first.value.accountId, first.value.recordRevision);
    expect(await create()).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((await graph.snapshot()).accounts).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("keeps an unconnected Web host from requesting PAT management or creating accounts", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { graph, provider } = await offeringSetup(fetcher, false);
    const guard = {
      providerId: provider.providerId,
      offeringId: "station",
      expectedProviderRevision: 1,
      accessToken,
    };
    const base = "/api/v1/graph-agent/new-api/offering/";
    expect((await (await graph.command(base + "keys", { ...guard, page: 1 })).json()).ok).toBe(
      false,
    );
    expect(
      (
        await (
          await graph.command(base + "create-account", {
            ...guard,
            operationId: "web",
            displayName: "Web key",
            tokenId: 3,
          })
        ).json()
      ).ok,
    ).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("creates the first account in an authorized headless broker and replays it after reconnect", async () => {
    const vaultDirectory = await temporaryDirectory();
    let stored: BrokerCredential | undefined;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ success: true, data: { key: rawKey } }));
    const { graph, directory, provider } = await offeringSetup(fetcher, false, {
      brokerBinding: { vaultDirectory, clientId: "web" },
      host: {
        localPackageDirectory: vaultDirectory,
        inspect: async () => ({
          installState: "installed",
          installedVersion: "0.3.0",
          installationDirectory: vaultDirectory,
        }),
        install: async () => {},
        uninstall: async () => {},
        connect: async () => ({
          close() {},
          call: async (method, params) => {
            if (method === "status") return { ownership: "broker" };
            if (method === "getSnapshotWatermark")
              return {
                vaultId: "vault",
                storageVersion: "one",
                watermark: stored ? "b".repeat(64) : "a".repeat(64),
              };
            if (method === "listCredentials")
              return { items: stored ? [stored.description] : [], nextCursor: null };
            if (method === "createCredential" && !stored) {
              const request = params as InitialRecord;
              stored = {
                payload: request.payload,
                description: {
                  credentialId: request.credentialId,
                  contentType: request.contentType,
                  payloadFormatVersion: request.payloadFormatVersion,
                  metadata: request.metadata,
                  revision: "1",
                  createdByClientId: "web",
                  lastUpdatedByClientId: "web",
                },
              };
              return stored;
            }
            if (method === "getCredential" && stored) return stored;
            if (method === "disconnect") return {};
            throw new BrokerError("forbidden");
          },
        }),
      },
    });
    const create = async () =>
      (
        await graph.command("/api/v1/graph-agent/new-api/offering/create-account", {
          providerId: provider.providerId,
          offeringId: "station",
          expectedProviderRevision: 1,
          operationId: "headless",
          displayName: "Web station",
          tokenId: 3,
          accessToken,
        })
      ).json();
    const first = await create();
    expect(first).toMatchObject({ ok: true });
    expect(stored?.description.credentialId).toBe(first.value.accountId);
    expect(JSON.stringify(stored?.description)).not.toContain(rawKey);
    await graph.services.credentials.retry();
    expect(await create()).toMatchObject({ ok: true, value: { accountId: first.value.accountId } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).not.toContain("private-business.json");
  });
  it("removes only the replaced Key's catalog from the current visibility scope", async () => {
    const { guard, call, graph, directory } = await accountSetup(async () =>
      Response.json({ success: true, data: { key: rawKey } }),
    );
    const probe = new GraphBusinessDatabase(directory);
    try {
      const connection = await graph.services.providers.getConnection(guard.accountId);
      const route = connection.routes[0];
      const key = {
        accountId: guard.accountId,
        offeringId: guard.offeringId,
        providerId: guard.providerId,
        visibilityRef: "private",
        protocolFamily: route.protocolFamily!,
        familyBindingRevision: route.familyBindingRevision!,
      };
      const other = { ...key, visibilityRef: "another-backend" };
      probe.models.saveCatalog(key, []);
      probe.models.saveCatalog(other, []);
      expect(await call("select-key", { accessToken, tokenId: 1 })).toEqual({
        ok: true,
        value: null,
      });
      expect(probe.models.getCatalog(key)).toBeUndefined();
      expect(probe.models.getCatalog(other)).toBeDefined();
    } finally {
      probe.db.close();
    }
  });
  it("keeps unconfirmed key models visible and rechecks saved chat until this binding is manually confirmed", async () => {
    let confirmed = true;
    const upstream = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === site + "/v1/models")
        return Response.json({
          data: [{ id: "tenant-model", supported_endpoint_types: confirmed ? ["openai"] : [] }],
        });
      if (String(url) === site + "/api/pricing")
        return confirmed
          ? Response.json({
              success: true,
              group_ratio: { standard: 2 },
              data: [
                {
                  model_name: "tenant-model",
                  quota_type: 0,
                  model_ratio: 1,
                  completion_ratio: 2,
                  enable_groups: ["standard"],
                },
              ],
            })
          : new Response("", { status: 403 });
      throw new Error("unexpected network call");
    });
    const { graph, guard } = await accountSetup(upstream);
    const [connection] = (await graph.snapshot()).connections as PublicConnection[];
    const root = "/api/v1/graph-agent/models/";
    const selection = {
      accountId: guard.accountId,
      providerId: guard.providerId,
      protocol: "openai-chat",
      modelId: "tenant-model",
    };
    const expectedBindingRevision = connection.routes[0].bindingRevision;
    const command = async (op: string, data: Record<string, unknown>) => {
      const response = await graph.command(root + op, data);
      expect(response.status).toBe(200);
      return (await response.json()).value as GraphModelSnapshot;
    };
    const refresh = () =>
      command("catalogs/refresh", {
        accountId: selection.accountId,
        protocol: selection.protocol,
        expectedBindingRevision,
      });
    const entry = (snapshot: GraphModelSnapshot) =>
      snapshot.catalogs.find(
        (c) => c.accountId === guard.accountId && c.protocol === "openai-chat",
      )!.entries[0];
    const verified = await refresh();
    expect(entry(verified)).toMatchObject({
      actions: { select: { state: "enabled" } },
      rateCard: null,
      rateCards: {},
      quotes: [
        { condition: "standard", amount: "4" },
        { condition: "standard", amount: "8" },
      ],
    });
    await command("selection/save", {
      expectedSettingsRevision: verified.settingsRevision,
      choice: { selection, expectedBindingRevision },
    });
    confirmed = false;
    const unconfirmed = await refresh();
    expect(entry(unconfirmed)).toMatchObject({
      presence: "remote",
      actions: { select: { state: "disabled" }, preview: { state: "disabled" } },
    });
    expect(unconfirmed.savedSelection?.availability.state).toBe("disabled");
    expect(
      (
        await graph.command(testChatPath, {
          expectedSettingsRevision: unconfirmed.settingsRevision,
          expectedBindingRevision,
          prompt: "test",
        })
      ).status,
    ).not.toBe(200);
    expect(upstream).toHaveBeenCalledTimes(4);
    const registered = await command("entries/edit", {
      selection,
      expectedBindingRevision,
      expectedSettingsRevision: unconfirmed.settingsRevision,
      change: { operation: "upsert", displayName: "Confirmed chat", modelType: "text-llm" },
    });
    expect(entry(registered)).toMatchObject({
      presence: "remote-and-manual",
      actions: { select: { state: "enabled" }, preview: { state: "enabled" } },
    });
    expect(registered.savedSelection?.availability.state).toBe("enabled");
  });

  it("uses only the inference Key for usage and switches by token ID without returning credentials", async () => {
    let expectedKey = fictionalSecret;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const header = new Headers(init?.headers).get("authorization");
      expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
      if (String(url) === site + "/api/usage/token/") {
        expect(header).toBe("Bearer " + expectedKey);
        expect(init?.method).toBe("GET");
        return Response.json({
          code: true,
          data: {
            object: "token_usage",
            total_used: 31,
            total_available: 0,
            unlimited_quota: true,
            user_quota: { total_available: 47 },
          },
        });
      }
      expect(header).toBe("Bearer " + accessToken);
      if (String(url) === site + "/api/token/?p=2&page_size=20") {
        expect(init?.method).toBe("GET");
        return Response.json({
          success: true,
          data: {
            page: 2,
            page_size: 20,
            total: 21,
            items: [
              {
                id: 1,
                name: "Test",
                group: "Station",
                expired_time: -1,
                status: 1,
                key: rawKey,
                unused: accessToken,
              },
            ],
          },
        });
      }
      expect(String(url)).toBe(site + "/api/token/1/key");
      expect(init?.method).toBe("POST");
      return Response.json({ success: true, data: { key: rawKey } });
    });
    const { call, graph, guard } = await accountSetup(fetcher);
    expect(await call("usage")).toEqual({
      ok: true,
      value: {
        totalUsed: 31,
        totalAvailable: 0,
        totalGranted: null,
        unlimitedQuota: true,
        expiresAt: null,
        userQuota: { totalUsed: null, totalAvailable: 47 },
      },
    });
    expect(await call("keys", { accessToken, page: 2 })).toEqual({
      ok: true,
      value: {
        page: 2,
        pageSize: 20,
        total: 21,
        items: [{ id: 1, name: "Test", group: "Station", status: 1, expiresAt: -1 }],
      },
    });
    expect(await call("select-key", { accessToken, tokenId: 1 })).toEqual({
      ok: true,
      value: null,
    });
    const updated = (await graph.snapshot()).connections[0];
    expect(updated.recordRevision).not.toBe(guard.expectedRecordRevision);
    expect(await call("usage")).toMatchObject({ ok: false, error: { code: "stale-binding" } });
    expectedKey = "sk-" + rawKey;
    expect(await call("usage", { expectedRecordRevision: updated.recordRevision })).toMatchObject({
      ok: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    const snapshot = JSON.stringify(await graph.snapshot());
    for (const secret of [accessToken, rawKey, fictionalSecret])
      expect(snapshot).not.toContain(secret);
  });

  it("rejects stale revisions, extra destinations and cross-site or cross-prefix execution routes before dispatch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { graph, guard, call } = await accountSetup(fetcher);
    expect(
      await call("keys", { accessToken, page: 1, site: "https://other.example" }),
    ).toMatchObject({ ok: false });
    expect(await call("keys", { accessToken, page: 1, expectedProviderRevision: 7 })).toMatchObject(
      { ok: false },
    );
    const rows = graph.services.customProviders.routes(guard.providerId, guard.offeringId)!;
    const source = vi.spyOn(graph.services.customProviders, "routes");
    for (const baseUrl of ["https://other.example/prefix/v1", "https://station.example/other/v1"]) {
      source.mockReturnValue(rows.map((r) => ({ ...r, baseUrl })));
      expect(await call("usage")).toMatchObject({ ok: false });
      expect(await call("keys", { accessToken, page: 1 })).toMatchObject({ ok: false });
      expect(await call("select-key", { accessToken, tokenId: 1 })).toMatchObject({ ok: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("discards a reveal when the offering changes during the request", async () => {
    let notify!: () => void;
    const started = new Promise<void>((resolve) => {
      notify = resolve;
    });
    let finish!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const { graph, guard, draft, call } = await accountSetup(async () => {
      notify();
      return response;
    });
    const result = call("select-key", { accessToken, tokenId: 1 });
    await started;
    graph.services.customProviders.edit(guard.providerId, guard.expectedProviderRevision, {
      ...draft,
      name: "Updated",
    });
    finish(Response.json({ success: true, data: { key: rawKey } }));
    expect(await result).toMatchObject({ ok: false, error: { code: "stale-binding" } });
    expect((await graph.snapshot()).connections[0].recordRevision).toBe(
      guard.expectedRecordRevision,
    );
  });

  it("withholds upstream error text and rejects redirects and masked reveal responses", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(accessToken, { status: 403 }))
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: "https://other.example/" } }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, data: { key: "abcd********wxyz" } }));
    const { graph, guard, call } = await accountSetup(fetcher);
    for (let i = 0; i < 3; i++) {
      const result = await call("select-key", { accessToken, tokenId: 1 });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(accessToken);
    }
    expect((await graph.snapshot()).connections[0].recordRevision).toBe(
      guard.expectedRecordRevision,
    );
  });
});

describe("New API site and account model catalogs", () => {
  it("browses a subpath installation before adding a key and limits discovery by key and endpoint", async () => {
    const directory = await temporaryDirectory(),
      protection = cipher();
    const base = "https://relay.example/tenant-a";
    let publicPricing = true;
    const http: GraphServicesOptions["http"] = {
      async fetch(url, init) {
        const headers = new Headers(init?.headers);
        if (String(url) === base + "/api/pricing") {
          expect(headers.has("authorization") || headers.has("x-api-key")).toBe(false);
          if (!publicPricing) return new Response(null, { status: 403 });
          return Response.json({
            success: true,
            data: [
              { model_name: "listed-only", supported_endpoint_types: ["openai"] },
              {
                model_name: "chat",
                quota_type: 1,
                model_price: 0.1,
                supported_endpoint_types: ["openai"],
              },
              { model_name: "responses", supported_endpoint_types: ["openai-response"] },
            ],
          });
        }
        expect(String(url)).toBe(base + "/v1/models");
        expect(headers.get("authorization")).toBe("Bearer " + fictionalSecret);
        return Response.json({
          object: "list",
          data: [
            { id: "chat", supported_endpoint_types: ["openai"] },
            { id: "responses", supported_endpoint_types: ["openai-response"] },
          ],
        });
      },
    };
    const graph = await fixture(directory, protection, { http });
    const customRoot = "/api/v1/graph-agent/custom-providers";
    const draft = {
      name: "Relay",
      icon: null,
      templateKind: "new-api",
      offerings: [
        {
          name: "Tenant",
          offeringId: "tenant",
          siteBaseUrl: base,
          routes: [{ protocol: "openai-chat", baseUrl: base + "/v1" }],
        },
      ],
    };
    const provider = (
      await (
        await graph.command(customRoot + "/create", { ...draft, operationId: "new-api-directory" })
      ).json()
    ).value;
    const path = customRoot + "/" + provider.providerId + "/offerings/tenant/catalog?revision=";
    const listing = await (await graph.app.request(path + provider.revision)).json();
    expect(listing.ok).toBe(true);
    expect(listing.value.map((m: { modelId: string }) => m.modelId)).toEqual([
      "listed-only",
      "chat",
      "responses",
    ]);
    expect(listing.value[1].billing).toMatchObject({ kind: "per-request", modelPrice: 0.1 });
    const connection: PublicConnection = (
      await (
        await graph.command("/api/v1/accounts/connections/create", {
          providerId: provider.providerId,
          offeringId: "tenant",
          displayName: "Scoped Key",
          operationId: "new-api-key",
          apiKey: fictionalSecret,
        })
      ).json()
    ).value;
    const refresh = async () => {
      const result = await (
        await graph.command("/api/v1/graph-agent/models/catalogs/refresh", {
          accountId: connection.accountId,
          protocol: "openai-chat",
          expectedBindingRevision: connection.routes[0].bindingRevision,
        })
      ).json();
      expect(result.ok).toBe(true);
      const catalog = (result.value as GraphModelSnapshot).catalogs.find(
        (c) => c.accountId === connection.accountId,
      )!;
      expect(catalog.entries.map((e) => e.selection.modelId)).toEqual(["chat"]);
    };
    await refresh();
    publicPricing = false;
    expect((await (await graph.app.request(path + provider.revision)).json()).ok).toBe(false);
    await refresh();
    const edit = await graph.command(customRoot + "/edit", {
      ...draft,
      name: "Renamed",
      providerId: provider.providerId,
      expectedRevision: provider.revision,
    });
    expect(edit.status).toBe(200);
    expect((await (await graph.app.request(path + provider.revision)).json()).error.code).toBe(
      "conflict",
    );
    await graph.services.stop();
    const reopened = await fixture(directory, protection, { http });
    publicPricing = true;
    expect(
      (await (await reopened.app.request(path + (provider.revision + 1))).json()).value,
    ).toEqual(listing.value);
  });
});

describe("family catalog bindings", () => {
  it("shares a New API discovery across Chat and Responses and projects endpoint-specific evidence", async () => {
    const base = "https://family.example/tenant";
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) === base + "/api/pricing") return Response.json({ success: true, data: [] });
      expect(String(url)).toBe(base + "/v1/models?region=test");
      expect(new Headers(init?.headers).get("x-tenant")).toBe("one");
      expect(new Headers(init?.headers).get("x-api-key")).toBe(fictionalSecret);
      await pending;
      return Response.json({
        data: [
          { id: "a", supported_endpoint_types: ["openai"] },
          { id: "b", supported_endpoint_types: ["openai-response"] },
        ],
      });
    });
    const graph = await fixture(await temporaryDirectory(), cipher(), { http: { fetch: fetcher } });
    const draft = {
      name: "Relay",
      icon: null,
      templateKind: "new-api",
      familyPolicies: {
        openai: {
          authentication: "x-api-key",
          headers: { "X-Tenant": "one" },
          query: { region: "test" },
        },
      },
      offerings: [
        {
          name: "One",
          offeringId: "one",
          siteBaseUrl: base,
          routes: ["openai-chat", "openai-responses", "anthropic-messages"].map((protocol) => ({
            protocol,
            baseUrl: base + "/v1",
          })),
        },
      ],
    };
    const root = "/api/v1/graph-agent/custom-providers/";
    const provider = (
      await (await graph.command(root + "create", { ...draft, operationId: "family-test" })).json()
    ).value;
    const connection: PublicConnection = (
      await (
        await graph.command("/api/v1/accounts/connections/create", {
          operationId: "family-key",
          displayName: "Family",
          apiKey: fictionalSecret,
          offeringId: "one",
          providerId: provider.providerId,
        })
      ).json()
    ).value;
    const [chat, responses, anthropic] = connection.routes;
    expect(chat.familyBindingRevision).toBeTruthy();
    expect(responses.familyBindingRevision).toBe(chat.familyBindingRevision);
    expect(anthropic.familyBindingRevision).not.toBe(chat.familyBindingRevision);
    const refresh = (route: typeof chat) =>
      graph.command("/api/v1/graph-agent/models/catalogs/refresh", {
        accountId: connection.accountId,
        protocol: route.protocol,
        expectedBindingRevision: route.bindingRevision,
      });
    const first = refresh(chat);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const second = graph.services.models.refreshCatalog({
      accountId: connection.accountId,
      protocolFamily: "openai",
      expectedFamilyBindingRevision: responses.familyBindingRevision!,
      contextId: connection.contextId,
      instanceId: connection.instanceId,
    });
    expect(graph.services.models.getSnapshot().catalogs.filter((c) => c.refreshing)).toHaveLength(
      2,
    );
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.status).toBe(200);
    const catalogs = two.catalogs;
    expect(
      catalogs.find((c) => c.protocol === chat.protocol)?.entries.map((e) => e.selection.modelId),
    ).toEqual(["a"]);
    expect(
      catalogs
        .find((c) => c.protocol === responses.protocol)
        ?.entries.map((e) => e.selection.modelId),
    ).toEqual(["b"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const foreign = await graph.command("/api/v1/graph-agent/models/catalogs/refresh", {
      accountId: connection.accountId,
      protocolFamily: "anthropic",
      expectedFamilyBindingRevision: responses.familyBindingRevision,
    });
    expect(foreign.status).not.toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const edit = await graph.command(root + "edit", {
      ...draft,
      familyPolicies: { openai: { catalog: "none" } },
      providerId: provider.providerId,
      expectedRevision: provider.revision,
    });
    expect(edit.status).toBe(200);
    expect((await refresh(chat)).status).not.toBe(200);
    expect(
      graph.services.models.getSnapshot().catalogs.find((c) => c.protocol === "openai-responses"),
    ).toMatchObject({ refresh: { state: "disabled" }, entries: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("resolves a sole specialist route before persisting a manual model; a language model requires a route", async () => {
    const dir = await temporaryDirectory(),
      key = cipher(),
      graph = await fixture(dir, key);
    const root = "/api/v1/graph-agent/models/";
    const provider = (
      await (
        await graph.command("/api/v1/graph-agent/custom-providers/create", {
          name: "Video",
          icon: null,
          offerings: [
            {
              offeringId: "one",
              name: "Video",
              routes: [{ protocolFamily: "grok-video", baseUrl: "https://video.example/v1" }],
            },
          ],
          operationId: "video-family",
        })
      ).json()
    ).value;
    const c: PublicConnection = (
      await (
        await graph.command("/api/v1/accounts/connections/create", {
          providerId: provider.providerId,
          offeringId: "one",
          apiKey: fictionalSecret,
          operationId: "video-key",
          displayName: "Example",
        })
      ).json()
    ).value;
    const edit = (family: string, explicitNull: boolean) =>
      graph.command(root + "entries/edit", {
        selection: {
          providerId: provider.providerId,
          accountId: c.accountId,
          modelId: "movie",
          protocolFamily: family,
          ...(explicitNull && { protocol: null }),
        },
        expectedBindingRevision: c.routes[0].bindingRevision,
        expectedSettingsRevision: graph.services.models.getSnapshot().settingsRevision,
        change: { operation: "upsert", displayName: "Movie" },
      });
    expect((await edit("anthropic", false)).status).not.toBe(200);
    for (const explicitNull of [false, true])
      expect((await edit("grok-video", explicitNull)).status).toBe(200);
    await graph.services.stop();
    const reopened = await fixture(dir, key);
    expect(reopened.services.models.getSnapshot().catalogs[0].entries[0].selection.protocol).toBe(
      "grok-video-generations",
    );
    expect(graph.upstream).not.toHaveBeenCalled();
  });
});

describe("GraphAgent single-turn chat route", () => {
  it("streams across both loopback HTTP connections and cancels the upstream socket on disconnect", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closed!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    let drains = 0;
    const first = 'data: {"choices":[{"delta":{"content":"first"}}]}\n\n';
    const large = 'data: {"choices":[{"delta":{"content":"' + "a".repeat(128 * 1024) + '"}}]}\n\n';
    const upstream = createServer(async (request, response) => {
      expect(request.headers.authorization).toBe("Bearer " + fictionalSecret);
      request.resume();
      response.on("close", closed);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(first);
      await gate;
      for (let i = 0; i < 4 && !response.destroyed; i++) {
        if (!response.write(large)) {
          drains++;
          await once(response, "drain");
        }
      }
      // Keep the response open until the downstream client disconnects.
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const port = (upstream.address() as { port: number }).port;
    const graph = await fixture(await temporaryDirectory(), cipher(), { http: { fetch } });
    const host = serve({
      port: 0,
      hostname: "127.0.0.1",
      overrideGlobalObjects: false,
      fetch: graph.app.fetch,
    });
    await once(host, "listening");
    try {
      const { connection } = await relay(
        graph.command,
        "TCP",
        "http://127.0.0.1:" + port + "/v1",
        "tcp-proxy",
      );
      const root = "/api/v1/graph-agent/models/";
      const snapshot = (await (await graph.app.request(root + "snapshot")).json()).value;
      const selection = {
        providerId: connection.providerId,
        accountId: connection.accountId,
        protocol: "openai-chat",
        modelId: "tcp/model",
      };
      const binding = { expectedBindingRevision: connection.routes[0].bindingRevision };
      const registered = (
        await (
          await graph.command(root + "entries/edit", {
            selection,
            ...binding,
            expectedSettingsRevision: snapshot.settingsRevision,
            change: { operation: "upsert", displayName: "TCP model" },
          })
        ).json()
      ).value;
      const saved = (
        await (
          await graph.command(root + "selection/save", {
            expectedSettingsRevision: registered.settingsRevision,
            choice: { selection, ...binding },
          })
        ).json()
      ).value;
      const cancel = new AbortController();
      const response = await fetch(
        "http://127.0.0.1:" +
          (host.address() as { port: number }).port +
          "/api/v1/graph-agent/proxy/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-GraphAgent-Instance-Id": saved.stamp.instanceId,
            "X-GraphAgent-Context-Id": saved.backend.contextId,
            "X-GraphAgent-Settings-Revision": saved.settingsRevision,
            "X-GraphAgent-Binding-Revision": binding.expectedBindingRevision,
          },
          body: JSON.stringify({
            model: "tcp/model",
            messages: [{ role: "user", content: "hello" }],
            stream: true,
          }),
          signal: cancel.signal,
        },
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(first);
      release();
      let received = 0;
      while (received < large.length * 4) {
        const part = await reader.read();
        expect(part.done).toBe(false);
        received += part.value!.byteLength;
      }
      expect(drains).toBeGreaterThan(0);
      expect(received).toBe(large.length * 4);
      cancel.abort();
      await upstreamClosed;
    } finally {
      release();
      host.close();
      upstream.closeAllConnections();
      upstream.close();
    }
  });
  it.each([
    ["openai-chat", "openai", "chat/completions"],
    ["openai-responses", "openai", "responses"],
    ["anthropic-messages", "anthropic", "messages"],
  ] as const)(
    "proxies %s native bytes, consumes the first frame before EOF and cancels a closed result",
    async (routeId, family, path) => {
      let incoming!: ReadableStreamDefaultController<Uint8Array>;
      let stopped = false;
      let sent = 0;
      let status = 200;
      let jsonAnswer = "";
      const bytes = new TextEncoder();
      const body =
        routeId === "openai-responses"
          ? '{ "model": "native/model", "input": [{"role":"user","content":"你好"}], "stream": true, "ext":[{"x":5}] }'
          : '{ "model": "native/model", "messages": [{"role":"user","content":"你好"}], "stream": true, "ext":[{"x":5}] }';
      const directory =
        family === "openai"
          ? '{"object":"list","data":[{"id":"e"}]}'
          : '{"data":[],"first_id":null,"last_id":null,"has_more":false}';
      const graph = await fixture(await temporaryDirectory(), cipher(), {
        http: {
          fetch: async (url, init) => {
            ++sent;
            expect(init?.redirect).toBe("manual");
            const headers = new Headers(init?.headers);
            expect(headers.has("x-graphagent-context-id") || headers.has("cookie")).toBe(false);
            if (family === "openai")
              expect(headers.get("Authorization")).toBe("Bearer " + fictionalSecret);
            else {
              expect(headers.get("x-api-key")).toBe(fictionalSecret);
              expect(headers.get("anthropic-version")).toBe("2023-06-01");
            }
            if (String(url) === "https://proxy-fixture.invalid/tenant/v1/models?limit=5")
              return new Response(directory, { headers: { "content-type": "application/json" } });
            expect(String(url)).toBe("https://proxy-fixture.invalid/tenant/v1/" + path);
            expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(body);
            if (status !== 200)
              return new Response(fictionalSecret, { status, headers: { "retry-after": "17" } });
            if (jsonAnswer)
              return new Response(jsonAnswer, {
                headers: { "content-type": "application/json; charset=utf-8" },
              });
            return new Response(
              new ReadableStream({
                start(c) {
                  incoming = c;
                },
                cancel() {
                  stopped = true;
                },
              }),
              {
                headers: { "content-type": "text/event-stream", "set-cookie": "never=exposed" },
              },
            );
          },
        },
      });
      const prov = (
        await (
          await graph.command("/api/v1/graph-agent/custom-providers/create", {
            operationId: "native-test",
            name: "Native",
            icon: null,
            offerings: [
              {
                name: "Site",
                offeringId: "site",
                routes: [{ protocol: routeId, baseUrl: "https://proxy-fixture.invalid/tenant/v1" }],
              },
            ],
          })
        ).json()
      ).value;
      const account = (
        await (
          await graph.command("/api/v1/accounts/connections/create", {
            providerId: prov.providerId,
            offeringId: "site",
            operationId: "native-key",
            displayName: "Key",
            apiKey: fictionalSecret,
          })
        ).json()
      ).value as PublicConnection;
      const models = "/api/v1/graph-agent/models/";
      const snapshot = (await (await graph.app.request(models + "snapshot")).json())
        .value as GraphModelSnapshot;
      const h = new Headers({
        "X-GraphAgent-Instance-Id": snapshot.stamp.instanceId,
        "X-GraphAgent-Context-Id": snapshot.backend.contextId,
        "X-GraphAgent-Account-Id": account.accountId,
        "X-GraphAgent-Family-Binding-Revision": account.routes[0].familyBindingRevision!,
        Authorization: "client-credential",
        Cookie: "untrusted=cookie",
      });
      const base = "/api/v1/graph-agent/proxy/" + family + "/v1/";
      expect(await (await graph.app.request(base + "models?limit=5", { headers: h })).text()).toBe(
        directory,
      );
      expect(
        (await graph.app.request(base + "models?api_key=outside", { headers: h })).status,
      ).toBe(400);
      const selection = {
        accountId: account.accountId,
        providerId: prov.providerId,
        modelId: "native/model",
        protocol: routeId,
      };
      const binding = { expectedBindingRevision: account.routes[0].bindingRevision };
      const registered = (
        await (
          await graph.command(models + "entries/edit", {
            selection,
            ...binding,
            expectedSettingsRevision: snapshot.settingsRevision,
            change: { operation: "upsert", displayName: "Native" },
          })
        ).json()
      ).value;
      const saved = (
        await (
          await graph.command(models + "selection/save", {
            expectedSettingsRevision: registered.settingsRevision,
            choice: { selection, ...binding },
          })
        ).json()
      ).value;
      h.set("X-GraphAgent-Settings-Revision", saved.settingsRevision);
      h.set("X-GraphAgent-Binding-Revision", binding.expectedBindingRevision);
      h.set("content-type", "application/json");
      const post = (payload = body) =>
        graph.app.request(base + path, { method: "POST", headers: h, body: payload });
      expect((await post(body.replace("native/model", "other"))).status).toBe(409);
      h.set("X-GraphAgent-Settings-Revision", "stale");
      expect((await post()).status).toBe(409);
      h.set("X-GraphAgent-Settings-Revision", saved.settingsRevision);
      if (family === "openai") {
        const wrong = await graph.app.request("/api/v1/graph-agent/proxy/anthropic/v1/messages", {
          method: "POST",
          headers: h,
          body: JSON.stringify({ model: "native/model", messages: [] }),
        });
        expect(wrong.status).toBe(409);
        expect((await wrong.json()).type).toBe("error");
      }
      expect(sent).toBe(1);
      const response = await post();
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.status).toBe(200);
      const callId = response.headers.get("x-graphagent-call-id")!;
      const first = 'event: extension\r\ndata: {"value":"你好","nested":{ "x":42 }}\r\n\r\n';
      const reader = response.body!.getReader();
      const raw = bytes.encode(first);
      for (const byte of raw) incoming.enqueue(Uint8Array.of(byte));
      const chunks: Uint8Array[] = [];
      let receivedBytes = 0;
      while (receivedBytes < raw.length) {
        const part = await reader.read();
        expect(part.done).toBe(false);
        chunks.push(part.value!);
        receivedBytes += part.value!.byteLength;
      }
      expect(Uint8Array.from(Buffer.concat(chunks))).toEqual(raw);
      expect((await graph.command(testChatPath + "/close", { callId })).status).toBe(200);
      expect((await reader.read()).done).toBe(true);
      expect(stopped).toBe(true);
      const result = await post();
      const charge = {
        usage: { input_tokens: 8, output_tokens: 4 },
        billing: { actual_charge: { amount: "0.12", currency: "USD", event_id: "once" } },
      };
      const event =
        routeId === "openai-responses"
          ? { type: "response.completed", response: charge }
          : routeId === "anthropic-messages"
            ? { type: "message_delta", ...charge }
            : { choices: [], ...charge };
      const frame = "data: " + JSON.stringify(event) + "\n\n";
      incoming.enqueue(bytes.encode(frame + frame));
      incoming.close();
      expect(await result.text()).toBe(frame + frame);
      const priced = await graph.command(testChatPath + "/charge", {
        callId: result.headers.get("x-graphagent-call-id"),
      });
      expect((await priced.json()).value).toMatchObject({
        status: "actual",
        amount: "0.12",
        currency: "USD",
      });
      jsonAnswer = JSON.stringify({ ...charge, unknown: { nested: "你好" } }, null, 2);
      const json = await post();
      expect(await json.text()).toBe(jsonAnswer);
      jsonAnswer = JSON.stringify({ unknown: fictionalSecret });
      const blocked = await post();
      expect(blocked.status).toBe(502);
      expect(await blocked.text()).not.toContain(fictionalSecret);
      status = 429;
      const denied = await post();
      expect(denied.status).toBe(429);
      expect(denied.headers.get("retry-after")).toBe("17");
      const nativeError = await denied.json();
      expect(nativeError.error.type).toBe("rate_limit_error");
      expect(nativeError.type).toBe(family === "anthropic" ? "error" : undefined);
      expect(JSON.stringify(nativeError)).not.toContain(fictionalSecret);
      expect((await post(" ".repeat(4 * 1024 * 1024 + 1))).status).toBe(400);
      expect(sent).toBe(6);
    },
  );
  it("uses the saved binding, discards stale replies and persists no prompts or answers", async () => {
    const directory = await temporaryDirectory();
    const delivered: unknown[] = [];
    let inFlightSignal: AbortSignal | null = null;
    let started!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (started = resolve));
    const upstreamGate = new Promise<void>((resolve) => (release = resolve));
    const { command, app } = await fixture(directory, cipher(), {
      http: {
        fetch: async (url, init) => {
          expect(String(url)).toBe("https://relay.example/prefix/v1/chat/completions");
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + fictionalSecret);
          const body = JSON.parse(String(init?.body));
          delivered.push(body.messages);
          if (delivered.length === 2) {
            inFlightSignal = init!.signal!;
            started();
            await upstreamGate;
          }
          return Response.json({
            choices: [{ message: { content: "fictional answer from the gateway" } }],
          });
        },
      },
    });
    const { connection, editUrl } = await relay(
      command,
      "Isolated relay",
      "https://relay.example/prefix/v1",
      "testChat",
    );
    const root = "/api/v1/graph-agent/models/";
    const snapshot = (await (await app.request(root + "snapshot")).json())
      .value as GraphModelSnapshot;
    const expectedBindingRevision = connection.routes[0].bindingRevision;
    const selection = {
      accountId: connection.accountId,
      providerId: connection.providerId,
      protocol: "openai-chat",
      modelId: "custom/deployment",
    };
    const registered = (
      await (
        await command(root + "entries/edit", {
          selection,
          expectedBindingRevision,
          expectedSettingsRevision: snapshot.settingsRevision,
          change: { operation: "upsert", displayName: "Deployment" },
        })
      ).json()
    ).value as GraphModelSnapshot;
    const saved = (
      await (
        await command(root + "selection/save", {
          expectedSettingsRevision: registered.settingsRevision,
          choice: {
            selection,
            expectedBindingRevision,
            parameters: { effort: null, contextWindow: null, maxOutputTokens: null },
          },
        })
      ).json()
    ).value as GraphModelSnapshot;
    const input: TestChatRequest = {
      instanceId: saved.stamp.instanceId,
      contextId: saved.backend.contextId,
      expectedSettingsRevision: saved.settingsRevision,
      expectedBindingRevision,
      prompt: "fictional first question",
    };
    const send = (changes: Partial<TestChatRequest> = {}) =>
      command(testChatPath, { ...input, ...changes });
    expect((await send({ expectedBindingRevision: "changed" })).status).toBe(409);
    expect((await command(testChatPath, { ...input, url: "https://another.example" })).status).toBe(
      400,
    );
    expect((await send({ prompt: " " })).status).toBe(400);
    expect(delivered).toHaveLength(0);
    expect(await (await send()).json()).toMatchObject({
      ok: true,
      value: { text: "fictional answer from the gateway" },
    });

    const pending = send({ prompt: "fictional second question" });
    try {
      await waiting;
      const changed = await editUrl("https://new.example/v1");
      expect(changed.status).toBe(200);
      expect(inFlightSignal).toHaveProperty("aborted", true);
    } finally {
      release();
    }
    expect((await pending).status).toBe(409);
    expect(delivered).toEqual([
      [{ role: "user", content: "fictional first question" }],
      [{ role: "user", content: "fictional second question" }],
    ]);
    const database = await readFile(path.join(directory, "private-business.json"), "utf8");
    for (const content of [
      fictionalSecret,
      input.prompt,
      "fictional second question",
      "fictional answer from the gateway",
    ]) {
      expect(database).not.toContain(content);
    }
  });
});

describe("GraphAgent model configuration", () => {
  const prefix = "/api/v1/graph-agent/models/";
  it("persists DeepSeek thinking settings and disables both dependent parameters on the same account", async () => {
    const graph = await fixture(await temporaryDirectory(), cipher(), {
      http: { fetch: async () => Response.json({ data: [{ id: "deepseek-flash" }] }) },
    });
    const conn: PublicConnection = (
      await (
        await graph.command("/api/v1/accounts/connections/create", {
          providerId: "deepseek",
          offeringId: "deepseek-api-key",
          operationId: "reasoning-switch",
          displayName: "DeepSeek sandbox",
          apiKey: fictionalSecret,
          routes: [{ protocol: "openai-chat", baseUrl: "https://ds.invalid/v1" }],
        })
      ).json()
    ).value;
    const binding = {
      accountId: conn.accountId,
      protocol: "openai-chat",
      expectedBindingRevision: conn.routes[0].bindingRevision,
    };
    const command = async (action: string, fields: Record<string, unknown>) => {
      const result = await (await graph.command(prefix + action, fields)).json();
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      return result.value;
    };
    let snapshot: GraphModelSnapshot = await command("catalogs/refresh", binding);
    const target = {
      selection: {
        accountId: conn.accountId,
        providerId: "deepseek",
        protocol: "openai-chat",
        modelId: "deepseek-flash",
      },
      expectedBindingRevision: binding.expectedBindingRevision,
    };
    expect(snapshot.catalogs[0].entries[0].parameters).toMatchObject({
      thinkingEnabled: true,
      returnFullReasoning: false,
    });
    for (const thinkingEnabled of [true, false]) {
      snapshot = await command("draft/save", {
        ...target,
        expectedSettingsRevision: snapshot.settingsRevision,
        scope: "account",
        changes: [],
        priceChanges: [],
        parameterChanges: [
          { field: "thinkingEnabled", operation: "set", value: thinkingEnabled },
          { field: "returnFullReasoning", operation: "set", value: true },
          { field: "effort", operation: "set", value: "high" },
        ],
      });
      const entry = snapshot.catalogs[0].entries[0];
      expect(entry.parameters).toMatchObject({
        thinkingEnabled,
        returnFullReasoning: thinkingEnabled,
        effort: thinkingEnabled ? "high" : null,
      });
      const preview = await command("request-preview", {
        ...target,
        operation: "chat",
        expectedSettingsRevision: snapshot.settingsRevision,
        parameters: entry.parameters,
      });
      expect(preview.body.thinking.type).toBe(thinkingEnabled ? "enabled" : "disabled");
      expect(preview.body.reasoning_effort).toBe(thinkingEnabled ? "high" : undefined);
    }
  });
  it("returns field diagnostics for invalid settings before looking up a credential", async () => {
    const graph = await fixture(await temporaryDirectory(), cipher());
    const response = await graph.command(prefix + "selection/save", {
      expectedSettingsRevision: "0",
      choice: {
        selection: {
          accountId: "account",
          providerId: "provider",
          modelId: "model",
          protocol: "openai-chat",
        },
        expectedBindingRevision: "1",
        parameters: { maxOutputTokens: -1, effort: null, contextWindow: null },
      },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.fields).toMatchObject([
      { path: "maxOutputTokens", code: "invalid-value" },
    ]);
    expect(graph.upstream).not.toHaveBeenCalled();
  });
  it("keeps binding-specific catalogs, field sources and settings across failure, restart and rebind", async () => {
    const directory = await temporaryDirectory(),
      protection = cipher();
    let scenario = "available";
    const upstream = vi.fn(async () => {
      if (scenario === "failed") return new Response(null, { status: 503 });
      return Response.json({
        data:
          scenario === "empty"
            ? []
            : [{ id: "gpt-4.1-mini", context_window: 1200, input_modalities: ["text"] }],
      });
    });
    const first = await fixture(directory, protection, { http: { fetch: upstream } });
    const { connection } = await relay(
      first.command,
      "Gateway",
      "https://gateway.invalid/v1",
      "gateway1",
      "openai-api-key",
    );
    expect(upstream).not.toHaveBeenCalled();
    const scope = {
      accountId: connection.accountId,
      protocol: "openai-chat",
      expectedBindingRevision: connection.routes[0].bindingRevision,
    };
    const selection = {
      providerId: connection.providerId,
      accountId: scope.accountId,
      protocol: scope.protocol,
      modelId: "gpt-4.1-mini",
    };
    const get = async () => (await (await first.app.request(prefix + "snapshot")).json()).value;
    const command = async (action: string, data: Record<string, unknown>) =>
      (await first.command(prefix + action, data)).json();
    let snap = (await command("catalogs/refresh", scope)).value;
    const fields = snap.catalogs[0].entries[0].fields;
    expect(fields).toMatchObject({
      contextWindow: { value: 1200, source: { kind: "remote" } },
      maxOutputTokens: { value: 32768, source: { kind: "preset" } },
      vision: { value: "unsupported" },
    });
    const bound = { selection, expectedBindingRevision: scope.expectedBindingRevision };
    const edit = (action: string, data: Record<string, unknown>) =>
      command(action, { ...bound, expectedSettingsRevision: snap.settingsRevision, ...data });
    const key = {
      kind: "input",
      currency: "USD",
      unit: "1M tokens",
      tier: null,
      durationSeconds: null,
    };
    snap = (
      await edit("overrides/edit", {
        changes: [{ field: "contextWindow", operation: "set", value: 850 }],
        priceChanges: [{ key, operation: "set", amount: "0" }],
      })
    ).value;
    expect(snap.catalogs[0].entries[0].fields.contextWindow).toMatchObject({
      value: 850,
      source: { kind: "user" },
    });
    expect(snap.catalogs[0].entries[0].prices).toContainEqual(
      expect.objectContaining({ key, amount: expect.objectContaining({ value: "0" }) }),
    );
    snap = (
      await edit("overrides/edit", {
        changes: [{ field: "contextWindow", operation: "clear" }],
        priceChanges: [{ key, operation: "clear" }],
      })
    ).value;
    expect(snap.catalogs[0].entries[0].fields.contextWindow.value).toBe(1200);
    expect(snap.catalogs[0].entries[0].prices).toEqual([]); // A gateway has no verified first-party prices.
    const parameters = { contextWindow: null, effort: null, maxOutputTokens: 64 };
    snap = (
      await edit("draft/save", {
        scope: "account",
        changes: [],
        priceChanges: [],
        parameterChanges: [{ field: "maxOutputTokens", operation: "set", value: 64 }],
      })
    ).value;
    const selected = await command("selection/save", {
      expectedSettingsRevision: snap.settingsRevision,
      choice: { ...bound, parameters: { ...parameters, maxOutputTokens: 32 } },
    });
    expect(selected.value.savedSelection.availability.state).toBe("enabled");
    const stale = await edit("entries/edit", { change: { operation: "remove" } });
    expect(stale.error.code).toBe("conflict");
    scenario = "failed";
    expect((await command("catalogs/refresh", scope)).ok).toBe(false);
    expect((await get()).catalogs[0]).toMatchObject({
      catalog: { stale: true, state: "ready" },
      entries: [{ presence: "remote" }],
    });
    scenario = "empty";
    snap = (await command("catalogs/refresh", scope)).value;
    expect(snap.catalogs[0].entries).toMatchObject([{ presence: "missing" }]);
    expect(snap.savedSelection.availability.state).toBe("disabled");
    snap = (
      await edit("entries/edit", {
        change: { operation: "upsert", displayName: "Manual deployment" },
      })
    ).value;
    expect(snap.savedSelection.availability.state).toBe("enabled");
    await first.services.stop();
    const restored = await fixture(directory, protection, { http: { fetch: upstream } });
    const next = await (await restored.app.request(prefix + "snapshot")).json();
    expect(next.value).toMatchObject({
      settingsRevision: snap.settingsRevision,
      savedSelection: { selection, parameters, availability: { state: "enabled" } },
    });
    const changed = await restored.command(
      "/api/v1/accounts/" + scope.accountId + "/connection/edit",
      {
        displayName: "Gateway",
        expectedRecordRevision: connection.recordRevision,
        apiKey: "fictional-new-key",
        providerId: connection.providerId,
        offeringId: connection.offeringId,
      },
    );
    expect(changed.status).toBe(200);
    const rebound = (await (await restored.app.request(prefix + "snapshot")).json()).value;
    expect(rebound.catalogs[0]).toMatchObject({
      catalog: { state: "not-loaded" },
      entries: [{ presence: "missing" }],
    });
    expect(rebound.savedSelection.availability.state).toBe("disabled");
  });
  it("coalesces concurrent refreshes and discards a response arriving after the endpoint changes", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upstream = vi.fn(async () => {
      await waiting;
      return Response.json({ data: [{ id: "old-model" }] });
    });
    const graph = await fixture(await temporaryDirectory(), cipher(), {
      http: { fetch: upstream },
    });
    const { connection, editUrl } = await relay(
      graph.command,
      "Edge",
      "https://one.invalid/v1",
      "edge",
    );
    const accountId = connection.accountId,
      protocol = "openai-chat";
    const input = {
      accountId,
      protocol,
      expectedBindingRevision: connection.routes[0].bindingRevision,
    };
    const requests = [
      graph.command(prefix + "catalogs/refresh", input),
      graph.command(prefix + "catalogs/refresh", input),
    ];
    try {
      await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
      const edit = await editUrl("https://two.invalid/v1");
      expect(edit.ok).toBe(true);
    } finally {
      release();
    }
    for (const r of await Promise.all(requests)) expect(r.status).toBe(409);
    const snap = await (await graph.app.request(prefix + "snapshot")).json();
    expect(snap.value.catalogs[0]).toMatchObject({
      entries: [],
      refreshing: false,
      catalog: { state: "not-loaded" },
    });
  });
});

describe("2B model configuration transactions", () => {
  it("shares offering defaults, freezes an in-flight budget, reconciles one receipt and isolates account overrides", async () => {
    let started!: () => void, finish!: () => void;
    const pending = new Promise<void>((r) => (started = r)),
      gate = new Promise<void>((r) => (finish = r));
    const budgets: number[] = [];
    const graph = await fixture(await temporaryDirectory(), cipher(), {
      http: {
        fetch: async (url, init) => {
          if (String(url).endsWith("/models"))
            return Response.json({
              data: [{ id: "gpt-4.1-mini" }, { id: "unverified-model" }, { id: "gpt-image-1" }],
            });
          const payload = JSON.parse(String(init?.body));
          budgets.push(payload.max_completion_tokens ?? payload.max_tokens);
          if (budgets.length === 1) {
            started();
            await gate;
          }
          return Response.json({
            choices: [{ message: { content: "ok" } }],
            usage: {
              prompt_tokens: 10000,
              completion_tokens: 1000,
              prompt_tokens_details: { cached_tokens: 6000 },
            },
          });
        },
      },
    });
    const make = async (id: string) => {
      const r = await graph.command("/api/v1/accounts/connections/create", {
        operationId: id,
        providerId: "codex",
        offeringId: "openai-api-key",
        apiKey: fictionalSecret,
        displayName: id,
      });
      expect(r.status).toBe(200);
      return (await r.json()).value as PublicConnection;
    };
    const a = await make("officialA"),
      b = await make("officialB");
    const route = (c: PublicConnection) =>
      c.routes.find((r) => r.protocol === "openai-chat")!.bindingRevision;
    const sel = (c: PublicConnection) => ({
      providerId: c.providerId,
      accountId: c.accountId,
      protocol: "openai-chat",
      modelId: "gpt-4.1-mini",
    });
    const root = "/api/v1/graph-agent/models/";
    const snap = async () =>
      (await (await graph.app.request(root + "snapshot")).json()).value as GraphModelSnapshot;
    const command = async (path: string, input: Record<string, unknown>) => {
      const r = await graph.command(root + path, input),
        result = await r.json();
      expect(r.status, JSON.stringify(result.error)).toBe(200);
      return result.value as GraphModelSnapshot;
    };
    for (const c of [a, b])
      await command("catalogs/refresh", {
        accountId: c.accountId,
        protocol: "openai-chat",
        expectedBindingRevision: route(c),
      });
    const draft = async (c: PublicConnection, scope: string, value: number) => {
      const s = await snap();
      return {
        selection: sel(c),
        scope,
        expectedBindingRevision: route(c),
        expectedSettingsRevision: s.settingsRevision,
        changes: [],
        priceChanges: [],
        parameterChanges: [{ field: "maxOutputTokens", operation: "set", value }],
      };
    };
    const catalog = (snap: GraphModelSnapshot, id: string) =>
      snap.catalogs.find((c) => c.accountId === id && c.protocol === "openai-chat")!;
    const unknown = () => ({ ...sel(b), modelId: "unverified-model" }),
      image = () => ({ ...sel(b), modelId: "gpt-image-1" });
    const status = (snap: GraphModelSnapshot, modelId: string) =>
      catalog(snap, b.accountId).entries.find((e) => e.selection.modelId === modelId)!.actions
        .select.state;
    expect(status(await snap(), "unverified-model")).toBe("disabled");
    expect(status(await snap(), "gpt-image-1")).toBe("disabled");
    for (const selection of [unknown(), image()])
      await command("entries/edit", {
        selection,
        expectedBindingRevision: route(b),
        expectedSettingsRevision: (await snap()).settingsRevision,
        change: { operation: "upsert", displayName: selection.modelId },
      });
    expect(status(await snap(), "unverified-model")).toBe("enabled");
    expect(status(await snap(), "gpt-image-1")).toBe("disabled");
    let s = await command("draft/save", await draft(a, "offering", 2048));
    const entry = (snap: GraphModelSnapshot, id: string) =>
      snap.catalogs.find((c) => c.accountId === id && c.protocol === "openai-chat")!.entries[0];
    expect(entry(s, b.accountId).parameters.maxOutputTokens).toBe(2048);
    s = await command("selection/save", {
      expectedSettingsRevision: s.settingsRevision,
      choice: { selection: sel(b), expectedBindingRevision: route(b) },
    });
    const send = (s: GraphModelSnapshot) =>
      graph.command(testChatPath, {
        expectedSettingsRevision: s.settingsRevision,
        expectedBindingRevision: route(b),
        prompt: "test",
      });
    const first = send(s);
    try {
      await pending;
      const candidate = await draft(b, "account", 1024);
      const old = await snap();
      const preview = await graph.command(root + "request-preview", {
        selection: sel(b),
        expectedBindingRevision: route(b),
        expectedSettingsRevision: old.settingsRevision,
        operation: "chat",
        parameters: { effort: null, maxOutputTokens: null, contextWindow: null },
        draft: { ...candidate, instanceId: old.stamp.instanceId, contextId: old.backend.contextId },
      });
      expect(preview.status).toBe(200);
      expect((await snap()).settingsRevision).toBe(old.settingsRevision);
      s = await command("draft/save", candidate);
      expect(entry(s, a.accountId).parameters.maxOutputTokens).toBe(2048);
    } finally {
      finish();
    }
    const answered = await (await first).json();
    expect(answered.ok).toBe(true);
    expect((await send(s)).status).toBe(200);
    expect(budgets).toEqual([2048, 1024]);
    const callId = answered.value.callId;
    graph.services.chat.applyReceipt(callId, {
      amount: "0.015",
      currency: "USD",
      eventId: "event-1",
    });
    graph.services.chat.applyReceipt(callId, {
      amount: "0.015",
      currency: "USD",
      eventId: "event-1",
    });
    const result = await graph.command(testChatPath + "/charge", { callId });
    expect((await result.json()).value).toMatchObject({ amount: "0.015", status: "actual" });
    expect((await graph.command(testChatPath + "/close", { callId })).status).toBe(200);
    expect((await graph.command(testChatPath + "/charge", { callId })).status).toBe(404);
  });
  it("validates media model/endpoint pairs and stores the same upstream ID independently on generation and edits", async () => {
    const graph = await fixture(await temporaryDirectory(), cipher());
    const routeIds = ["openai-images-generations", "openai-images-edits"];
    const created = (
      await (
        await graph.command("/api/v1/graph-agent/custom-providers/create", {
          name: "Images",
          operationId: "media",
          offerings: [
            {
              offeringId: "us",
              name: "US",
              routes: routeIds.map((protocol) => ({
                protocol,
                baseUrl: "https://images.example/v1",
              })),
            },
          ],
        })
      ).json()
    ).value;
    const reply = await graph.command("/api/v1/accounts/connections/create", {
      displayName: "images",
      operationId: "media-account",
      providerId: created.providerId,
      offeringId: "us",
      apiKey: fictionalSecret,
    });
    const c = (await reply.json()).value as PublicConnection;
    let revision = (await (await graph.app.request("/api/v1/graph-agent/models/snapshot")).json())
      .value.settingsRevision;
    for (const r of c.routes) {
      const selection = {
        providerId: c.providerId,
        accountId: c.accountId,
        protocol: r.protocol,
        modelId: "image-id",
      };
      const input = {
        selection,
        expectedBindingRevision: r.bindingRevision,
        expectedSettingsRevision: revision,
      };
      const edit = (modelType: string) =>
        graph.command("/api/v1/graph-agent/models/entries/edit", {
          ...input,
          change: { operation: "upsert", displayName: "Images", modelType },
        });
      expect((await edit("tts")).status).toBe(400);
      const result = await edit("image");
      expect(result.status).toBe(200);
      const snapshot = (await result.json()).value as GraphModelSnapshot;
      revision = snapshot.settingsRevision;
      const entry = snapshot.catalogs.find((c) => c.protocol === r.protocol)!.entries[0];
      expect(entry.ioProfile).toBe(r.protocol.endsWith("edits") ? "edit" : "generate");
      expect(entry.actions.select.state).toBe("disabled");
      const draft: Record<string, unknown> = {
        ...input,
        expectedSettingsRevision: revision,
        presetKey: "openai/gpt-image-1",
        scope: "account",
        changes: [],
        priceChanges: [],
        parameterChanges: [{ field: "count", operation: "set", value: 11 }],
      };
      const failed = await graph.command("/api/v1/graph-agent/models/draft/save", draft);
      expect(failed.status).toBe(400);
      expect((await failed.json()).error.fields[0].path).toBe("count");
      draft.parameterChanges = [{ field: "count", operation: "set", value: 2 }];
      const saved = await graph.command("/api/v1/graph-agent/models/draft/save", draft);
      expect(saved.status).toBe(200);
      const updated = (await saved.json()).value as GraphModelSnapshot;
      revision = updated.settingsRevision;
      expect(updated.catalogs.find((c) => c.protocol === r.protocol)!.entries[0]).toMatchObject({
        parameterTemplate: { id: "image.gpt-image-1" },
        parameters: { count: 2 },
      });
    }
    expect(graph.upstream).not.toHaveBeenCalled();
  });
});

describe("2B model packs", () => {
  it("checks all shard digests and manifest references atomically, updates from the admin source, and reopens the selected revision", async () => {
    const directory = await temporaryDirectory();
    const pack = readModelPackDirectory(new URL("../resources/model-presets/", import.meta.url));
    const next = { ...pack, revision: "fixture-update" };
    const http = { fetch: vi.fn(async () => Response.json(next)) };
    vi.stubEnv("GRAPH_AGENT_MODEL_PACK_URL", "https://packs.example.test/models.json");
    try {
      const graph = await fixture(directory, cipher(), { http });
      const root = "/api/v1/graph-agent/models/";
      const snapshot = async () =>
        (await (await graph.app.request(root + "snapshot")).json()).value as GraphModelSnapshot;
      const change = async (action: string, extra: Record<string, unknown> = {}) =>
        graph.command(root + "packs/change", {
          expectedSettingsRevision: (await snapshot()).settingsRevision,
          action,
          ...extra,
        });
      const initial = await snapshot();
      expect(initial.pack.active).toBe(pack.revision);
      const expanded = structuredClone(pack);
      expanded.revision = "large-local-fixture";
      const file = expanded.files.find((f) => f.path === "families/openai.json")!;
      const example = file.presets[0] as Record<string, unknown>;
      for (let i = 0; i < 140; i++)
        file.presets.push({ ...example, key: "fixture/" + i, modelId: "fixture-" + i });
      // 与校验器同口径：摘要在 {presets, templates?, sources?, rateCards?} 全量上计算。
      file.sha256 = createHash("sha256")
        .update(
          JSON.stringify({
            presets: file.presets,
            ...(file.templates !== undefined && { templates: file.templates }),
            ...(file.sources !== undefined && { sources: file.sources }),
            ...(file.rateCards !== undefined && { rateCards: file.rateCards }),
          }),
        )
        .digest("hex");
      const manifestEntry = expanded.manifest.find((m) => m.path === file.path)!;
      manifestEntry.sha256 = file.sha256;
      expect(Buffer.byteLength(JSON.stringify(expanded))).toBeGreaterThan(65536);
      const imported = await change("import", { pack: expanded });
      expect(imported.status, JSON.stringify((await imported.json()).error)).toBe(200);
      expect((await change("rollback")).status).toBe(200);
      const beforeInvalid = (await snapshot()).settingsRevision;
      expect(
        await (await change("import", { pack: { ...next, files: next.files.slice(1) } })).json(),
      ).toMatchObject({ ok: false });
      const corrupt = structuredClone(next);
      const dataShard = corrupt.files.find((f) => f.presets.length)!;
      (dataShard.presets[0] as { displayName: unknown }).displayName = "tampered";
      expect((await change("import", { pack: corrupt })).status).toBe(400);
      expect((await snapshot()).settingsRevision).toBe(beforeInvalid);
      expect(await (await change("update")).json()).toMatchObject({
        value: { pack: { active: "fixture-update", previous: pack.revision } },
      });
      expect(http.fetch).toHaveBeenCalledTimes(1);
      expect((await change("rollback")).status).toBe(200);
      await graph.services.stop();
      const restored = await fixture(directory, cipher());
      const reopened = await (await restored.app.request(root + "snapshot")).json();
      expect(reopened.value.pack).toMatchObject({
        active: pack.revision,
        previous: "fixture-update",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("single-turn receipt lookup", () => {
  it("replaces a local estimate when the authorized OpenRouter generation lookup resolves after the answer", async () => {
    const urls: string[] = [];
    const graph = await fixture(await temporaryDirectory(), cipher(), {
      http: {
        fetch: async (url, init) => {
          const u = new URL(String(url));
          urls.push(u.pathname);
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + fictionalSecret);
          if (u.pathname === "/api/v1/generation") {
            expect(u.searchParams.get("id")).toBe("gen-sample1");
            return Response.json({ data: { id: "gen-sample1", total_cost: 0.015 } });
          }
          return Response.json({
            id: "gen-sample1",
            choices: [{ message: { content: "done" } }],
            usage: { prompt_tokens: 1, completion_tokens: 2 },
          });
        },
      },
    });
    const { connection } = await relay(
      graph.command,
      "router",
      "https://openrouter.ai/api/v1",
      "router",
    );
    const root = "/api/v1/graph-agent/models/";
    const selection = {
      providerId: connection.providerId,
      accountId: connection.accountId,
      protocol: "openai-chat",
      modelId: "some-model",
    };
    const bind = { selection, expectedBindingRevision: connection.routes[0].bindingRevision };
    const get = async () =>
      (await (await graph.app.request(root + "snapshot")).json()).value.settingsRevision;
    await graph.command(root + "entries/edit", {
      ...bind,
      expectedSettingsRevision: await get(),
      change: { operation: "upsert", displayName: "some-model" },
    });
    const rateCard = {
      rateCardId: "sample",
      revision: "one",
      currency: "USD",
      chargeLines: [
        { lineId: "req", meter: "requests", amount: "0.02", per: { quantity: 1, unit: "request" } },
      ],
      overrides: [],
      entitlements: [],
    };
    await graph.command(root + "draft/save", {
      ...bind,
      expectedSettingsRevision: await get(),
      scope: "account",
      changes: [],
      priceChanges: [],
      parameterChanges: [],
      rateCard,
    });
    await graph.command(root + "selection/save", {
      expectedSettingsRevision: await get(),
      choice: bind,
    });
    const answer = (
      await (
        await graph.command(testChatPath, {
          expectedSettingsRevision: await get(),
          expectedBindingRevision: bind.expectedBindingRevision,
          prompt: "question",
        })
      ).json()
    ).value;
    expect(answer.charge).toMatchObject({ amount: "0.02", status: "estimated" });
    await vi.waitFor(
      async () => {
        const r = await graph.command(testChatPath + "/charge", { callId: answer.callId });
        expect((await r.json()).value).toMatchObject({ status: "actual", amount: "0.015" });
      },
      { timeout: 4500, interval: 125 },
    );
    expect(urls).toEqual(["/api/v1/chat/completions", "/api/v1/generation"]);
    expect((await graph.command(testChatPath + "/close", { callId: answer.callId })).status).toBe(
      200,
    );
  });
});

describe("model tariff overrides", () => {
  it("uses the active tariff's base token price for display and estimation and keeps other tariffs and conditions intact", async () => {
    const graph = await fixture(await temporaryDirectory(), cipher());
    const { connection } = await relay(
      graph.command,
      "relay",
      "https://rates.example/v1",
      "tariffAccount",
    );
    const root = "/api/v1/graph-agent/models/";
    const selection = {
      providerId: connection.providerId,
      accountId: connection.accountId,
      protocol: "openai-chat",
      modelId: "m",
    };
    const binding = { selection, expectedBindingRevision: connection.routes[0].bindingRevision };
    const revision = async () =>
      (await (await graph.app.request(root + "snapshot")).json()).value.settingsRevision;
    await graph.command(root + "entries/edit", {
      ...binding,
      expectedSettingsRevision: await revision(),
      change: { operation: "upsert", displayName: "demo" },
    });
    const save = async (patch: Record<string, unknown>) => {
      const response = await graph.command(root + "draft/save", {
        ...binding,
        expectedSettingsRevision: await revision(),
        scope: "account",
        changes: [],
        parameterChanges: [],
        priceChanges: [],
        ...patch,
      });
      const data = await response.json();
      expect(response.status, JSON.stringify(data.error)).toBe(200);
      return (data.value as GraphModelSnapshot).catalogs[0].entries[0];
    };
    const key = {
      kind: "input",
      unit: "1M tokens",
      currency: "USD",
      tier: null,
      durationSeconds: null,
    };
    const card = (id: string, amount: string) => ({
      rateCardId: id,
      revision: "r1",
      currency: "USD",
      chargeLines: [
        {
          lineId: "vendor-input",
          meter: "uncachedInputTokens",
          amount,
          per: { quantity: 1_000_000, unit: "tokens" },
        },
      ],
      overrides: [
        {
          ruleId: "bulk",
          mode: "replace",
          when: { meter: "inputTokens", above: 2_000_000 },
          setAmounts: { "vendor-input": "1" },
        },
      ],
      entitlements: [],
    });
    const estimate = async (entry: ModelEntryView, inputTokens: number) => {
      const r = await graph.command(root + "pricing/estimate", {
        rateCard: entry.rateCard,
        workload: { meters: { inputTokens } },
      });
      expect(r.status).toBe(200);
      return (await r.json()).value.subtotal;
    };
    let entry = await save({ rateCard: card("quote", "2") });
    expect(entry.prices[0].amount.value).toBe("2");
    entry = await save({ priceChanges: [{ operation: "set", key, amount: "5" }] });
    expect(entry.prices[0].amount.value).toBe("5");
    expect(await estimate(entry, 1_000_000)).toBe("5");
    expect(await estimate(entry, 3_000_000)).toBe("3");
    expect(entry.rateCard?.revision).not.toBe("r1");
    entry = await save({ ratePlanKey: "other", rateCard: card("other", "7") });
    expect(await estimate(entry, 1_000_000)).toBe("7");
    entry = await save({ ratePlanKey: "default", priceChanges: [{ key, operation: "clear" }] });
    expect(await estimate(entry, 1_000_000)).toBe("2");
    expect(entry.rateCard?.revision).toBe("r1");
    entry = await save({ priceChanges: [{ operation: "set", key, amount: null }] });
    expect(entry.rateCard?.chargeLines[0].amount).toBeNull();
    entry = await save({ rateCard: card("quote", "4") });
    expect(entry.prices[0].amount.value).toBe("4");
    expect(await estimate(entry, 1_000_000)).toBe("4");
  });
});

describe("provider request policy, preview and proxy boundaries", () => {
  const modelRoot = "/api/v1/graph-agent/models/";

  it("omits ruleHeaders from preview, decrypts zero credentials on local/built-in preview, and allows simplified rule/policy extensions", async () => {
    const protection = cipher();
    const decrypt = vi.spyOn(protection, "decrypt");
    const graph = await fixture(await temporaryDirectory(), protection);

    const created = await graph.command("/api/v1/graph-agent/custom-providers/create", {
      name: "Policy Relay",
      icon: null,
      operationId: "policy-relay",
      familyPolicies: {
        openai: {
          headers: {
            "x-cache-key": "cache-1",
            "http-referer": "https://app.example",
          },
        },
      },
      offerings: [
        {
          offeringId: "main",
          name: "Main",
          routes: [
            {
              protocol: "openai-chat",
              baseUrl: "https://policy-relay.invalid/v1",
              requestRule: {
                operation: "chat",
                aliases: { work: "upstream/work-v1" },
                headers: { "x-idempotency-key": "idem-route" },
                body: { metadata: { store_id: "store-42", include_meta: true } },
              },
            },
          ],
        },
      ],
    });
    const createdBody = await created.json();
    expect(created.status, JSON.stringify(createdBody.error)).toBe(200);
    const provider = createdBody.value;

    const conn: PublicConnection = (
      await (
        await graph.command("/api/v1/accounts/connections/create", {
          providerId: provider.providerId,
          offeringId: "main",
          operationId: "policy-account",
          displayName: "Policy Account",
          apiKey: fictionalSecret,
        })
      ).json()
    ).value;

    const initial = (await (await graph.app.request(modelRoot + "snapshot")).json())
      .value as GraphModelSnapshot;
    const selection = {
      providerId: provider.providerId,
      accountId: conn.accountId,
      protocol: "openai-chat" as const,
      modelId: "work",
    };
    const bindingRevision = conn.routes[0].bindingRevision;
    const registered = (
      await (
        await graph.command(modelRoot + "entries/edit", {
          selection,
          expectedBindingRevision: bindingRevision,
          expectedSettingsRevision: initial.settingsRevision,
          change: { operation: "upsert", displayName: "Work Model" },
        })
      ).json()
    ).value as GraphModelSnapshot;

    decrypt.mockClear();
    const previewRes = await graph.command(modelRoot + "request-preview", {
      selection,
      expectedBindingRevision: bindingRevision,
      expectedSettingsRevision: registered.settingsRevision,
      operation: "chat",
      parameters: { effort: null, contextWindow: null, maxOutputTokens: 256 },
    });
    const previewBody = await previewRes.json();
    expect(previewRes.status, JSON.stringify(previewBody.error)).toBe(200);
    expect(previewBody.value).not.toHaveProperty("ruleHeaders");
    expect(previewBody.value.upstreamModelId).toBe("upstream/work-v1");
    expect(previewBody.value.body.metadata).toEqual({ store_id: "store-42", include_meta: true });
    expect(previewBody.value.headers["x-idempotency-key"]).toBe("idem-route");
    expect(previewBody.value.headers["x-cache-key"]).toBe("cache-1");
    expect(previewBody.value.headers["http-referer"]).toBe("https://app.example");
    expect(decrypt).not.toHaveBeenCalled();

    const builtin: PublicConnection = (
      await (
        await graph.command("/api/v1/accounts/connections/create", {
          providerId: "deepseek",
          offeringId: "deepseek-api-key",
          operationId: "ds-preview-zero-decrypt",
          displayName: "DeepSeek Builtin",
          apiKey: fictionalSecret,
          routes: [],
        })
      ).json()
    ).value;
    const dsChat = builtin.routes.find((r) => r.protocol === "openai-chat")!;
    const dsSelection = {
      providerId: "deepseek",
      accountId: builtin.accountId,
      protocol: "openai-chat" as const,
      modelId: "deepseek-chat",
    };
    const dsRegistered = (
      await (
        await graph.command(modelRoot + "entries/edit", {
          selection: dsSelection,
          expectedBindingRevision: dsChat.bindingRevision,
          expectedSettingsRevision: registered.settingsRevision,
          change: { operation: "upsert", displayName: "DeepSeek Chat" },
        })
      ).json()
    ).value as GraphModelSnapshot;

    decrypt.mockClear();
    const dsPreviewRes = await graph.command(modelRoot + "request-preview", {
      selection: dsSelection,
      expectedBindingRevision: dsChat.bindingRevision,
      expectedSettingsRevision: dsRegistered.settingsRevision,
      operation: "chat",
      parameters: {
        thinkingEnabled: true,
        returnFullReasoning: true,
        effort: "high",
        contextWindow: null,
        maxOutputTokens: 512,
      },
    });
    const dsPreview = await dsPreviewRes.json();
    expect(dsPreviewRes.status, JSON.stringify(dsPreview.error)).toBe(200);
    expect(dsPreview.value).not.toHaveProperty("ruleHeaders");
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("allows native proxy bodies above 64 KB up to 4 MB, rejects above 4 MB, and decrypts credentials once only after validation", async () => {
    const protection = cipher();
    const decrypt = vi.spyOn(protection, "decrypt");
    let upstreamCalls = 0;
    const graph = await fixture(await temporaryDirectory(), protection, {
      http: {
        fetch: async () => {
          upstreamCalls++;
          return Response.json({
            choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          });
        },
      },
    });
    const { connection } = await relay(
      graph.command,
      "Large Body Relay",
      "https://large-proxy.invalid/v1",
      "large-proxy",
    );
    const snap = (await (await graph.app.request(modelRoot + "snapshot")).json())
      .value as GraphModelSnapshot;
    const selection = {
      providerId: connection.providerId,
      accountId: connection.accountId,
      protocol: "openai-chat" as const,
      modelId: "large/model",
    };
    const bindingRevision = connection.routes[0].bindingRevision;
    const registered = (
      await (
        await graph.command(modelRoot + "entries/edit", {
          selection,
          expectedBindingRevision: bindingRevision,
          expectedSettingsRevision: snap.settingsRevision,
          change: { operation: "upsert", displayName: "Large Model" },
        })
      ).json()
    ).value as GraphModelSnapshot;
    const saved = (
      await (
        await graph.command(modelRoot + "selection/save", {
          expectedSettingsRevision: registered.settingsRevision,
          choice: { selection, expectedBindingRevision: bindingRevision },
        })
      ).json()
    ).value as GraphModelSnapshot;

    const headers = {
      "Content-Type": "application/json",
      "X-GraphAgent-Instance-Id": saved.stamp.instanceId,
      "X-GraphAgent-Context-Id": saved.backend.contextId,
      "X-GraphAgent-Settings-Revision": saved.settingsRevision,
      "X-GraphAgent-Binding-Revision": bindingRevision,
    };
    const send = (payload: string) =>
      graph.app.request("/api/v1/graph-agent/proxy/openai/v1/chat/completions", {
        method: "POST",
        headers,
        body: payload,
      });

    decrypt.mockClear();
    const invalidModel = await send(
      JSON.stringify({ model: "wrong/model", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(invalidModel.status).toBe(409);
    expect(decrypt).not.toHaveBeenCalled();
    expect(upstreamCalls).toBe(0);

    const largePayload = JSON.stringify({
      model: "large/model",
      messages: [{ role: "user", content: "a".repeat(80 * 1024) }],
    });
    expect(Buffer.byteLength(largePayload)).toBeGreaterThan(64 * 1024);
    const largeOk = await send(largePayload);
    expect(largeOk.status).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(decrypt).toHaveBeenCalledTimes(1);

    decrypt.mockClear();
    const tooLarge = await send(
      JSON.stringify({
        model: "large/model",
        messages: [{ role: "user", content: "a".repeat(4 * 1024 * 1024 + 1) }],
      }),
    );
    expect(tooLarge.status).toBe(400);
    expect(decrypt).not.toHaveBeenCalled();
    expect(upstreamCalls).toBe(1);
  });

  it("applies DeepSeek 3-protocol policy on official and custom URLs while isolating same-URL custom-* providers", async () => {
    const graph = await fixture(await temporaryDirectory(), cipher());
    const cmd = async (action: string, fields: Record<string, unknown>) => {
      const response = await graph.command(modelRoot + action, fields);
      const parsed = await response.json();
      expect(response.status, JSON.stringify(parsed.error)).toBe(200);
      return parsed.value;
    };

    const official: PublicConnection = (
      await (
        await graph.command("/api/v1/accounts/connections/create", {
          providerId: "deepseek",
          offeringId: "deepseek-api-key",
          operationId: "ds-official-3p",
          displayName: "DeepSeek Official",
          apiKey: fictionalSecret,
          routes: [],
        })
      ).json()
    ).value;
    expect(official.routes.map((r) => r.protocol).sort()).toEqual([
      "anthropic-messages",
      "openai-chat",
      "openai-responses",
    ]);

    let snap = (await (await graph.app.request(modelRoot + "snapshot")).json())
      .value as GraphModelSnapshot;
    const registerAndPreview = async (
      conn: PublicConnection,
      protocol: "openai-chat" | "openai-responses" | "anthropic-messages",
      modelId: string,
      parameters: Record<string, unknown>,
      factsChanges: Record<string, unknown>[] = [],
    ) => {
      const route = conn.routes.find((r) => r.protocol === protocol)!;
      const selection = {
        providerId: conn.providerId,
        accountId: conn.accountId,
        protocol,
        modelId,
      };
      snap = await cmd("entries/edit", {
        selection,
        expectedBindingRevision: route.bindingRevision,
        expectedSettingsRevision: snap.settingsRevision,
        change: { operation: "upsert", displayName: modelId },
      });
      if (factsChanges.length) {
        snap = await cmd("draft/save", {
          selection,
          expectedBindingRevision: route.bindingRevision,
          expectedSettingsRevision: snap.settingsRevision,
          scope: "account",
          changes: factsChanges,
          priceChanges: [],
          parameterChanges: [],
        });
      }
      return cmd("request-preview", {
        selection,
        expectedBindingRevision: route.bindingRevision,
        expectedSettingsRevision: snap.settingsRevision,
        operation: "chat",
        parameters,
      });
    };

    const enabledParams = {
      thinkingEnabled: true,
      returnFullReasoning: true,
      effort: "high",
      contextWindow: null,
      maxOutputTokens: 512,
    };
    const disabledParams = {
      thinkingEnabled: false,
      returnFullReasoning: true,
      effort: "high",
      contextWindow: null,
      maxOutputTokens: 512,
    };

    // 1. openai-chat
    const chatOn = await registerAndPreview(
      official,
      "openai-chat",
      "deepseek-flash",
      enabledParams,
    );
    expect(chatOn.body).toMatchObject({
      model: "deepseek-flash",
      max_tokens: 512,
      reasoning_effort: "high",
      thinking: { type: "enabled" },
    });
    expect(chatOn.body).not.toHaveProperty("max_completion_tokens");
    const chatOff = await registerAndPreview(
      official,
      "openai-chat",
      "deepseek-flash",
      disabledParams,
    );
    expect(chatOff.body).toMatchObject({ max_tokens: 512, thinking: { type: "disabled" } });
    expect(chatOff.body).not.toHaveProperty("reasoning_effort");
    const chatNone = await registerAndPreview(
      official,
      "openai-chat",
      "deepseek-plain",
      enabledParams,
      [{ field: "reasoningMode", operation: "set", value: "none" }],
    );
    expect(chatNone.body).not.toHaveProperty("thinking");
    expect(chatNone.body).not.toHaveProperty("reasoning_effort");

    // 2. openai-responses
    const respOn = await registerAndPreview(
      official,
      "openai-responses",
      "deepseek-flash",
      enabledParams,
    );
    expect(respOn.body).toMatchObject({
      model: "deepseek-flash",
      max_output_tokens: 512,
      reasoning: { effort: "high" },
    });
    expect(respOn.body.reasoning).not.toHaveProperty("summary");
    const respOff = await registerAndPreview(
      official,
      "openai-responses",
      "deepseek-flash",
      disabledParams,
    );
    expect(respOff.body).toMatchObject({
      max_output_tokens: 512,
      reasoning: { effort: "none" },
    });
    const respNone = await registerAndPreview(
      official,
      "openai-responses",
      "deepseek-plain",
      enabledParams,
      [{ field: "reasoningMode", operation: "set", value: "none" }],
    );
    expect(respNone.body).not.toHaveProperty("reasoning");

    // 3. anthropic-messages
    const anthOn = await registerAndPreview(
      official,
      "anthropic-messages",
      "deepseek-flash",
      enabledParams,
    );
    expect(anthOn.body).toMatchObject({
      model: "deepseek-flash",
      max_tokens: 512,
      output_config: { effort: "high" },
      thinking: { type: "enabled" },
    });
    expect(anthOn.body.thinking).not.toHaveProperty("display");
    const anthOff = await registerAndPreview(
      official,
      "anthropic-messages",
      "deepseek-flash",
      disabledParams,
    );
    expect(anthOff.body).toMatchObject({ max_tokens: 512, thinking: { type: "disabled" } });
    expect(anthOff.body).not.toHaveProperty("output_config");
    const anthNone = await registerAndPreview(
      official,
      "anthropic-messages",
      "deepseek-plain",
      enabledParams,
      [{ field: "reasoningMode", operation: "set", value: "none" }],
    );
    expect(anthNone.body).not.toHaveProperty("thinking");
    expect(anthNone.body).not.toHaveProperty("output_config");

    // 4. Built-in deepseek with custom gateway URL still uses DeepSeek policy
    const customUrlDs: PublicConnection = (
      await (
        await graph.command("/api/v1/accounts/connections/create", {
          providerId: "deepseek",
          offeringId: "deepseek-api-key",
          operationId: "ds-custom-url",
          displayName: "DeepSeek Gateway",
          apiKey: fictionalSecret,
          routes: [{ protocol: "openai-chat", baseUrl: "https://ds-gateway.invalid/v1" }],
        })
      ).json()
    ).value;
    const customUrlPreview = await registerAndPreview(
      customUrlDs,
      "openai-chat",
      "deepseek-flash",
      enabledParams,
    );
    expect(customUrlPreview.baseUrl).toBe("https://ds-gateway.invalid/v1");
    expect(customUrlPreview.body).toMatchObject({
      max_tokens: 512,
      thinking: { type: "enabled" },
    });

    // 5. Same-URL custom-* generic provider pointing to https://api.deepseek.com is isolated
    const { connection: genericDs } = await relay(
      graph.command,
      "Generic Same URL",
      "https://api.deepseek.com",
      "generic-same-url-ds",
    );
    const genericPreview = await registerAndPreview(genericDs, "openai-chat", "deepseek-flash", {
      ...enabledParams,
      returnFullReasoning: false,
    });
    expect(genericPreview.body).not.toHaveProperty("thinking");
    expect(genericPreview.body.max_completion_tokens).toBe(512);
    const genericOff = await registerAndPreview(
      genericDs,
      "openai-chat",
      "deepseek-flash",
      disabledParams,
    );
    expect(genericOff.body).not.toHaveProperty("thinking");
  });

  it("enforces zero hardcoded vendor special-casing in contract, shared-ui connection/service code, and graph-agent orchestration files", async () => {
    const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const vendorPattern = /\b(?:deepseek|codex|claude|grok-build|openrouter)\b/i;

    async function collectFiles(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const results: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...(await collectFiles(full)));
        else if (/\.(?:ts|vue)$/.test(entry.name)) results.push(full);
      }
      return results;
    }

    const contractFiles = await collectFiles(path.join(workspaceRoot, "packages/contract/src"));
    const sharedUiFiles = (
      await collectFiles(path.join(workspaceRoot, "packages/shared-ui/src"))
    ).filter((file) => {
      const base = path.basename(file);
      // presentation.ts maps static brand icons; ProvidersPage.vue sets the initial accordion key.
      return base !== "presentation.ts" && base !== "ProvidersPage.vue";
    });
    const orchestrationFiles = [
      "apps/graph-agent/src/server/model-resolution.ts",
      "apps/graph-agent/src/server/model-service.ts",
      "apps/graph-agent/src/server/chat-service.ts",
      "apps/graph-agent/src/server/native-proxy.ts",
    ].map((rel) => path.join(workspaceRoot, rel));

    for (const file of [...contractFiles, ...sharedUiFiles, ...orchestrationFiles]) {
      const content = await readFile(file, "utf8");
      const match = vendorPattern.exec(content);
      expect(
        match,
        `Unexpected vendor reference "${match?.[0]}" in ${path.relative(workspaceRoot, file)}`,
      ).toBeNull();
    }
  });
});

describe("Batch 2 protocol-family catalog decoupling and Gemini provider", () => {
  it("discovers models for a non-chat-only OpenAI family and shares one FamilyCatalogView across multiple endpoints", async () => {
    const directory = await temporaryDirectory(),
      protection = cipher();
    let modelCalls = 0;
    const http: GraphServicesOptions["http"] = {
      async fetch(url) {
        modelCalls++;
        expect(String(url)).toMatch(/\/v1\/models$/);
        return Response.json({
          object: "list",
          data: [{ id: "gpt-4o" }, { id: "gpt-image-1" }],
        });
      },
    };
    const graph = await fixture(directory, protection, { http });

    // 1. Non-chat-only custom provider (openai-images-generations only)
    const imageOnly = (
      await (
        await graph.command("/api/v1/graph-agent/custom-providers/create", {
          operationId: "image-only-provider",
          name: "Image Relay",
          icon: null,
          templateKind: "generic",
          offerings: [
            {
              name: "Images",
              offeringId: "images",
              routes: [
                { protocol: "openai-images-generations", baseUrl: "https://img.example/v1" },
              ],
            },
          ],
        })
      ).json()
    ).value;
    const imageConn: PublicConnection = (
      await (
        await graph.command("/api/v1/accounts/connections/create", {
          providerId: imageOnly.providerId,
          offeringId: "images",
          displayName: "Img Key",
          operationId: "img-key-1",
          apiKey: fictionalSecret,
        })
      ).json()
    ).value;

    const imgRefresh = await graph.command("/api/v1/graph-agent/models/catalogs/refresh", {
      accountId: imageConn.accountId,
      protocolFamily: "openai",
      expectedFamilyBindingRevision: imageConn.routes[0].familyBindingRevision,
    });
    expect(imgRefresh.status).toBe(200);
    const imgSnap = (await imgRefresh.json()).value as GraphModelSnapshot;
    const imgFamily = imgSnap.familyCatalogs.find(
      (f) => f.accountId === imageConn.accountId && f.protocolFamily === "openai",
    );
    expect(imgFamily).toBeDefined();
    expect(imgFamily!.refresh.state).toBe("enabled");
    expect(imgFamily!.models.map((m) => m.modelId)).toEqual(["gpt-4o", "gpt-image-1"]);

    // 2. Multi-endpoint OpenAI family shares 1 FamilyCatalogView across chat + responses + images
    const multi = (
      await (
        await graph.command("/api/v1/graph-agent/custom-providers/create", {
          operationId: "multi-openai-provider",
          name: "Multi OpenAI",
          icon: null,
          templateKind: "generic",
          offerings: [
            {
              name: "Unified",
              offeringId: "unified",
              routes: [
                { protocol: "openai-chat", baseUrl: "https://multi.example/v1" },
                { protocol: "openai-responses", baseUrl: "https://multi.example/v1" },
                { protocol: "openai-images-generations", baseUrl: "https://multi.example/v1" },
              ],
            },
          ],
        })
      ).json()
    ).value;
    const multiConn: PublicConnection = (
      await (
        await graph.command("/api/v1/accounts/connections/create", {
          providerId: multi.providerId,
          offeringId: "unified",
          displayName: "Multi Key",
          operationId: "multi-key-1",
          apiKey: fictionalSecret,
        })
      ).json()
    ).value;

    modelCalls = 0;
    const multiRefresh = await graph.command("/api/v1/graph-agent/models/catalogs/refresh", {
      accountId: multiConn.accountId,
      protocolFamily: "openai",
      expectedFamilyBindingRevision: multiConn.routes[0].familyBindingRevision,
    });
    expect(multiRefresh.status).toBe(200);
    expect(modelCalls).toBe(1);
    const multiSnap = (await multiRefresh.json()).value as GraphModelSnapshot;
    const multiFamilies = multiSnap.familyCatalogs.filter(
      (f) => f.accountId === multiConn.accountId,
    );
    expect(multiFamilies).toHaveLength(1);
    expect(multiFamilies[0].endpoints.map((e) => e.protocol)).toEqual([
      "openai-chat",
      "openai-responses",
      "openai-images-generations",
    ]);
    expect(multiFamilies[0].models).toMatchObject([
      {
        modelId: "gpt-4o",
        availableProtocols: ["openai-chat", "openai-responses", "openai-images-generations"],
      },
      {
        modelId: "gpt-image-1",
        availableProtocols: ["openai-chat", "openai-responses", "openai-images-generations"],
      },
    ]);
    const chatCatalog = multiSnap.catalogs.find(
      (c) => c.accountId === multiConn.accountId && c.protocol === "openai-chat",
    );
    expect(chatCatalog?.entries[0]?.parameterTemplate.fields.effort?.choices).toContain("high");
  });

  it("discovers Gemini /v1beta/models across pages and previews gemini-generate-content requests", async () => {
    const directory = await temporaryDirectory(),
      protection = cipher();
    const http: GraphServicesOptions["http"] = {
      async fetch(url, init) {
        const parsed = new URL(String(url));
        expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(fictionalSecret);
        if (!parsed.searchParams.get("pageToken")) {
          return Response.json({
            models: [
              {
                name: "models/gemini-2.5-pro",
                displayName: "Gemini 2.5 Pro",
                inputTokenLimit: 1048576,
                outputTokenLimit: 65536,
                thinking: true,
                supportedGenerationMethods: ["generateContent"],
              },
            ],
            nextPageToken: "next-p2",
          });
        }
        expect(parsed.searchParams.get("pageToken")).toBe("next-p2");
        return Response.json({
          models: [
            {
              name: "models/gemini-2.5-flash-preview-tts",
              displayName: "Gemini 2.5 Flash TTS",
              supportedGenerationMethods: ["generateContent"],
            },
            {
              name: "models/text-embedding-004",
              displayName: "Text Embedding 004",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
        });
      },
    };
    const graph = await fixture(directory, protection, { http });
    const created: PublicConnection = (
      await (
        await graph.command("/api/v1/accounts/connections/create", {
          providerId: "gemini",
          offeringId: "gemini-api-key",
          displayName: "Google Gemini",
          operationId: "gemini-e2e-1",
          apiKey: fictionalSecret,
          routes: [],
        })
      ).json()
    ).value;
    expect(created.routes.map((r) => r.protocol)).toEqual([
      "gemini-generate-content",
      "gemini-tts",
    ]);

    const refreshed = await graph.command("/api/v1/graph-agent/models/catalogs/refresh", {
      accountId: created.accountId,
      protocolFamily: "gemini",
      expectedFamilyBindingRevision: created.routes[0].familyBindingRevision,
    });
    expect(refreshed.status).toBe(200);
    const snap = (await refreshed.json()).value as GraphModelSnapshot;
    const gemFamily = snap.familyCatalogs.find(
      (f) => f.accountId === created.accountId && f.protocolFamily === "gemini",
    );
    expect(gemFamily).toBeDefined();
    expect(gemFamily!.endpoints.map((e) => e.protocol)).toEqual([
      "gemini-generate-content",
      "gemini-tts",
    ]);
    expect(gemFamily!.models).toMatchObject([
      { modelId: "gemini-2.5-flash-preview-tts", availableProtocols: ["gemini-tts"] },
      { modelId: "gemini-2.5-pro", availableProtocols: ["gemini-generate-content"] },
    ]);

    const chatRoute = created.routes.find((r) => r.protocol === "gemini-generate-content")!;
    const previewRes = await graph.command("/api/v1/graph-agent/models/request-preview", {
      selection: {
        accountId: created.accountId,
        providerId: "gemini",
        protocol: "gemini-generate-content",
        modelId: "gemini-2.5-pro",
      },
      expectedBindingRevision: chatRoute.bindingRevision,
      expectedSettingsRevision: snap.settingsRevision,
      operation: "chat",
      parameters: {
        contextWindow: null,
        maxOutputTokens: 2048,
        effort: "medium",
        thinkingEnabled: true,
      },
    });
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()).value;
    expect(preview.relativePath).toBe("models/gemini-2.5-pro:generateContent");
    expect(preview.headers["x-goog-api-key"]).toBe("<redacted>");
    expect(preview.body).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "Hello from GraphAgent." }] }],
      generationConfig: { maxOutputTokens: 2048 },
    });
  });
});
