import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { CredentialCipherPort } from "@astra-conductor/core/internal";
import { createGraphServices } from "../src/server/services.js";
import type { GraphServicesOptions } from "../src/server/services.js";
import { BrokerError } from "@astra-conductor/credentials";
import { createGraphHonoApp } from "../src/server/create-hono-app.js";
import { startGraphServer } from "../src/platform/node/start-server.js";
import { claimGraphProfile } from "../src/platform/storage.js";
import { createGraphBrokerHost } from "../src/platform/broker-host.js";

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

async function pendingImport(directory: string, protection: CredentialCipherPort) {
  const version = {
    vaultId: "vault",
    storageVersion: "version",
    attemptId: "attempt",
    keyId: "key",
  };
  const sharingDirectory = path.join(directory, "credential-sharing");
  await mkdir(sharingDirectory);
  await writeFile(
    path.join(sharingDirectory, "cached.key"),
    await protection.encrypt(
      JSON.stringify({ version, masterKey: Buffer.alloc(32, 9).toString("base64url") }),
    ),
  );
  await writeFile(
    path.join(sharingDirectory, "binding.json"),
    JSON.stringify({
      state: "import-ready",
      vaultDirectory: directory,
      clientId: "existing-graph-client",
      version,
      sourceWatermark: "watermark",
      keyRef: "cached.key",
      accounts: [],
    }),
  );
  const control = {
    ownership: "source",
    poll: undefined as (() => Promise<void>) | undefined,
  };
  const host: GraphServicesOptions["host"] = {
    localPackageDirectory: directory,
    inspect: async () => ({
      installState: "installed",
      installedVersion: "1.0.0",
      installationDirectory: directory,
    }),
    install: async () => undefined,
    uninstall: async () => undefined,
    connect: async () => {
      await control.poll?.();
      return {
        close() {},
        call: async (method) => {
          if (method === "getSharingState")
            return {
              ...version,
              sourceWatermark: "watermark",
              ownership: control.ownership,
              preparedClientIds: ["existing-graph-client"],
            };
          throw new Error("unexpected broker method");
        },
      };
    },
  };
  return { host, control, sharingDirectory };
}

describe("GraphAgent common provider host", () => {
  it.each(["automatic", "manual"] as const)(
    "restores pending imports as private and drains refresh before %s handoff",
    async (trigger) => {
      const directory = await temporaryDirectory();
      const protection = cipher();
      const transfer = {
        vaultId: "vault",
        storageVersion: "version",
        attemptId: "attempt",
        keyId: "key",
      };
      const sharingDirectory = path.join(directory, "credential-sharing");
      await mkdir(sharingDirectory);
      await writeFile(
        path.join(sharingDirectory, "cached.key"),
        await protection.encrypt(
          JSON.stringify({
            version: transfer,
            masterKey: Buffer.alloc(32, 9).toString("base64url"),
          }),
        ),
      );
      await writeFile(
        path.join(sharingDirectory, "binding.json"),
        JSON.stringify({
          state: "import-ready",
          vaultDirectory: directory,
          clientId: "existing-graph-client",
          version: transfer,
          sourceWatermark: "watermark",
          keyRef: "cached.key",
          accounts: [
            {
              id: "shared-preview",
              provider: "codex",
              maskedIdentifier: "shared***",
              canRefresh: true,
              revision: "1",
            },
          ],
        }),
      );
      let ownership = "source";
      let offline = false;
      const host: GraphServicesOptions["host"] = {
        localPackageDirectory: directory,
        inspect: async () => ({
          installState: "installed",
          installedVersion: "1.0.0",
          installationDirectory: directory,
        }),
        status: async () => ({ serviceState: "READY", brokerOwnership: ownership }),
        install: async () => undefined,
        uninstall: async () => undefined,
        connect: async () => {
          if (offline) throw new BrokerError("broker-disconnected");
          return {
            close() {},
            call: async (method) => {
              if (method === "getSharingState")
                return {
                  ...transfer,
                  sourceWatermark: "watermark",
                  ownership,
                  preparedClientIds: ["existing-graph-client"],
                };
              if (method === "listCredentials") return { items: [], nextCursor: null };
              if (method === "watchEvents") {
                await new Promise((resolve) => setTimeout(resolve, 20));
                return { items: [], nextCursor: "0" };
              }
              if (method === "disconnect") return {};
              throw new Error("unexpected broker method");
            },
          };
        },
      };
      const jwt = `header.${Buffer.from(JSON.stringify({ email: "fixture@example.test", sub: "fixture" })).toString("base64url")}.signature`;
      const graph = await fixture(directory, protection, {
        host,
        files: {
          readText: async () =>
            JSON.stringify({
              tokens: {
                id_token: jwt,
                access_token: "fictional-access",
                refresh_token: "fictional-refresh",
                account_id: "fixture",
              },
            }),
        },
      });
      expect((await graph.snapshot()).backend).toMatchObject({
        selected: "private",
        active: "private",
      });
      const pending = await (await graph.app.request("/api/v1/credential-sharing/status")).json();
      expect(pending.value).toMatchObject({
        selectedBackend: "private",
        activeBackend: "private",
        importState: "import-ready",
        sharingState: "handoff-pending",
        connected: false,
        accounts: [{ id: "shared-preview" }],
        capabilities: { retry: { state: "enabled" } },
      });
      expect(
        (
          await graph.command("/api/v1/auth/sessions/start", {
            offeringId: "bigmodel-coding-plan",
            method: "api-key",
            apiKey: fictionalSecret,
          })
        ).status,
      ).toBe(200);
      expect((await graph.snapshot()).accounts).toHaveLength(1);
      const imported = await graph.command("/api/v1/auth/sessions/start", {
        offeringId: "codex",
        method: "cli-import",
      });
      const privateId = (await imported.json()).value.account.id as string;
      let finishRefresh!: () => void;
      let startedRefresh!: () => void;
      const entered = new Promise<void>((resolve) => {
        startedRefresh = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        finishRefresh = resolve;
      });
      graph.services.runtime.providers.getAccount("codex")!.refreshCredentials = async (
        _account,
        envelope,
      ) => {
        startedRefresh();
        await blocked;
        return {
          changed: true,
          envelope: {
            ...envelope,
            secrets: { ...envelope.secrets, accessToken: "fictional-refreshed-private" },
          },
        };
      };
      const refresh = graph.services.providers.refreshCredentials(privateId);
      await entered;
      ownership = "broker";
      const activation = vi.spyOn(graph.services.runtime, "activate");
      const switching = trigger === "manual" ? graph.services.credentials.retry() : undefined;
      try {
        await vi.waitFor(
          async () => {
            const current = await graph.snapshot();
            expect(current.backend.active).toBe("private");
            expect(current.actions.startAuth.state).toBe("disabled");
          },
          { timeout: 5000 },
        );
        if (trigger === "manual") {
          await expect(async () =>
            graph.services.credentials.confirmImport("other-preview"),
          ).rejects.toMatchObject({
            code: "operation-in-progress",
          });
          expect(
            (
              await graph.command("/api/v1/auth/sessions/start", {
                offeringId: "bigmodel-coding-plan",
                method: "api-key",
                apiKey: fictionalSecret,
              })
            ).status,
          ).toBe(409);
          // The automatic watcher must not activate through a manual retry's pending drain.
          await new Promise((resolve) => setTimeout(resolve, 3200));
          expect((await graph.snapshot()).backend.active).toBe("private");
        }
        expect(activation).not.toHaveBeenCalled();
      } finally {
        finishRefresh();
      }
      expect((await refresh).status).toBe("updated");
      await switching;
      await vi.waitFor(async () => expect((await graph.snapshot()).backend.active).toBe("shared"));
      expect((await graph.snapshot()).backend).toMatchObject({
        selected: "shared",
        active: "shared",
      });
      expect((await graph.snapshot()).accounts).toHaveLength(0);
      expect(
        JSON.parse(await readFile(path.join(directory, "private-business.json"), "utf8")).accounts,
      ).toHaveLength(2);
      await graph.services.stop();
      offline = true;
      const restored = await fixture(directory, protection, { host });
      expect((await restored.snapshot()).backend).toMatchObject({
        selected: "shared",
        active: "unavailable",
      });
      expect((await restored.snapshot()).actions.startAuth.state).toBe("disabled");
      expect((await restored.snapshot()).accounts).toHaveLength(0);
    },
    10000,
  );
  it("keeps private authorization available throughout a slow pending-import poll", async () => {
    const directory = await temporaryDirectory();
    const protection = cipher();
    const { host, control } = await pendingImport(directory, protection);
    const graph = await fixture(directory, protection, { host });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    control.poll = async () => {
      entered();
      await blocked;
    };
    const polling = graph.services.credentials.retry();
    await started;
    try {
      expect((await graph.snapshot()).actions.startAuth.state).toBe("enabled");
      expect(
        (
          await graph.command("/api/v1/auth/sessions/start", {
            offeringId: "bigmodel-coding-plan",
            method: "api-key",
            apiKey: fictionalSecret,
          })
        ).status,
      ).toBe(200);
      expect((await graph.snapshot()).backend.active).toBe("private");
    } finally {
      release();
      await polling;
    }
  });
  it("rejects a shared switch before changing a pending private authorization's backend", async () => {
    const directory = await temporaryDirectory();
    const protection = cipher();
    const { host, control, sharingDirectory } = await pendingImport(directory, protection);
    const graph = await fixture(directory, protection, { host });
    const facet = graph.services.runtime.providers.getAccount("codex")!;
    vi.spyOn(facet, "startAuth").mockResolvedValue({
      status: "pending",
      interaction: "device-code",
      userCode: "TEST-CODE",
      verificationUri: "https://example.invalid/verify",
      cancel() {},
      finish: async () => {
        throw new Error("not expected");
      },
    });
    const started = await graph.command("/api/v1/auth/sessions/start", {
      offeringId: "codex",
      method: "device-code",
    });
    const sessionId = (await started.json()).value.sessionId;
    control.ownership = "broker";
    await expect(graph.services.credentials.retry()).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      JSON.parse(await readFile(path.join(sharingDirectory, "binding.json"), "utf8")).state,
    ).toBe("import-ready");
    await expect(
      graph.services.runtime.activate({ vaultDirectory: directory, clientId: "client" }, () => {}),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await graph.snapshot()).backend.active).toBe("private");
    expect((await graph.command(`/api/v1/auth/sessions/${sessionId}/cancel`)).status).toBe(200);
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
    expect(await readFile(path.join(directory, "private-business.json"), "utf8")).not.toContain(
      fictionalSecret,
    );
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
    expect(response.status).toBe(409);
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
            if (method === "getSharingState") return { ownership: "broker" };
            if (method === "listCredentials") return { items: [], nextCursor: null };
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
