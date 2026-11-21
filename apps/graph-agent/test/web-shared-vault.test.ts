import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrokerError } from "@astra-conductor/credentials";
import type { CredentialCipherPort } from "@astra-conductor/core/internal";
import { createGraphHonoApp } from "../src/server/create-hono-app.js";
import { createGraphServices, type GraphServicesOptions } from "../src/server/services.js";
import {
  readBrokerBinding,
  resolveWebBrokerBinding,
  writeBrokerBinding,
} from "../src/platform/broker-binding.js";
import { claimGraphProfile } from "../src/platform/storage.js";
import { startGraphServer } from "../src/platform/node/start-server.js";

const roots: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
beforeEach(async () => {
  // Host startup should see a clean broker installation regardless of the developer's machine.
  vi.stubEnv("LOCALAPPDATA", await temporaryDirectory());
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const stop of cleanup.splice(0)) await stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-web-vault-"));
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

async function fixture(directory: string, overrides: Partial<GraphServicesOptions> = {}) {
  const connections: Array<{ vault: string; clientId: string; existingGrantOnly?: boolean }> = [];
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
      connect: async (vault, clientId, _instanceId, options) => {
        connections.push({ vault, clientId, existingGrantOnly: options?.existingGrantOnly });
        return {
          close() {},
          call: async (method: string) => {
            if (method === "status") return { ownership: "broker" };
            if (method === "listCredentials") return { items: [], nextCursor: null };
            if (method === "getSnapshotWatermark")
              return { vaultId: "vault", storageVersion: "version", watermark: "a".repeat(64) };
            if (method === "disconnect") return {};
            throw new BrokerError("forbidden");
          },
        };
      },
    },
    http: { fetch: async () => new Response("{}") },
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
  const command = async (route: string, body: Record<string, unknown> = {}) => {
    const current = await (await app.request("/api/v1/providers")).json();
    return app.request(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: current.value.instanceId,
        contextId: current.value.backend.contextId,
        ...body,
      }),
    });
  };
  const status = async () =>
    (await (await app.request("/api/v1/credential-sharing/status")).json()).value;
  return { services, app, command, status, connections };
}

async function pair() {
  const root = await temporaryDirectory();
  const profile = path.join(root, "profile");
  const vault = path.join(root, "vault");
  await mkdir(profile);
  await mkdir(vault);
  await writeFile(path.join(vault, "manifest.json"), JSON.stringify({ vaultId: "vault" }));
  return { profile, vault };
}

async function grant(profile: string, name: string) {
  const directory = path.join(profile, "credential-sharing");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, name), "");
}

describe("GraphAgent web shared vault", () => {
  it.runIf(process.platform === "win32")(
    "uses the desktop profile by default and respects an explicit Web profile",
    async () => {
      const root = await temporaryDirectory();
      const env = { APPDATA: root };
      const desktopDirectory = path.join(root, "GraphAgent");
      const release = claimGraphProfile(desktopDirectory);
      try {
        await expect(startGraphServer({ port: 0, env })).rejects.toThrow(
          "GraphAgent 数据目录正在使用",
        );
        const isolated = await startGraphServer({
          port: 0,
          env: { ...env, GRAPH_AGENT_DATA_DIR: path.join(root, "web") },
        });
        cleanup.push(() => isolated.stop());
        expect(isolated.directory).toBe(path.join(root, "web"));
      } finally {
        release();
      }
      const web = await startGraphServer({ port: 0, env });
      cleanup.push(() => web.stop());
      expect(web.directory).toBe(desktopDirectory);
      expect(() => claimGraphProfile(desktopDirectory)).toThrow("GraphAgent 数据目录正在使用");
    },
  );

  it("listens with no directory, disables credential use, and keeps a damaged record from blocking startup", async () => {
    const directory = await temporaryDirectory();
    const server = await startGraphServer({ port: 0, directory, env: {} });
    cleanup.push(() => server.stop());
    expect((await fetch(`${server.url}/api/v1/providers`)).status).toBe(200);
    const status = await (await fetch(`${server.url}/api/v1/credential-sharing/status`)).json();
    expect(status.value).toMatchObject({
      vaultDirectory: null,
      lastError: null,
      directorySelectionAvailable: true,
      role: "receiver",
      migrationState: null,
      privateAvailable: false,
      activeBackend: "unavailable",
      capabilities: {
        adoptVault: { state: "enabled" },
        retry: { state: "disabled", reason: "请先接入已授权的共享目录" },
        verifyImport: { state: "hidden" },
        confirmImport: { state: "hidden" },
      },
    });
    const denied = await fetch(`${server.url}/api/v1/auth/sessions/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: status.value.instanceId,
        contextId: status.value.contextId,
        offeringId: "bigmodel-coding-plan",
        method: "api-key",
        apiKey: "fictional-stage-one-key-123456789",
      }),
    });
    expect(denied.status).toBe(503);
    expect(await readdir(directory)).not.toContain("private-business.json");
    await server.stop();

    await writeFile(path.join(directory, "broker-binding.json"), "{");
    const damaged = await startGraphServer({ port: 0, directory, env: {} });
    cleanup.push(() => damaged.stop());
    const damagedStatus = await (
      await fetch(`${damaged.url}/api/v1/credential-sharing/status`)
    ).json();
    expect(damagedStatus.value).toMatchObject({
      vaultDirectory: null,
      lastError: "已记住的共享目录配置无效",
    });
    expect(await readFile(path.join(directory, "broker-binding.json"), "utf8")).toBe("{");

    const web = await fixture(await temporaryDirectory());
    const picker = await web.command("/api/v1/credential-sharing/select-directory");
    expect(picker.status).toBe(501);
    expect(await picker.json()).toMatchObject({
      ok: false,
      error: { code: "desktop-unavailable", message: "当前宿主不能打开目录选择器" },
    });
    const retry = await web.command("/api/v1/credential-sharing/retry");
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({
      ok: false,
      error: { message: "请先接入已授权的共享目录" },
    });
  });

  it("lets a paired env override this process and restores the saved record on the next start", async () => {
    const directory = await temporaryDirectory();
    const saved = { vaultDirectory: "D:/shared/other-vault", clientId: "other-client" };
    writeBrokerBinding(directory, saved);
    const before = await readFile(path.join(directory, "broker-binding.json"), "utf8");
    await expect(
      startGraphServer({
        port: 0,
        directory,
        env: { GRAPH_AGENT_BROKER_VAULT: "D:/shared/acme-vault" },
      }),
    ).rejects.toThrow("GraphAgent broker vault and client id must be configured together");
    expect(await readFile(path.join(directory, "broker-binding.json"), "utf8")).toBe(before);
    const release = claimGraphProfile(directory);
    release();

    const overridden = await startGraphServer({
      port: 0,
      directory,
      env: {
        GRAPH_AGENT_BROKER_VAULT: "D:/shared/acme-vault",
        GRAPH_AGENT_BROKER_CLIENT_ID: "graph-agent-demo",
      },
    });
    cleanup.push(() => overridden.stop());
    const during = await (await fetch(`${overridden.url}/api/v1/credential-sharing/status`)).json();
    expect(during.value.vaultDirectory).toBe(path.resolve("D:/shared/acme-vault"));
    expect(during.value.lastError).toBeNull();
    expect(await readFile(path.join(directory, "broker-binding.json"), "utf8")).toBe(before);
    await overridden.stop();

    const restored = await startGraphServer({ port: 0, directory, env: {} });
    cleanup.push(() => restored.stop());
    const after = await (await fetch(`${restored.url}/api/v1/credential-sharing/status`)).json();
    expect(after.value.vaultDirectory).toBe(saved.vaultDirectory);
    expect(readBrokerBinding(directory)).toEqual({ state: "ok", binding: saved });
    await restored.stop();
    const resolved = resolveWebBrokerBinding(directory, {});
    const web = await fixture(directory, { brokerBinding: resolved.binding });
    const remembered = {
      vault: saved.vaultDirectory,
      clientId: saved.clientId,
      existingGrantOnly: true,
    };
    expect(web.connections.length).toBeGreaterThan(0);
    expect(web.connections).toEqual(web.connections.map(() => remembered));
  });

  it("adopts the only matching grant and retries with the saved binding", async () => {
    const { profile, vault } = await pair();
    await grant(profile, "vault.not an id.dpapi");
    await grant(profile, "vault.graph-agent-demo.dpapi");
    const web = await fixture(profile);
    const adopted = await web.command("/api/v1/credential-sharing/adopt", {
      vaultDirectory: vault,
    });
    expect(adopted.status).toBe(200);
    expect(await adopted.json()).toEqual({ ok: true, value: null });
    const canonical = await realpath(vault);
    expect(readBrokerBinding(profile)).toEqual({
      state: "ok",
      binding: { vaultDirectory: canonical, clientId: "graph-agent-demo" },
    });
    expect(await web.status()).toMatchObject({
      vaultDirectory: canonical,
      activeBackend: "shared",
      lastError: null,
    });
    const adoptedBinding = {
      vault: canonical,
      clientId: "graph-agent-demo",
      existingGrantOnly: true,
    };
    expect(web.connections.length).toBeGreaterThan(0);
    expect(web.connections).toEqual(web.connections.map(() => adoptedBinding));
    const connected = web.connections.length;
    const retried = await web.command("/api/v1/credential-sharing/retry");
    expect(retried.status).toBe(200);
    expect(web.connections.length).toBeGreaterThan(connected);
    expect(web.connections).toEqual(web.connections.map(() => adoptedBinding));
  });

  it("returns the section 7.2 errors and does not write a record", async () => {
    const { profile, vault } = await pair();
    const web = await fixture(profile);
    const missing = await web.command("/api/v1/credential-sharing/adopt", {
      vaultDirectory: vault,
    });
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({
      ok: false,
      error: { code: "access-denied", message: "本 profile 没有该共享库的客户端授权" },
    });
    await grant(profile, "vault.one.dpapi");
    await grant(profile, "vault.two.dpapi");
    const many = await web.command("/api/v1/credential-sharing/adopt", { vaultDirectory: vault });
    expect(many.status).toBe(400);
    expect(await many.json()).toMatchObject({
      ok: false,
      error: { code: "validation", message: "有多个客户端授权，请指定客户端身份" },
    });
    const chosen = await web.command("/api/v1/credential-sharing/adopt", {
      vaultDirectory: vault,
      clientId: "missing-client",
    });
    expect(chosen.status).toBe(403);
    const nested = path.join(profile, "nested-vault");
    await mkdir(nested);
    await writeFile(path.join(nested, "manifest.json"), JSON.stringify({ vaultId: "vault" }));
    const overlap = await web.command("/api/v1/credential-sharing/adopt", {
      vaultDirectory: nested,
    });
    expect(overlap.status).toBe(400);
    expect(await overlap.json()).toMatchObject({
      ok: false,
      error: {
        code: "overlapping-product-and-vault-paths",
        message: "共享目录不能位于本产品数据目录之内，也不能包含本产品数据目录",
      },
    });
    const empty = path.join(path.dirname(profile), "empty-vault");
    await mkdir(empty);
    const absent = await web.command("/api/v1/credential-sharing/adopt", {
      vaultDirectory: empty,
    });
    expect(absent.status).toBe(400);
    expect(await absent.json()).toMatchObject({
      ok: false,
      error: { code: "vault-directory-missing", message: "所选目录没有共享库清单" },
    });
    expect(readBrokerBinding(profile)).toEqual({ state: "missing" });
    expect(web.connections).toEqual([]);
  });

  it("keeps Electron migration on the dialog port and away from the web binding file", async () => {
    const directory = await temporaryDirectory();
    const saved = { vaultDirectory: "D:/shared/other-vault", clientId: "other-client" };
    writeBrokerBinding(directory, saved);
    const before = await readFile(path.join(directory, "broker-binding.json"), "utf8");
    let requests = 0;
    const desktop = await fixture(directory, {
      cipher: cipher(),
      brokerBinding: saved,
      directoryPicker: {
        async selectDirectory(request) {
          requests += 1;
          expect(request).toEqual({ title: "选择共享凭据目录", confirmLabel: "选择此文件夹" });
          return "D:\\chosen";
        },
      },
    });
    const selected = await desktop.command("/api/v1/credential-sharing/select-directory");
    expect(selected.status).toBe(200);
    expect(await selected.json()).toEqual({ ok: true, value: "D:\\chosen" });
    expect(requests).toBe(1);
    const adopted = await desktop.command("/api/v1/credential-sharing/adopt", {
      vaultDirectory: "D:/shared/acme-vault",
    });
    expect(adopted.status).toBe(409);
    expect(await adopted.json()).toMatchObject({
      ok: false,
      error: { code: "capability-unavailable", message: "当前宿主不提供此凭据操作" },
    });
    expect(await desktop.status()).toMatchObject({ migrationState: "private" });
    expect(await readFile(path.join(directory, "broker-binding.json"), "utf8")).toBe(before);
    expect(desktop.connections).toEqual([]);

    const graphElectron = readFileSync(
      fileURLToPath(new URL("../src/platform/electron/main.ts", import.meta.url)),
      "utf8",
    );
    const polyquotaElectron = readFileSync(
      fileURLToPath(
        new URL(
          "../../polyquota/src/platform/electron/register-electron-services.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    for (const source of [graphElectron, polyquotaElectron]) {
      expect(source).toContain("createElectronDirectoryPicker(dialog, BrowserWindow)");
      expect(source).not.toContain("showOpenDialog");
      expect(source).not.toContain("broker-binding");
    }
  });
});
