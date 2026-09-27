import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import QuotaCard from "../src/components/QuotaCard.vue";
import type { PolyQuotaSnapshot, PublicAccount, PublicUsage } from "../src/models";
import ProvidersView from "../src/views/ProvidersView.vue";
import { EmptyPolyQuotaService, type IPolyQuotaService } from "../src/services/polyquota-service";
import { polyQuotaServiceKey } from "../src/services/polyquota-service-vue";
import {
  accountPresentationId,
  planLabel,
  providerPresentation,
  quotaLabel,
} from "../src/presentation";

const account: PublicAccount = {
  id: "account-1",
  provider: "codex",
  authMethod: "cli-import",
  displayName: "test@example.test",
  maskedIdentifier: "te***@example.test",
  enabled: true,
  credentialState: "available",
  tokenExpiresAt: null,
  publicMetadata: {},
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
};

afterEach(() => {
  delete window.polyQuotaElectronService;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mountApp(service: IPolyQuotaService) {
  return mount(App, {
    global: { provide: { [polyQuotaServiceKey as symbol]: service } },
  });
}

const emptyService = new EmptyPolyQuotaService();

function snapshot(
  accounts: PublicAccount[],
  usageByAccountId: Record<string, PublicUsage | null> = Object.fromEntries(
    accounts.map((item) => [item.id, null]),
  ),
  revision = 1,
): PolyQuotaSnapshot {
  return {
    schemaVersion: 1,
    revision,
    generatedAt: "2026-09-27T00:00:00.000Z",
    accounts,
    usageByAccountId,
    operations: [],
    settings: { pollingEnabled: true, pollingIntervalMinutes: 15 },
    scheduler: {
      status: "waiting",
      intervalMinutes: 15,
      nextRunAt: "2026-09-27T00:15:00.000Z",
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastResult: null,
    },
  };
}

function serviceWithSnapshot(
  value: PolyQuotaSnapshot,
  overrides: Partial<IPolyQuotaService> = {},
): IPolyQuotaService {
  const service = new EmptyPolyQuotaService();
  vi.spyOn(service, "getSnapshot").mockResolvedValue({ ok: true, value });
  return Object.assign(service, overrides);
}

describe("desktop account UI", () => {
  it("keeps the ordinary browser preview runnable with the empty service", async () => {
    const wrapper = mountApp(emptyService);
    await flushPromises();

    expect(wrapper.text()).toContain("还没有接入账号");
    expect(wrapper.text()).not.toContain("桌面接口不可用");
  });

  it("maps provider display text only in the UI presentation catalog", () => {
    expect(providerPresentation("codex").icon).toMatch(/gpt\.png$/);
    expect(planLabel("codex", "prolite")).toBe("Pro 5x");
    expect(
      quotaLabel("codex", {
        key: "session",
        displayName: null,
        windowSeconds: 18_000,
        used: 10,
        total: 100,
        remaining: 90,
        remainingPercentage: 90,
        resetAt: null,
        unlimited: false,
      }),
    ).toBe("5-hour");
    expect(
      quotaLabel("codex", {
        key: "session",
        displayName: "Weekly",
        windowSeconds: 604_800,
        used: 10,
        total: 100,
        remaining: 90,
        remainingPercentage: 90,
        resetAt: null,
        unlimited: false,
      }),
    ).toBe("Weekly");
    expect(
      quotaLabel("codex", {
        key: "weekly",
        displayName: "Session",
        windowSeconds: 18_000,
        used: 10,
        total: 100,
        remaining: 90,
        remainingPercentage: 90,
        resetAt: null,
        unlimited: false,
      }),
    ).toBe("5-hour");
  });
  it("renders Codex quota data and account controls", async () => {
    const wrapper = mount(QuotaCard, {
      props: {
        account,
        busy: false,
        usage: {
          accountId: account.id,
          plan: "plus",
          overallRemainingPercentage: 80,
          groups: [
            {
              key: "default",
              displayName: null,
              quotas: [
                {
                  key: "session",
                  displayName: null,
                  windowSeconds: 18_000,
                  used: 20,
                  total: 100,
                  remaining: 80,
                  remainingPercentage: 80,
                  resetAt: null,
                  unlimited: false,
                },
                {
                  key: "weekly",
                  displayName: null,
                  windowSeconds: 604_800,
                  used: 90,
                  total: 100,
                  remaining: 10,
                  remainingPercentage: 10,
                  resetAt: null,
                  unlimited: false,
                },
              ],
            },
          ],
          extras: [{ key: "reset-credits", value: "1" }],
          fetchedAt: "2026-09-24T00:00:00.000Z",
        },
      },
    });
    expect(wrapper.text()).toContain("5-hour");
    expect(wrapper.text()).toContain("Weekly");
    expect(wrapper.text()).toContain("Reset credits");
    expect(wrapper.find(".switch-field").exists()).toBe(true);
    await wrapper.get(".extra-button").trigger("click");
    expect(wrapper.text()).toContain("上游未提供可展示的逐项明细");
    expect(wrapper.text()).toContain("只读展示重置卡");
  });

  it("keeps refresh available before the first usage snapshot", async () => {
    const wrapper = mount(QuotaCard, {
      props: { account, busy: false, usage: null },
    });
    expect(wrapper.text()).toContain("尚无用量数据");
    const refresh = wrapper.findAll("button").find((button) => button.text().includes("刷新"));
    expect(refresh).toBeDefined();
    await refresh!.trigger("click");
    expect(wrapper.emitted("refresh")).toHaveLength(1);
  });

  it("keeps BigModel and Z.ai as separate UI services", () => {
    const bigmodel = {
      ...account,
      provider: "glm" as const,
      publicMetadata: { region: "china", presentationId: "bigmodel-coding-plan" },
    };
    const zai = {
      ...account,
      id: "account-2",
      provider: "glm" as const,
      publicMetadata: { region: "international", presentationId: "zai-coding-plan" },
    };
    expect(accountPresentationId(bigmodel)).toBe("bigmodel-coding-plan");
    expect(accountPresentationId(zai)).toBe("zai-coding-plan");
    expect(providerPresentation(bigmodel).name).toBe("BigModel Coding Plan");
    expect(providerPresentation(zai).name).toBe("Z.ai Coding Plan");
    expect(providerPresentation(bigmodel).icon).toMatch(/bigmodel\.svg$/);
    expect(providerPresentation(zai).icon).toMatch(/zai\.svg$/);
    expect(providerPresentation(bigmodel).icon).not.toBe(providerPresentation(zai).icon);
  });

  it("keeps only the method-specific explanation in the account modal", async () => {
    const wrapper = mount(ProvidersView, {
      props: { accounts: [], busy: false },
      global: { provide: { [polyQuotaServiceKey as symbol]: emptyService } },
    });
    const zaiRow = wrapper
      .findAll(".provider-row")
      .find((row) => row.text().includes("Z.ai Coding Plan"));
    const addButton = zaiRow?.findAll("button").find((button) => button.text() === "添加");

    await addButton!.trigger("click");
    expect(wrapper.text()).toContain("只读取现有凭据并保存应用自己的加密副本");
    expect(wrapper.find(".method-summary").exists()).toBe(false);
    expect(wrapper.find(".modal-note").exists()).toBe(false);
  });

  it("shows OAuth token expiry and emits a manual refresh action", async () => {
    const oauthAccount: PublicAccount = {
      ...account,
      authMethod: "browser-oauth",
      tokenExpiresAt: "2099-09-25T13:00:00.000Z",
    };
    const wrapper = mount(ProvidersView, {
      props: { accounts: [oauthAccount], busy: false },
    });

    expect(wrapper.text()).toContain("令牌到期：");
    const refreshButton = wrapper.findAll("button").find((button) => button.text() === "刷新令牌");
    expect(refreshButton).toBeDefined();
    await refreshButton!.trigger("click");
    expect(wrapper.emitted("refreshCredentials")?.[0]).toEqual([oauthAccount]);
  });

  it("renders GLM reset-card type and expiry details", async () => {
    const glmAccount: PublicAccount = {
      ...account,
      provider: "glm",
      publicMetadata: { region: "china", presentationId: "bigmodel-coding-plan" },
    };
    const wrapper = mount(QuotaCard, {
      props: {
        account: glmAccount,
        busy: false,
        usage: {
          accountId: glmAccount.id,
          plan: "Pro",
          overallRemainingPercentage: 75,
          groups: [],
          extras: [
            {
              key: "reset-credits",
              value: "2",
              items: [
                { key: "1", kind: "five-hour", expiresAt: "2099-09-25T13:00:00.000Z" },
                { key: "2", kind: "weekly", expiresAt: "2099-09-26T13:00:00.000Z" },
              ],
            },
          ],
          fetchedAt: "2026-09-25T12:00:00.000Z",
        },
      },
    });
    expect(wrapper.text()).toContain("BigModel Coding Plan");
    await wrapper.get(".extra-button").trigger("click");
    expect(wrapper.text()).toContain("5 小时使用周期");
    expect(wrapper.text()).toContain("每周使用周期");
    expect(wrapper.findAll(".credit-items li")).toHaveLength(2);
  });

  it("renders provider-independent quota groups", () => {
    const wrapper = mount(QuotaCard, {
      props: {
        account: { ...account, provider: "antigravity" },
        busy: false,
        usage: {
          accountId: account.id,
          plan: "Starter",
          overallRemainingPercentage: 75,
          groups: [
            {
              key: "gemini-models",
              displayName: "Gemini Models",
              quotas: [
                {
                  key: "weekly",
                  displayName: "Weekly Quota",
                  windowSeconds: 604_800,
                  used: 25,
                  total: 100,
                  remaining: 75,
                  remainingPercentage: 75,
                  resetAt: null,
                  unlimited: false,
                },
              ],
            },
          ],
          extras: [],
          fetchedAt: "2026-09-24T00:00:00.000Z",
        },
      },
    });
    expect(wrapper.text()).toContain("Antigravity");
    expect(wrapper.text()).toContain("Gemini Models");
    expect(wrapper.text()).toContain("Weekly Quota");
    expect(wrapper.text()).toContain("75% 剩余");
  });

  it("loads accounts without exposing credentials to the renderer", async () => {
    const service = serviceWithSnapshot(snapshot([account]), {
      getSystemStatus: vi.fn().mockResolvedValue({ ok: true, value: { proxy: "DIRECT" } }),
    });
    const wrapper = mountApp(service);
    await vi.waitFor(() => expect(wrapper.text()).toContain("te***@example.test"));
    expect(wrapper.text()).not.toMatch(/accessToken|refreshToken|idToken/);
    const settingsButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("设置"));
    expect(settingsButton).toBeDefined();
    await settingsButton!.trigger("click");
    await vi.waitFor(() => expect(wrapper.text()).toContain("DIRECT"));
  });

  it("subscribes before the first snapshot and reloads after a newer revision", async () => {
    const order: string[] = [];
    let listener!: Parameters<IPolyQuotaService["subscribe"]>[0];
    const dispose = vi.fn();
    const getSnapshot = vi
      .fn()
      .mockImplementationOnce(async () => {
        order.push("snapshot");
        return { ok: true as const, value: snapshot([], {}, 1) };
      })
      .mockResolvedValue({ ok: true, value: snapshot([account], undefined, 2) });
    const service = serviceWithSnapshot(snapshot([], {}, 1), {
      getSnapshot,
      subscribe: vi.fn((nextListener) => {
        order.push("subscribe");
        listener = nextListener;
        return dispose;
      }),
    });

    const wrapper = mountApp(service);
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    expect(order).toEqual(["subscribe", "snapshot"]);

    listener({
      schemaVersion: 1,
      revision: 2,
      reasons: ["accounts"],
      occurredAt: "2026-09-27T00:01:00.000Z",
    });
    await vi.waitFor(() => expect(wrapper.text()).toContain("te***@example.test"));
    expect(getSnapshot).toHaveBeenCalledTimes(2);

    wrapper.unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("refreshes a newly connected account before loading its first snapshot", async () => {
    const getSnapshot = vi.fn().mockResolvedValue({ ok: true, value: snapshot([account]) });
    const refreshAccount = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        status: "updated",
        accountId: account.id,
        snapshot: {
          accountId: account.id,
          plan: "plus",
          overallRemainingPercentage: 100,
          groups: [],
          extras: [],
          fetchedAt: "2026-09-27T00:00:00.000Z",
        },
      },
    });
    const service = serviceWithSnapshot(snapshot([account]), {
      getSnapshot,
      refreshAccount,
    });
    const wrapper = mountApp(service);
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    await flushPromises();
    const providersButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("服务商"));
    expect(providersButton).toBeDefined();
    await providersButton!.trigger("click");

    wrapper.findComponent(ProvidersView).vm.$emit("connected", account);

    await vi.waitFor(() => expect(refreshAccount).toHaveBeenCalledWith(account.id));
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(wrapper.text()).toContain("账号已接入并刷新用量"));
  });

  it("refreshes OAuth credentials from the provider account row", async () => {
    const oauthAccount: PublicAccount = {
      ...account,
      authMethod: "browser-oauth",
      tokenExpiresAt: "2099-09-25T13:00:00.000Z",
    };
    const getSnapshot = vi.fn().mockResolvedValue({ ok: true, value: snapshot([oauthAccount]) });
    const refreshCredentials = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        status: "updated",
        accountId: oauthAccount.id,
        tokenExpiresAt: "2099-09-25T15:00:00.000Z",
      },
    });
    const service = serviceWithSnapshot(snapshot([oauthAccount]), {
      getSnapshot,
      refreshCredentials,
    });
    const wrapper = mountApp(service);
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    const providersButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("服务商"));
    await providersButton!.trigger("click");
    const refreshButton = wrapper.findAll("button").find((button) => button.text() === "刷新令牌");
    await vi.waitFor(() => expect(refreshButton?.attributes("disabled")).toBeUndefined());
    await refreshButton!.trigger("click");

    await vi.waitFor(() => expect(refreshCredentials).toHaveBeenCalledWith(oauthAccount.id));
    await vi.waitFor(() => expect(wrapper.text()).toContain("令牌已刷新"));
  });

  it("dismisses the global message automatically", async () => {
    vi.useFakeTimers();
    const service = serviceWithSnapshot(snapshot([account]), {
      refreshAccount: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          status: "updated",
          accountId: account.id,
          snapshot: {
            accountId: account.id,
            plan: "plus",
            overallRemainingPercentage: 100,
            groups: [],
            extras: [],
            fetchedAt: "2026-09-27T00:00:00.000Z",
          },
        },
      }),
    });
    const wrapper = mountApp(service);
    await flushPromises();
    await wrapper.get(".quota-card-foot button").trigger("click");
    await flushPromises();

    expect(wrapper.get(".global-message").text()).toBe("用量已刷新");
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(wrapper.find(".global-message").exists()).toBe(false);
  });
});
