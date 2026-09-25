import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import QuotaCard from "../src/components/QuotaCard.vue";
import type { PublicAccount } from "../src/models";
import { planLabel, quotaLabel } from "../src/presentation";

const account: PublicAccount = {
  id: "account-1",
  provider: "codex",
  authMethod: "cli-import",
  displayName: "test@example.test",
  maskedIdentifier: "te***@example.test",
  enabled: true,
  credentialState: "available",
  publicMetadata: {},
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
};

afterEach(() => {
  delete window.llmUsage;
  vi.restoreAllMocks();
});

describe("desktop account UI", () => {
  it("maps provider display text only in the UI presentation catalog", () => {
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
    expect(wrapper.text()).toContain("当前上游只返回可用总数");
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
    window.llmUsage = {
      listAccounts: vi.fn().mockResolvedValue({ ok: true, value: [account] }),
      getUsage: vi.fn().mockResolvedValue({ ok: true, value: null }),
      getSettings: vi.fn().mockResolvedValue({
        ok: true,
        value: { pollingEnabled: true, pollingIntervalMinutes: 15 },
      }),
      getProxy: vi.fn().mockResolvedValue({ ok: true, value: "DIRECT" }),
    } as unknown as NonNullable<Window["llmUsage"]>;
    const wrapper = mount(App);
    await vi.waitFor(() => expect(wrapper.text()).toContain("te***@example.test"));
    expect(wrapper.text()).not.toMatch(/accessToken|refreshToken|idToken/);
    const settingsButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("设置"));
    expect(settingsButton).toBeDefined();
    await settingsButton!.trigger("click");
    await vi.waitFor(() => expect(wrapper.text()).toContain("DIRECT"));
  });
});
