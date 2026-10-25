import type {
  PolyQuotaSnapshot,
  HostCapabilities,
  PublicError,
} from "@astra-conductor/polyquota-contract";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer } from "../src/platform/node/start-server.js";
import { rewriteRequest } from "../src/http/inbound-adapter.js";
import { ElectronProtocolAdapter } from "../src/platform/electron/protocol-adapter.js";
import { ElectronDynamicResourceService } from "../src/platform/electron/dynamic-resources.js";
import { errorStatus, publicError } from "../src/http/public-error.js";

const stops: (() => Promise<void>)[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function server() {
  const directory = await mkdtemp(path.join(tmpdir(), "polyquota-server-test-"));
  directories.push(directory);
  const instance = await startServer({ port: 0, dataDirectory: directory, env: {} });
  stops.push(() => instance.stop());
  return instance;
}

describe("service mode backend", () => {
  it("matches the documented route inventory and keeps refresh failures in successful business DTOs", async () => {
    const instance = await server();
    const routes = instance.app.routes
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`);
    expect(routes.sort()).toEqual(
      [
        "GET /v1/status",
        "GET /v1/host/capabilities",
        "POST /v1/host/window/show",
        "GET /v1/polyquota/snapshot",
        "GET /v1/polyquota/events",
        "POST /v1/polyquota/accounts/:accountId/set-enabled",
        "POST /v1/polyquota/accounts/:accountId/delete",
        "POST /v1/polyquota/accounts/:accountId/refresh",
        "POST /v1/polyquota/accounts/refresh-all",
        "POST /v1/polyquota/credentials/refresh",
        "POST /v1/polyquota/reset-credits/redeem",
        "POST /v1/polyquota/auth/sessions/start",
        "GET /v1/polyquota/auth/sessions/:sessionId",
        "POST /v1/polyquota/auth/sessions/:sessionId/finish",
        "POST /v1/polyquota/auth/sessions/:sessionId/cancel",
        "POST /v1/polyquota/settings/save",
        "GET /v1/polyquota/system-status",
        "POST /v1/notifications/:notificationId/acknowledge",
      ].sort(),
    );
    const refresh = vi.spyOn(instance.runtime.application, "refreshAccount").mockResolvedValue({
      status: "failed",
      accountId: "account-1",
      error: { code: "network", message: "public failure", retryable: true },
    });
    const response = await instance.app.request("/v1/polyquota/accounts/account-1/refresh", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, value: { status: "failed" } });
    expect(refresh).toHaveBeenCalledWith("account-1");
    const redeem = vi.spyOn(instance.runtime.application, "redeemResetCredit").mockResolvedValue({
      status: "redeemed",
      accountId: "account-1",
      refreshStatus: "updated",
      remainingResetCredits: null,
    });
    for (const redemption of [{ kind: "aggregate" }, { kind: "item", itemId: "item-1" }]) {
      const response = await instance.app.request("/v1/polyquota/reset-credits/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: "account-1", redemption }),
      });
      expect(response.status).toBe(200);
      expect(redeem).toHaveBeenLastCalledWith("account-1", redemption);
    }
  });

  it("rejects new work while stopping and drains accepted work before releasing SQLite and its owner", async () => {
    const instance = await server();
    let release!: () => void;
    const operation = instance.runtime.track(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const stop = instance.stop();
    expect(instance.runtime.state).toBe("stopping");
    expect((await instance.app.request("/v1/status")).status).toBe(503);
    await expect(instance.runtime.track(() => undefined)).rejects.toThrow("停止");
    await expect(
      startServer({ port: 0, dataDirectory: instance.dataDirectory, env: {} }),
    ).rejects.toThrow("owned");
    release();
    await operation;
    await stop;
    expect(instance.runtime.state).toBe("stopped");
    const next = await startServer({ port: 0, dataDirectory: instance.dataDirectory, env: {} });
    stops.push(() => next.stop());
  });

  it("runs real loopback HTTP, SQLite persistence, SSE and exclusive data ownership without Electron", async () => {
    const instance = await server();
    const initial = await fetch(`${instance.url}/v1/polyquota/snapshot`).then(
      (response) => response.json() as Promise<{ ok: true; value: PolyQuotaSnapshot }>,
    );
    expect(initial.value.providers).toHaveLength(7);
    expect(initial.value.instanceId).toBe(instance.runtime.application.instanceId);
    expect(
      (
        await fetch(`${instance.url}/v1/host/capabilities`).then(
          (response) => response.json() as Promise<{ ok: true; value: HostCapabilities }>,
        )
      ).value,
    ).toEqual({ desktop: false, notifications: "browser", credentials: false });
    await expect(
      startServer({ port: 0, dataDirectory: instance.dataDirectory, env: {} }),
    ).rejects.toThrow("owned");
    const abort = new AbortController();
    const response = await fetch(`${instance.url}/v1/polyquota/events`, { signal: abort.signal });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");
    const settings = {
      ...initial.value.settings,
      pollingEnabled: false,
      pollingIntervalMinutes: 23,
    };
    const saved = await fetch(`${instance.url}/v1/polyquota/settings/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    expect(await saved.json()).toEqual({ ok: true, value: null });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: changed");
    abort.abort();
    await reader.cancel().catch(() => undefined);
    await vi.waitFor(() => expect(instance.runtime.events.subscriberCount).toBe(1)); // runtime auth projection only
    await instance.stop();
    await instance.stop();
    const restarted = await startServer({
      port: 0,
      dataDirectory: instance.dataDirectory,
      env: {},
    });
    stops.push(() => restarted.stop());
    const snapshot = await fetch(`${restarted.url}/v1/polyquota/snapshot`).then(
      (value) => value.json() as Promise<{ ok: true; value: PolyQuotaSnapshot }>,
    );
    expect(snapshot.value.settings).toEqual(settings);
    expect(snapshot.value.instanceId).not.toBe(initial.value.instanceId);
    expect(snapshot.value.revision).toBeLessThan(initial.value.revision + 3);
  });

  it("rejects untrusted origins, Host headers, extra ids, malformed JSON and business bodies before mutation", async () => {
    const instance = await server();
    const save = vi.spyOn(instance.runtime.application, "saveSettings");
    const set = vi.spyOn(instance.runtime.application, "setAccountEnabled");
    for (const [route, body, type] of [
      [
        "accounts/account-1/set-enabled",
        '{"accountId":"account-2","enabled":true}',
        "application/json",
      ],
      ["accounts/account-1/delete", '{"unexpected":1}', "application/json"],
      ["settings/save", "{", "application/json"],
      ["settings/save", '{"pollingEnabled":false}', "text/plain"],
      ["auth/sessions/session-1/cancel", '{"sessionId":"session-2"}', "application/json"],
    ]) {
      const response = await fetch(`${instance.url}/v1/polyquota/${route}`, {
        method: "POST",
        headers: { "Content-Type": type },
        body,
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { ok: boolean }).ok).toBe(false);
    }
    expect(save).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(
      (await fetch(`${instance.url}/v1/status`, { headers: { Origin: "https://untrusted.test" } }))
        .status,
    ).toBe(403);
    const rejectedHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        `${instance.url}/v1/status`,
        { headers: { Host: "attacker.test" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(rejectedHost).toBe(403);
    const preflight = await fetch(`${instance.url}/v1/polyquota/settings/save`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    expect((await fetch(`${instance.url}/v1/host/window/show`, { method: "POST" })).status).toBe(
      501,
    );
    expect((await fetch(`${instance.url}/v1/polyquota/auth/sessions/unknown`)).status).toBe(404);
    expect((await fetch(`${instance.url}/api/v1/status`)).status).toBe(404);
  });

  it("keeps real CLI parsing available and fails precisely at the missing credential backend without saving", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "polyquota-cli-test-"));
    directories.push(directory);
    const cli = path.join(directory, "cli");
    await mkdir(cli);
    const jwt = `header.${Buffer.from(JSON.stringify({ email: "fixture@example.test", sub: "fixture-user" })).toString("base64url")}.signature`;
    const raw = JSON.stringify({
      tokens: {
        id_token: jwt,
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        account_id: "fixture-account",
      },
    });
    await writeFile(path.join(cli, "auth.json"), raw);
    const instance = await startServer({
      port: 0,
      dataDirectory: path.join(directory, "data"),
      env: { CODEX_HOME: cli },
    });
    stops.push(() => instance.stop());
    const result = await fetch(`${instance.url}/v1/polyquota/auth/sessions/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offeringId: "codex", method: "cli-import" }),
    });
    expect(result.status).toBe(503);
    expect(((await result.json()) as { error: PublicError }).error.code).toBe("secure-storage");
    expect(await readFile(path.join(cli, "auth.json"), "utf8")).toBe(raw);
    expect((await instance.runtime.application.getSnapshot()).accounts).toHaveLength(0);
  });

  it("preserves body, query, method and cancellation while stripping only the exact entrance prefix", async () => {
    const abort = new AbortController();
    const input = new Request("http://127.0.0.1/api/v1/status?q=test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"x":1}',
      signal: abort.signal,
    });
    const rewritten = rewriteRequest(input, "/api")!;
    expect(rewritten.url).toBe("http://127.0.0.1/v1/status?q=test");
    expect(rewritten.method).toBe("POST");
    expect(await rewritten.text()).toBe('{"x":1}');
    abort.abort();
    expect(rewritten.signal.aborted).toBe(true);
    expect(rewriteRequest(new Request("http://127.0.0.1/api-other/v1/status"), "/api")).toBeNull();
  });

  it("serves only registered dynamic resources and never falls back to the packaged UI", async () => {
    const instance = await server();
    const resourceRoot = instance.dataDirectory;
    await writeFile(path.join(resourceRoot, "icon.png"), new Uint8Array([1, 2, 3]));
    const resources = new ElectronDynamicResourceService(
      resourceRoot,
      new Map([
        ["icon", "icon.png"],
        ["escape", "../outside.png"],
        ["html", "index.html"],
      ]),
    );
    const adapter = new ElectronProtocolAdapter(instance.app, resources, new Set(["null"]));
    const response = await adapter.handle(
      new Request("polyquota-app://resources/icon", { headers: { Origin: "null" } }),
    );
    expect(response.headers.get("content-type")).toBe("image/png");
    expect((await response.arrayBuffer()).byteLength).toBe(3);
    const status = await adapter.handle(new Request("polyquota-app://app/v1/status"));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ ok: true });
    for (const url of [
      "polyquota-app://bad/v1/status",
      "polyquota-app://app/index.html",
      "polyquota-app://resources/unknown",
      "polyquota-app://resources/escape",
      "polyquota-app://resources/html",
      "polyquota-app://app/app/v1/status",
      "polyquota-app://app/resources/icon",
      "polyquota-app://resources/resources/icon",
      "polyquota-app://resources/v1/status",
      "polyquota-app://resources/icon?path=icon.png",
      "polyquota-app://resources/icon/other",
      "polyquota-app://app:123/v1/status",
      "https://app/v1/status",
    ])
      expect((await adapter.handle(new Request(url))).status).toBe(404);
    expect(
      (
        await adapter.handle(
          new Request("polyquota-app://app/v1/status", {
            headers: { Origin: "https://bad.test" },
          }),
        )
      ).status,
    ).toBe(403);
  });

  it.each([
    ["validation", 400],
    ["not-found", 404],
    ["conflict", 409],
    ["desktop-unavailable", 501],
    ["secure-storage", 503],
    ["service-unavailable", 503],
    ["network", 502],
    ["internal", 500],
  ] as const)("maps %s to %s and redacts unknown errors", (code, status) => {
    expect(errorStatus({ code, message: "public", retryable: false })).toBe(status);
    expect(JSON.stringify(publicError(new Error("token=do-not-leak")))).not.toContain(
      "do-not-leak",
    );
  });
});
