import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAntigravityAuthFlow,
  createCodexAuthFlow,
  createGlmAuthFlow,
  createGrokBuildAuthFlow,
  type Account,
  type OAuthCallbackHandler,
} from "../src/internal.js";

const account: Account = {
  id: "flow-account-1",
  provider: "codex",
  authMethod: "browser-oauth",
  stableIdentity: "personal:user-1",
  displayName: "user@example.test",
  maskedIdentifier: "us***@example.test",
  enabled: true,
  credentialState: "available",
  publicMetadata: {},
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
};

function provisionerFake() {
  return {
    save: vi
      .fn()
      .mockImplementation(async (input: unknown) => ({ ...account, credentials: input })),
  };
}

function callbackRecorder(onStart: (handler: OAuthCallbackHandler) => void = () => undefined) {
  return vi.fn(
    async (options: { port: number; handler: OAuthCallbackHandler }): Promise<{ port: number }> => {
      onStart(options.handler);
      return { port: options.port === 0 ? 45678 : options.port };
    },
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("codex auth flow", () => {
  it("imports from the Codex CLI auth file under CODEX_HOME", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "codex-home-"));
    await writeFile(path.join(home, "auth.json"), JSON.stringify({ tokens: "fixture" }));
    vi.stubEnv("CODEX_HOME", home);
    const fromCliAuth = vi.fn().mockReturnValue({ marker: "codex-provisioning" });
    const provisioner = provisionerFake();
    const flow = createCodexAuthFlow({
      adapter: { fromCliAuth } as never,
      provisioner,
      openExternal: vi.fn(),
      startCallbackServer: callbackRecorder(),
    });

    const result = await flow.start("cli-import", {});

    expect(result.status).toBe("completed");
    expect(fromCliAuth).toHaveBeenCalledWith({ tokens: "fixture" });
    expect(provisioner.save).toHaveBeenCalledWith({ marker: "codex-provisioning" });
    expect(result).toMatchObject({
      status: "completed",
      account: { credentials: { marker: "codex-provisioning" } },
    });
  });

  it("fails with the login hint when the CLI auth file is missing", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "codex-empty-"));
    vi.stubEnv("CODEX_HOME", home);
    const flow = createCodexAuthFlow({
      adapter: { fromCliAuth: vi.fn() } as never,
      provisioner: provisionerFake(),
      openExternal: vi.fn(),
      startCallbackServer: callbackRecorder(),
    });

    await expect(flow.start("cli-import", {})).rejects.toThrow(
      "无法读取 Codex CLI 凭据，请先运行 codex login",
    );
  });

  it("runs the browser login with the fixed redirect uri and late-bound state", async () => {
    const startCallbackServer = callbackRecorder();
    const createBrowserAuthorization = vi
      .fn()
      .mockReturnValue({ url: "https://auth.example.test/authorize", state: "st-9" });
    const finishBrowserAuthorization = vi
      .fn()
      .mockResolvedValue({ marker: "browser-provisioning" });
    const provisioner = provisionerFake();
    const openExternal = vi.fn();
    const flow = createCodexAuthFlow({
      adapter: { createBrowserAuthorization, finishBrowserAuthorization } as never,
      provisioner,
      openExternal,
      startCallbackServer,
    });

    const result = await flow.start("browser-oauth", {});

    expect(result.status).toBe("pending");
    expect(createBrowserAuthorization).toHaveBeenCalledWith("http://localhost:1455/auth/callback");
    expect(startCallbackServer).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 1455, handler: expect.anything() }),
    );
    expect(openExternal).toHaveBeenCalledWith("https://auth.example.test/authorize");
    if (result.status !== "pending") return;

    const handler = startCallbackServer.mock.calls[0]![0].handler;
    const response = handler.handleRequest({
      pathname: "/auth/callback",
      query: new URLSearchParams("code=c-1&state=st-9"),
    });
    expect(response.status).toBe(200);
    await expect(result.finish()).resolves.toMatchObject({
      credentials: { marker: "browser-provisioning" },
    });
    expect(finishBrowserAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ state: "st-9" }),
      "c-1",
    );
  });

  it("wraps callback listener failures with the provider label", async () => {
    const startCallbackServer = vi.fn().mockRejectedValue(new Error("EADDRINUSE"));
    const flow = createCodexAuthFlow({
      adapter: { createBrowserAuthorization: vi.fn() } as never,
      provisioner: provisionerFake(),
      openExternal: vi.fn(),
      startCallbackServer,
    });

    await expect(flow.start("browser-oauth", {})).rejects.toThrow("无法监听 codex 授权回调端口");
  });

  it("shows the plain verification uri and finishes through the device flow", async () => {
    const authorization = {
      deviceAuthId: "da-1",
      userCode: "WDJB-MJHT",
      intervalSec: 5,
      verificationUri: "https://example.test/device",
    };
    const requestDeviceAuthorization = vi.fn().mockResolvedValue(authorization);
    const finishDeviceAuthorization = vi.fn().mockResolvedValue({ marker: "device-provisioning" });
    const provisioner = provisionerFake();
    const openExternal = vi.fn();
    const flow = createCodexAuthFlow({
      adapter: { requestDeviceAuthorization, finishDeviceAuthorization } as never,
      provisioner,
      openExternal,
      startCallbackServer: callbackRecorder(),
    });

    const result = await flow.start("device-code", {});

    expect(openExternal).toHaveBeenCalledWith("https://example.test/device");
    expect(result).toMatchObject({
      status: "pending",
      interaction: "device-code",
      userCode: "WDJB-MJHT",
      verificationUri: "https://example.test/device",
    });
    if (result.status !== "pending") return;
    await expect(result.finish()).resolves.toMatchObject({
      credentials: { marker: "device-provisioning" },
    });
    expect(finishDeviceAuthorization).toHaveBeenCalledWith(authorization, expect.any(AbortSignal));
  });

  it("rejects unsupported methods", async () => {
    const flow = createCodexAuthFlow({
      adapter: {} as never,
      provisioner: provisionerFake(),
      openExternal: vi.fn(),
      startCallbackServer: callbackRecorder(),
    });

    await expect(flow.start("api-key", {})).rejects.toThrow("Codex 不支持接入方式：api-key");
  });
});

describe("glm auth flow", () => {
  function glmFlow(overrides: { readZCodeCredentials?: (region: string) => Promise<string> } = {}) {
    const createProvisioning = vi.fn().mockResolvedValue({ marker: "glm-provisioning" });
    const provisioner = provisionerFake();
    const flow = createGlmAuthFlow({
      adapter: { createProvisioning } as never,
      provisioner,
      readZCodeCredentials: overrides.readZCodeCredentials ?? vi.fn().mockResolvedValue("zk-key"),
    });
    return { flow, createProvisioning, provisioner };
  }

  it("provisions with the entered api key for the chosen region", async () => {
    const { flow, createProvisioning } = glmFlow();

    const result = await flow.start("api-key", { apiKey: "sk-1", region: "china" });

    expect(createProvisioning).toHaveBeenCalledWith("sk-1", "china", "api-key");
    expect(result.status).toBe("completed");
  });

  it("imports the key from the ZCode credential store for cli-import", async () => {
    const readZCodeCredentials = vi.fn().mockResolvedValue("zk-key");
    const { flow, createProvisioning } = glmFlow({ readZCodeCredentials });

    const result = await flow.start("cli-import", { region: "international" });

    expect(readZCodeCredentials).toHaveBeenCalledWith("international");
    expect(createProvisioning).toHaveBeenCalledWith("zk-key", "international", "cli-import");
    expect(result.status).toBe("completed");
  });

  it("rejects a missing or invalid region", async () => {
    const { flow } = glmFlow();

    await expect(flow.start("api-key", { apiKey: "sk-1" })).rejects.toThrow(
      "请选择有效的 GLM 服务区域",
    );
    await expect(
      flow.start("api-key", { apiKey: "sk-1", region: "mars" as never }),
    ).rejects.toThrow("请选择有效的 GLM 服务区域");
  });

  it("rejects unsupported methods", async () => {
    const { flow } = glmFlow();

    await expect(flow.start("device-code", {})).rejects.toThrow(
      "GLM Coding Plan 仅支持 ZCode 导入或 API Key 接入",
    );
  });
});

describe("grok build auth flow", () => {
  it("reads the grok CLI auth file from the home directory", async () => {
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ token: "fixture" }));
    const fromCliAuth = vi.fn().mockReturnValue({ marker: "grok-provisioning" });
    const provisioner = provisionerFake();
    const flow = createGrokBuildAuthFlow({
      adapter: { fromCliAuth } as never,
      provisioner,
      openExternal: vi.fn(),
      startCallbackServer: callbackRecorder(),
      readFile,
    });

    const result = await flow.start("cli-import", {});

    expect(readFile).toHaveBeenCalledWith(expect.stringMatching(/[/\\]\.grok[/\\]auth\.json$/));
    expect(result.status).toBe("completed");
    expect(provisioner.save).toHaveBeenCalledWith({ marker: "grok-provisioning" });
  });

  it("shows the complete verification uri for device-code", async () => {
    const authorization = {
      deviceCode: "dc-1",
      userCode: "GROK-1234",
      verificationUri: "https://example.test/device",
      verificationUriComplete: "https://example.test/device?user_code=GROK-1234",
      intervalSec: 5,
      expiresAtMs: Date.now() + 600_000,
    };
    const openExternal = vi.fn();
    const flow = createGrokBuildAuthFlow({
      adapter: { requestDeviceAuthorization: vi.fn().mockResolvedValue(authorization) } as never,
      provisioner: provisionerFake(),
      openExternal,
      startCallbackServer: callbackRecorder(),
    });

    const result = await flow.start("device-code", {});

    expect(openExternal).toHaveBeenCalledWith("https://example.test/device?user_code=GROK-1234");
    expect(result).toMatchObject({
      interaction: "device-code",
      verificationUri: "https://example.test/device?user_code=GROK-1234",
    });
  });

  it("uses the fixed grok callback redirect uri in the browser login", async () => {
    const startCallbackServer = callbackRecorder();
    const createBrowserAuthorization = vi
      .fn()
      .mockReturnValue({ url: "https://auth.example.test/authorize", state: "st-g" });
    const flow = createGrokBuildAuthFlow({
      adapter: { createBrowserAuthorization } as never,
      provisioner: provisionerFake(),
      openExternal: vi.fn(),
      startCallbackServer,
    });

    const result = await flow.start("browser-oauth", {});

    expect(createBrowserAuthorization).toHaveBeenCalledWith("http://127.0.0.1:56122/callback");
    expect(result.status).toBe("pending");
  });
});

describe("antigravity auth flow", () => {
  it("uses an ephemeral callback port and the localhost redirect host", async () => {
    const startCallbackServer = callbackRecorder();
    const createBrowserAuthorization = vi
      .fn()
      .mockReturnValue({ url: "https://accounts.example.test/authorize", state: "st-a" });
    const finishBrowserAuthorization = vi
      .fn()
      .mockResolvedValue({ marker: "antigravity-provisioning" });
    const provisioner = provisionerFake();
    const flow = createAntigravityAuthFlow({
      adapter: { createBrowserAuthorization, finishBrowserAuthorization } as never,
      provisioner,
      openExternal: vi.fn(),
      startCallbackServer,
    });

    const result = await flow.start("browser-oauth", {});

    expect(startCallbackServer).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 0 }),
    );
    expect(createBrowserAuthorization).toHaveBeenCalledWith("http://localhost:45678/callback");
    expect(result.status).toBe("pending");
    if (result.status !== "pending") return;

    const handler = startCallbackServer.mock.calls[0]![0].handler;
    expect(
      handler.handleRequest({
        pathname: "/callback",
        query: new URLSearchParams("code=c-2&state=st-a"),
      }).status,
    ).toBe(200);
    await expect(result.finish()).resolves.toMatchObject({
      credentials: { marker: "antigravity-provisioning" },
    });
  });

  it("rejects non-browser methods", async () => {
    const flow = createAntigravityAuthFlow({
      adapter: { createBrowserAuthorization: vi.fn() } as never,
      provisioner: provisionerFake(),
      openExternal: vi.fn(),
      startCallbackServer: callbackRecorder(),
    });

    await expect(flow.start("cli-import", {})).rejects.toThrow(
      "Antigravity 仅支持 Google 浏览器授权",
    );
  });
});
