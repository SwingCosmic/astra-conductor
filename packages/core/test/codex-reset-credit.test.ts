import { describe, expect, it } from "vitest";
import { CodexAdapter, type Account, type CredentialEnvelope } from "../src/internal.js";
import { redeemCodexResetCredit } from "../src/providers/codex/reset-card-redemption.js";

const now = new Date("2026-09-30T08:00:00.000Z");

const account: Account = {
  id: "codex-1",
  provider: "codex",
  authMethod: "browser-oauth",
  stableIdentity: "personal:user-1",
  displayName: "user@example.test",
  maskedIdentifier: "us***@example.test",
  enabled: true,
  credentialState: "available",
  publicMetadata: { workspaceId: "ws-1" },
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
};

const envelope: CredentialEnvelope = {
  version: 1,
  accountId: account.id,
  provider: "codex",
  authMethod: "browser-oauth",
  expiresAt: null,
  secrets: { accessToken: "access-1", refreshToken: "refresh-1" },
};

interface ConsumeCall {
  url: string;
  init?: RequestInit;
}

function resetCreditFetch(options: {
  credits?: unknown;
  consumeStatus?: number;
  consumePayload?: unknown;
}): { fetchImpl: typeof fetch; calls: ConsumeCall[] } {
  const calls: ConsumeCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/rate-limit-reset-credits")) {
      return Response.json(options.credits ?? { credits: [] });
    }
    if (url.endsWith("/rate-limit-reset-credits/consume")) {
      return Response.json(options.consumePayload ?? { outcome: "reset" }, {
        status: options.consumeStatus ?? 200,
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function adapterWith(fetchImpl: typeof fetch): CodexAdapter {
  return new CodexAdapter(fetchImpl, { now: () => now });
}

describe("codex reset credit redemption", () => {
  it("consumes the earliest-expiring credit with an idempotency key", async () => {
    const { fetchImpl, calls } = resetCreditFetch({
      credits: {
        credits: [
          { credit_id: "c-later", expires_at: "2026-10-10T00:00:00.000Z" },
          { credit_id: "c-sooner", expires_at: "2026-10-01T00:00:00.000Z" },
        ],
      },
    });

    await expect(
      adapterWith(fetchImpl).redeemResetCard(account, envelope, "codex-banked-reset"),
    ).resolves.toBeUndefined();

    const consume = calls.find((call) => call.url.endsWith("/consume"));
    expect(consume).toBeDefined();
    const body = JSON.parse(String(consume!.init?.body)) as Record<string, string>;
    expect(body.credit_id).toBe("c-sooner");
    expect(body.redeem_request_id).toMatch(/^[0-9a-f-]{36}$/);
    const headers = consume!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-1");
    expect(headers["chatgpt-account-id"]).toBe("ws-1");
  });

  it("treats alreadyRedeemed as a successful outcome", async () => {
    const { fetchImpl } = resetCreditFetch({
      credits: { credits: [{ credit_id: "c-1" }] },
      consumePayload: { code: "already_redeemed" },
    });

    await expect(
      adapterWith(fetchImpl).redeemResetCard(account, envelope, "codex-banked-reset"),
    ).resolves.toBeUndefined();
  });

  it("skips consumed and expired credits when selecting", async () => {
    const { fetchImpl, calls } = resetCreditFetch({
      credits: {
        credits: [
          { credit_id: "c-used", status: "consumed" },
          { credit_id: "c-expired", expires_at: "2026-01-01T00:00:00.000Z" },
          { credit_id: "c-valid", expires_at: "2026-12-01T00:00:00.000Z" },
        ],
      },
    });

    await adapterWith(fetchImpl).redeemResetCard(account, envelope, "codex-banked-reset");

    const body = JSON.parse(
      String(calls.find((call) => call.url.endsWith("/consume"))!.init?.body),
    ) as Record<string, string>;
    expect(body.credit_id).toBe("c-valid");
  });

  it("honors an explicit credit id and rejects unavailable selections", async () => {
    const chosen = resetCreditFetch({
      credits: {
        credits: [
          { credit_id: "c-later", expires_at: "2026-10-10T00:00:00.000Z" },
          { credit_id: "c-sooner", expires_at: "2026-10-01T00:00:00.000Z" },
        ],
      },
    });
    await redeemCodexResetCredit({
      accessToken: "access-1",
      workspaceId: "ws-1",
      creditId: "c-later",
      fetchImpl: chosen.fetchImpl,
    });
    const chosenBody = JSON.parse(
      String(chosen.calls.find((call) => call.url.endsWith("/consume"))!.init?.body),
    ) as Record<string, string>;
    expect(chosenBody.credit_id).toBe("c-later");

    const missing = resetCreditFetch({ credits: { credits: [{ credit_id: "c-1" }] } });
    await expect(
      redeemCodexResetCredit({
        accessToken: "access-1",
        creditId: "c-gone",
        fetchImpl: missing.fetchImpl,
      }),
    ).rejects.toThrow("所选 Codex 重置额度已不可用，请刷新后确认");
  });

  it("rejects when no credits are available", async () => {
    const { fetchImpl } = resetCreditFetch({ credits: { credits: [] } });

    await expect(
      adapterWith(fetchImpl).redeemResetCard(account, envelope, "codex-banked-reset"),
    ).rejects.toThrow("没有可用的 Codex 重置额度");
  });

  it("maps nothing_to_reset to a validation error", async () => {
    const { fetchImpl } = resetCreditFetch({
      credits: { credits: [{ credit_id: "c-1" }] },
      consumePayload: { outcome: "nothing_to_reset" },
    });

    await expect(
      adapterWith(fetchImpl).redeemResetCard(account, envelope, "codex-banked-reset"),
    ).rejects.toThrow("当前没有已耗尽、可重置的 Codex 限额");
  });

  it("maps consume auth failures", async () => {
    const { fetchImpl } = resetCreditFetch({
      credits: { credits: [{ credit_id: "c-1" }] },
      consumeStatus: 401,
      consumePayload: {},
    });

    await expect(
      adapterWith(fetchImpl).redeemResetCard(account, envelope, "codex-banked-reset"),
    ).rejects.toThrow("Codex 重置额度接口拒绝了当前令牌");
  });

  it("requires a codex account and access token", async () => {
    const { fetchImpl } = resetCreditFetch({});
    const foreign = { ...account, provider: "glm" as const };
    await expect(adapterWith(fetchImpl).redeemResetCard(foreign, envelope, "x")).rejects.toThrow(
      "只有 Codex 账号支持使用重置额度",
    );
    const secretless = { ...envelope, secrets: {} };
    await expect(adapterWith(fetchImpl).redeemResetCard(account, secretless, "x")).rejects.toThrow(
      "Codex 访问令牌不可用",
    );
  });

  it("exposes a single banked item with a selection token when credits exist", async () => {
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (!url.includes("/wham/usage")) return new Response(null, { status: 404 });
      return Response.json({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 25, limit_window_seconds: 18_000 },
          secondary_window: { used_percent: 10, limit_window_seconds: 604_800 },
        },
        rate_limit_reset_credits: { available_count: 2 },
      });
    }) as typeof fetch;

    const snapshot = await adapterWith(fetchImpl).fetchUsage(account, envelope);

    expect(snapshot.extras).toHaveLength(1);
    const extra = snapshot.extras[0]!;
    expect(extra.key).toBe("reset-credits");
    expect(extra.value).toBe("2");
    expect(extra.items).toEqual([
      { key: "banked", kind: "banked", expiresAt: null, actionToken: "codex-banked-reset" },
    ]);
  });

  it("keeps extras empty of items when no credits are banked", async () => {
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (!url.includes("/wham/usage")) return new Response(null, { status: 404 });
      return Response.json({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 25, limit_window_seconds: 18_000 },
        },
        rate_limit_reset_credits: { available_count: 0 },
      });
    }) as typeof fetch;

    const snapshot = await adapterWith(fetchImpl).fetchUsage(account, envelope);

    expect(snapshot.extras[0]?.value).toBe("0");
    expect(snapshot.extras[0]?.items).toBeUndefined();
  });
});
