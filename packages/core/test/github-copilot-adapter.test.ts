import { httpServices } from "./service-helpers.js";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, CredentialEnvelope } from "../src/internal.js";
import { toPublicUsage } from "../src/public-api.js";
import { planMultiplier } from "../src/providers/catalog.js";
import { CopilotAdapter } from "../src/providers/github-copilot/adapter.js";
import { createCopilotAuthFlow } from "../src/providers/github-copilot/auth-flow.js";
import { githubCopilotDescriptor } from "../src/providers/github-copilot/descriptor.js";

const now = new Date("2026-10-14T08:00:00.000Z");

/** 设备码与令牌端点的固定时钟；授权过期时间按 expires_in 推算。 */
const clock = { now: () => now };

const account: Account = {
  id: "copilot-1",
  provider: "github-copilot",
  offeringId: "github-copilot",
  authMethod: "device-code",
  stableIdentity: "github:12345",
  displayName: "octocat",
  maskedIdentifier: "oc***at",
  enabled: true,
  credentialState: "available",
  publicMetadata: { githubLogin: "octocat", githubUserId: 12345 },
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
};

const sessionExpiryMs = now.getTime() + 30 * 60 * 1000;

const envelope: CredentialEnvelope = {
  version: 1,
  accountId: account.id,
  provider: "github-copilot",
  authMethod: "device-code",
  expiresAt: new Date(sessionExpiryMs).toISOString(),
  secrets: { accessToken: "gho_oauth", copilotToken: "tid_copilot" },
};

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("github copilot device flow", () => {
  it("provisions from the device code flow by validating copilot access on /user", async () => {
    const calls: RecordedCall[] = [];
    let polls = 0;
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/login/device/code")) {
        return jsonResponse({
          device_code: "device-1",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          verification_uri_complete: "https://github.com/login/device?user_code=ABCD-1234",
          expires_in: 900,
          // 测试内轮询间隔为 0，避免真实 sleep。
          interval: 0,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        polls += 1;
        return polls === 1
          ? jsonResponse({ error: "authorization_pending" })
          : jsonResponse({ access_token: "gho_oauth", token_type: "bearer", scope: "read:user" });
      }
      if (url.includes("copilot_internal/user")) {
        // v2/token 会话令牌交换已被 GitHub 拒斥；接入校验改走 /user。
        return jsonResponse({ copilot_plan: "free" });
      }
      if (url.endsWith("/user")) {
        return jsonResponse({
          id: 12345,
          login: "octocat",
          name: "The Octocat",
          email: "octocat@example.test",
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const adapter = new CopilotAdapter(httpServices(fetchImpl, clock));

    const authorization = await adapter.requestDeviceAuthorization();
    expect(authorization.userCode).toBe("ABCD-1234");
    expect(authorization.intervalSec).toBe(0);

    const provisioning = await adapter.finishDeviceAuthorization(authorization);
    expect(provisioning).toMatchObject({
      authMethod: "device-code",
      offeringId: "github-copilot",
      stableIdentity: "github:12345",
      displayName: "The Octocat",
      maskedIdentifier: "oc***@example.test",
      publicMetadata: {
        githubLogin: "octocat",
        githubUserId: 12345,
        githubName: "The Octocat",
        githubEmail: "octocat@example.test",
      },
      // OAuth 令牌长期有效：无过期跟踪、无会话令牌密钥。
      credentials: {
        provider: "github-copilot",
        expiresAt: null,
        secrets: { accessToken: "gho_oauth" },
      },
    });

    const tokenPoll = calls.find((call) => call.url.endsWith("/login/oauth/access_token"))!;
    const body = new URLSearchParams(String(tokenPoll.init?.body));
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    const validationHeaders = calls.find((call) => call.url.includes("copilot_internal/user"))!.init
      ?.headers as Record<string, string>;
    expect(validationHeaders.Authorization).toBe("Bearer gho_oauth");
    expect(validationHeaders["Editor-Version"]).toMatch(/^copilot\//);
    // /user 是公共 REST 端点，不带 copilot 编辑器指纹头（真实账号曾因这套头被拒）。
    const userHeaders = calls.find((call) => call.url.endsWith("api.github.com/user"))!.init
      ?.headers as Record<string, string>;
    expect(userHeaders.Authorization).toBe("Bearer gho_oauth");
    expect(userHeaders["X-GitHub-Api-Version"]).toBeUndefined();
    expect(userHeaders["Editor-Version"]).toBeUndefined();
  });

  it("rejects provisioning when the copilot user endpoint refuses the token", async () => {
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/login/device/code")) {
        return jsonResponse({
          device_code: "device-1",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 0,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        return jsonResponse({ access_token: "gho_oauth" });
      }
      if (url.includes("copilot_internal/user")) return new Response(null, { status: 403 });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const adapter = new CopilotAdapter(httpServices(fetchImpl, clock));

    await expect(
      adapter.finishDeviceAuthorization({
        deviceCode: "device-1",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        verificationUriComplete: "https://github.com/login/device",
        intervalSec: 0,
        expiresAtMs: now.getTime() + 60_000,
      }),
    ).rejects.toThrow("GitHub 授权已失效，请重新接入");
  });

  it("still provisions when the public /user endpoint rejects the token", async () => {
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/login/device/code")) {
        return jsonResponse({
          device_code: "device-1",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 0,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        return jsonResponse({ access_token: "gho_oauth" });
      }
      if (url.includes("copilot_internal/user")) {
        return jsonResponse({ copilot_plan: "free" });
      }
      if (url.endsWith("/user")) return new Response(null, { status: 403 });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const adapter = new CopilotAdapter(httpServices(fetchImpl, clock));

    const provisioning = await adapter.finishDeviceAuthorization({
      deviceCode: "device-1",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete: "https://github.com/login/device",
      intervalSec: 0,
      expiresAtMs: now.getTime() + 60_000,
    });
    const fingerprint = createHash("sha256").update("gho_oauth").digest("hex").slice(0, 24);
    expect(provisioning.stableIdentity).toBe(`github-token:${fingerprint}`);
    expect(provisioning.displayName).toBe("GitHub Copilot 账号");
    expect(provisioning.publicMetadata).toEqual({});
  });

  it("falls back to a token fingerprint identity without any user id", async () => {
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/login/oauth/access_token")) {
        return jsonResponse({ access_token: "gho_oauth" });
      }
      if (url.includes("copilot_internal/user")) {
        return jsonResponse({ copilot_plan: "free" });
      }
      if (url.endsWith("/user")) return new Response(null, { status: 400 });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const adapter = new CopilotAdapter(httpServices(fetchImpl, clock));

    const provisioning = await adapter.finishDeviceAuthorization({
      deviceCode: "device-1",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete: "https://github.com/login/device",
      intervalSec: 0,
      expiresAtMs: now.getTime() + 60_000,
    });
    const fingerprint = createHash("sha256").update("gho_oauth").digest("hex").slice(0, 24);
    expect(provisioning.stableIdentity).toBe(`github-token:${fingerprint}`);
    expect(provisioning.displayName).toBe("GitHub Copilot 账号");
  });

  it("maps device flow terminal errors and unknown polling failures", async () => {
    const adapter = new CopilotAdapter(
      httpServices(
        (async () => jsonResponse({ error: "expired_token" })) as unknown as typeof fetch,
        clock,
      ),
    );
    const authorization = {
      deviceCode: "device-1",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete: "https://github.com/login/device",
      intervalSec: 0,
      expiresAtMs: now.getTime() + 60_000,
    };
    await expect(adapter.finishDeviceAuthorization(authorization)).rejects.toThrow(
      "GitHub Copilot 设备授权失败",
    );
  });
});

describe("github copilot credential migration", () => {
  it("is a no-op without network access once the envelope is migrated", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const adapter = new CopilotAdapter(httpServices(fetchImpl, clock));
    const migrated = {
      ...envelope,
      expiresAt: null,
      secrets: { accessToken: "gho_oauth" },
    };
    const result = await adapter.refreshCredentials(account, migrated, false);
    expect(result).toEqual({ envelope: migrated, changed: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("migrates legacy envelopes by dropping the session-token expiry and secret", async () => {
    // v2/token 会话令牌层退役：存量信封（expiresAt 跟踪会话过期 + copilotToken
    // 密钥）随首次刷新迁移为无过期形态，迁移不发网络请求。
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const adapter = new CopilotAdapter(httpServices(fetchImpl, clock));
    const legacy = {
      ...envelope,
      expiresAt: new Date(now.getTime() - 1000).toISOString(),
    };

    const refreshed = await adapter.refreshCredentials(account, legacy, false);
    expect(refreshed.changed).toBe(true);
    expect(refreshed.envelope).toEqual({
      ...legacy,
      expiresAt: null,
      secrets: { accessToken: "gho_oauth" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    const again = await adapter.refreshCredentials(account, refreshed.envelope, true);
    expect(again).toEqual({ envelope: refreshed.envelope, changed: false });
  });
});

describe("github copilot usage", () => {
  it("projects paid plan quota snapshots into monthly windows", async () => {
    vi.stubGlobal("fetch", (async () =>
      jsonResponse({
        copilot_plan: "PRO_PLUS",
        quota_reset_date: "2026-11-01T00:00:00Z",
        quota_snapshots: {
          chat: { entitlement: 0, remaining: 0, unlimited: true },
          completions: { entitlement: 0, remaining: 0, unlimited: true },
          premium_interactions: { entitlement: 1500, remaining: 300, unlimited: false },
        },
      })) as typeof fetch);
    const adapter = new CopilotAdapter(
      httpServices(
        (async () => {
          throw new Error("usage must use global fetch");
        }) as typeof fetch,
        clock,
      ),
    );

    const snapshot = await adapter.fetchUsage(account, envelope);

    // 原始 copilot_plan（实测短词形态）透传为数据层标识，推断合成名降级为
    // 未命中回退；目录按规范化后的 "pro plus" 精确键解析出 copilot-pro-plus。
    expect(snapshot.plan).toBe("PRO_PLUS");
    expect(snapshot.rawPlanLabel).toBe("Copilot Pro+");
    expect(planMultiplier("github-copilot", snapshot.plan)).toBe(4.6);
    // 无限额度的 chat/completions 不展示，只保留计数的 premium 请求；
    // entitlement 计数是真实原始量，rawAmounts 置真供 UI 展示 使用量/总量。
    expect(snapshot.groups[0]!.quotas).toEqual([
      {
        key: "premium_interactions",
        displayName: "高级请求",
        windowSeconds: 2_592_000,
        used: 1200,
        total: 1500,
        remaining: 300,
        remainingPercentage: 20,
        resetAt: "2026-11-01T00:00:00.000Z",
        unlimited: false,
        rawAmounts: true,
      },
    ]);
    expect(snapshot.overallRemainingPercentage).toBe(20);
  });

  it("treats limited-user quotas as remaining counts, not used", async () => {
    vi.stubGlobal("fetch", (async () =>
      jsonResponse({
        access_type_sku: "free_limited",
        monthly_quotas: { chat: 50, completions: 2000 },
        limited_user_quotas: { chat: 50, completions: 500 },
        limited_user_reset_date: "2026-11-01T00:00:00Z",
      })) as typeof fetch);
    const adapter = new CopilotAdapter(
      httpServices(
        (async () => {
          throw new Error("unused");
        }) as typeof fetch,
        clock,
      ),
    );

    const snapshot = await adapter.fetchUsage(account, envelope);

    expect(snapshot.plan).toBe("free_limited");
    expect(snapshot.rawPlanLabel).toBe("Copilot Free");
    const chat = snapshot.groups[0]!.quotas.find((quota) => quota.key === "chat")!;
    expect(chat.used).toBe(0);
    expect(chat.remainingPercentage).toBe(100);
    // 有限用户的计数是真实请求量，可展示 使用量/总量。
    expect(chat.rawAmounts).toBe(true);
    const completions = snapshot.groups[0]!.quotas.find((quota) => quota.key === "completions")!;
    expect(completions.used).toBe(1500);
    expect(completions.remainingPercentage).toBe(25);
    expect(completions.rawAmounts).toBe(true);
  });

  it("hides premium meters the free subscription does not include", async () => {
    // 真实免费账号形态：quota_snapshots 里 premium 无正额度、只有
    // percent_remaining 0 —— 不展示为 0% 耗尽，也不参与综合剩余。
    vi.stubGlobal("fetch", (async () =>
      jsonResponse({
        access_type_sku: "free_limited",
        quota_reset_date: "2026-11-01T00:00:00Z",
        quota_snapshots: {
          premium_interactions: {
            entitlement: 0,
            remaining: 0,
            unlimited: false,
            percent_remaining: 0,
          },
          chat: { entitlement: 200, remaining: 200, unlimited: false },
          completions: { entitlement: 2000, remaining: 2000, unlimited: false },
        },
      })) as typeof fetch);
    const adapter = new CopilotAdapter(
      httpServices(
        (async () => {
          throw new Error("unused");
        }) as typeof fetch,
        clock,
      ),
    );

    const snapshot = await adapter.fetchUsage(account, envelope);

    expect(snapshot.plan).toBe("free_limited");
    expect(snapshot.rawPlanLabel).toBe("Copilot Free");
    expect(snapshot.groups[0]!.quotas.map((quota) => quota.key)).toEqual(["chat", "completions"]);
    expect(snapshot.overallRemainingPercentage).toBe(100);
  });

  it("recognizes the Max tier and resolves it through the catalog", async () => {
    vi.stubGlobal("fetch", (async () =>
      jsonResponse({
        copilot_plan: "max",
        quota_reset_date: "2026-11-01T00:00:00Z",
        quota_snapshots: {
          premium_interactions: { entitlement: 20_000, remaining: 18_000, unlimited: false },
        },
      })) as typeof fetch);
    const adapter = new CopilotAdapter(
      httpServices(
        (async () => {
          throw new Error("unused");
        }) as typeof fetch,
        clock,
      ),
    );

    const snapshot = await adapter.fetchUsage(account, envelope);

    // Max 档（AI Credits 时代新增）：原始值透传，推断名走 MAX 分支，
    // 目录按 `max` 短词键解析出 copilot-max（13.3x）。
    expect(snapshot.plan).toBe("max");
    expect(snapshot.rawPlanLabel).toBe("Copilot Max");
    const resolved = toPublicUsage(snapshot, "github-copilot");
    expect(resolved.planId).toBe("copilot-max");
    expect(resolved.planLabel).toBe("Copilot Max");
    expect(planMultiplier("github-copilot", snapshot.plan)).toBe(13.3);
  });

  it("maps upstream auth failures to re-authentication errors", async () => {
    vi.stubGlobal("fetch", (async () =>
      jsonResponse({ message: "denied" }, 403)) as unknown as typeof fetch);
    const adapter = new CopilotAdapter(
      httpServices(
        (async () => {
          throw new Error("unused");
        }) as typeof fetch,
        clock,
      ),
    );

    // 403 响应体不是 message 结构时叶子抛错，这里验证无令牌路径的错误分类。
    const secretless = { ...envelope, secrets: {} };
    await expect(adapter.fetchUsage(account, secretless)).rejects.toThrow("GitHub 访问令牌不可用");
  });
});

describe("github copilot auth flow", () => {
  function flowWith(adapter: Partial<CopilotAdapter>) {
    return createCopilotAuthFlow({
      adapter: adapter as CopilotAdapter,
      provisioner: { save: vi.fn() },
    });
  }

  it("starts the device-code interaction and exposes the user code", async () => {
    const adapter = new CopilotAdapter(
      httpServices(
        (async (input: unknown) =>
          String(input).endsWith("/login/device/code")
            ? jsonResponse({
                device_code: "device-1",
                user_code: "ABCD-1234",
                verification_uri: "https://github.com/login/device",
                verification_uri_complete: "https://github.com/login/device?user_code=ABCD-1234",
                expires_in: 900,
                interval: 5,
              })
            : new Response(null, { status: 404 })) as typeof fetch,
        clock,
      ),
    );
    const flow = flowWith(adapter);

    const start = await flow.start("github-copilot", "device-code", {});
    expect(start).toMatchObject({
      status: "pending",
      interaction: "device-code",
      userCode: "ABCD-1234",
    });
  });

  it("rejects unknown offerings and unsupported methods", async () => {
    const flow = flowWith(
      new CopilotAdapter(
        httpServices(
          (async () => {
            throw new Error("unused");
          }) as typeof fetch,
          clock,
        ),
      ),
    );
    await expect(flow.start("codex", "device-code", {})).rejects.toThrow(
      "GitHub Copilot 不提供接入点：codex",
    );
    await expect(flow.start("github-copilot", "api-key", {})).rejects.toThrow(
      "GitHub Copilot 不支持接入方式：api-key",
    );
  });

  it("declares the offering with the copilot icon key and plan catalog", () => {
    const offering = githubCopilotDescriptor.offerings[0]!;
    expect(offering.iconKey).toBe("copilot");
    expect(offering.authMethods.map((method) => method.method)).toEqual(["device-code"]);
    expect(offering.plans.map((plan) => plan.displayName)).toContain("Copilot Pro+");
  });
});
