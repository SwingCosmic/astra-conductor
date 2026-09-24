import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import QuotaCard from "../src/components/QuotaCard.vue";

const account = {
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
  it("renders Codex quota data and account controls", () => {
    const wrapper = mount(QuotaCard, {
      props: {
        account,
        busy: false,
        usage: {
          accountId: account.id,
          plan: "plus",
          groups: [
            {
              key: "default",
              title: null,
              quotas: [
                {
                  key: "session",
                  title: "5-hour",
                  used: 20,
                  total: 100,
                  remaining: 80,
                  remainingPercentage: 80,
                  resetAt: null,
                  unlimited: false,
                },
                {
                  key: "weekly",
                  title: "Weekly",
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
          extras: [{ key: "reset-credits", label: "Reset credits", value: "1" }],
          fetchedAt: "2026-09-24T00:00:00.000Z",
        },
      },
    });
    expect(wrapper.text()).toContain("5-hour");
    expect(wrapper.text()).toContain("Weekly");
    expect(wrapper.text()).toContain("Reset credits");
    expect(wrapper.findAll("button")).toHaveLength(3);
  });

  it("renders provider-independent quota groups", () => {
    const wrapper = mount(QuotaCard, {
      props: {
        account: { ...account, provider: "antigravity" },
        busy: false,
        usage: {
          accountId: account.id,
          plan: "Starter",
          groups: [
            {
              key: "gemini-models",
              title: "Gemini Models",
              quotas: [
                {
                  key: "weekly",
                  title: "Weekly Quota",
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
    expect(wrapper.text()).toContain("已用 25 / 100");
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
    expect(wrapper.text()).toContain("当前代理：DIRECT");
  });
});
