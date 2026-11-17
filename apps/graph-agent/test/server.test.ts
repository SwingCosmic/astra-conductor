import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { CredentialCipherPort } from "@astra-conductor/core/internal";
import { createGraphServices } from "../src/server/services.js";
import type { GraphServicesOptions } from "../src/server/services.js";
import { BrokerError } from "@astra-conductor/credentials";
import { createGraphHonoApp } from "../src/server/create-hono-app.js";
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
    expect(() => claimGraphProfile(directory)).toThrow("already in use");
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
  const routes = [{ protocolRouteId: "openai-chat", baseUrl }];
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
        offerings: [
          { ...draft.offerings[0], routes: [{ protocolRouteId: "openai-chat", baseUrl: url }] },
        ],
      }),
  };
}

describe("GraphAgent single-turn chat route", () => {
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
      protocolRouteId: "openai-chat",
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
  it("returns field diagnostics for invalid settings before looking up a credential", async () => {
    const graph = await fixture(await temporaryDirectory(), cipher());
    const response = await graph.command(prefix + "selection/save", {
      expectedSettingsRevision: "0",
      choice: {
        selection: {
          accountId: "account",
          providerId: "provider",
          modelId: "model",
          protocolRouteId: "openai-chat",
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
      protocolRouteId: "openai-chat",
      expectedBindingRevision: connection.routes[0].bindingRevision,
    };
    const selection = {
      providerId: connection.providerId,
      accountId: scope.accountId,
      protocolRouteId: scope.protocolRouteId,
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
      protocolRouteId = "openai-chat";
    const input = {
      accountId,
      protocolRouteId,
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
      c.routes.find((r) => r.protocolRouteId === "openai-chat")!.bindingRevision;
    const sel = (c: PublicConnection) => ({
      providerId: c.providerId,
      accountId: c.accountId,
      protocolRouteId: "openai-chat",
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
        protocolRouteId: "openai-chat",
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
      snap.catalogs.find((c) => c.accountId === id && c.protocolRouteId === "openai-chat")!;
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
      snap.catalogs.find((c) => c.accountId === id && c.protocolRouteId === "openai-chat")!
        .entries[0];
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
              routes: routeIds.map((protocolRouteId) => ({
                protocolRouteId,
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
        protocolRouteId: r.protocolRouteId,
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
      const entry = snapshot.catalogs.find((c) => c.protocolRouteId === r.protocolRouteId)!
        .entries[0];
      expect(entry.profileId).toBe(r.protocolRouteId.endsWith("edits") ? "edit" : "generate");
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
      expect(
        updated.catalogs.find((c) => c.protocolRouteId === r.protocolRouteId)!.entries[0],
      ).toMatchObject({ parameterTemplate: { id: "image.gpt-image-1" }, parameters: { count: 2 } });
    }
    expect(graph.upstream).not.toHaveBeenCalled();
  });
});

describe("2B model packs", () => {
  it("checks all shard digests and manifest references atomically, updates from the admin source, and reopens the selected revision", async () => {
    const directory = await temporaryDirectory();
    const file = new URL("../resources/model-presets.json", import.meta.url);
    const pack = JSON.parse(await readFile(file, "utf8"));
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
      const file = expanded.files[0];
      const example = file.presets[0];
      for (let i = 0; i < 140; i++)
        file.presets.push({ ...example, key: "fixture/" + i, modelId: "fixture-" + i });
      file.sha256 = createHash("sha256")
        .update(JSON.stringify({ presets: file.presets }))
        .digest("hex");
      expanded.manifest[0].sha256 = file.sha256;
      expect(Buffer.byteLength(JSON.stringify(expanded))).toBeGreaterThan(65536);
      const imported = await change("import", { pack: expanded });
      expect(imported.status, JSON.stringify((await imported.json()).error)).toBe(200);
      expect((await change("rollback")).status).toBe(200);
      const beforeInvalid = (await snapshot()).settingsRevision;
      expect(
        await (await change("import", { pack: { ...next, files: next.files.slice(1) } })).json(),
      ).toMatchObject({ ok: false });
      const corrupt = structuredClone(next);
      corrupt.files[0].presets[0].displayName = "tampered";
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
      protocolRouteId: "openai-chat",
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
      protocolRouteId: "openai-chat",
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
