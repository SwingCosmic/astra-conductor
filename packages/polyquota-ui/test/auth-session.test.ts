import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AuthStartResult,
  PublicAccount,
  PublicAuthSession,
  ServiceResult,
} from "@astra-conductor/polyquota-contract";
import AuthModal from "../src/components/AuthModal.vue";
import { EmptyPolyQuotaService } from "../src/services/polyquota-service";
import { polyQuotaServiceKey } from "../src/services/polyquota-service-vue";
import { catalogPresentations } from "../src/presentation";

const key = "polyquota.auth.codex";
const pending: PublicAuthSession = {
  sessionId: "session-1",
  offeringId: "codex",
  method: "device-code",
  interaction: "device-code",
  status: "pending",
  createdAt: new Date().toISOString(),
  expiresAt: null,
  userCode: "ABCD-1234",
  verificationUri: "https://provider.test/device",
};

async function setup() {
  vi.useFakeTimers();
  const service = new EmptyPolyQuotaService();
  const snapshot = await service.getSnapshot();
  if (!snapshot.ok) throw new Error("fixture missing");
  const provider = catalogPresentations(snapshot.value.providers).find(
    (item) => item.id === "codex",
  )!;
  const account = snapshot.value.accounts[0]!;
  const start = vi.spyOn(service, "startAuth");
  const finish = vi.spyOn(service, "finishAuth");
  const cancel = vi.spyOn(service, "cancelAuth").mockResolvedValue({ ok: true, value: undefined });
  const query = vi.spyOn(service, "getAuthSession").mockResolvedValue({ ok: true, value: pending });
  const open = () =>
    mount(AuthModal, {
      props: { provider },
      global: { provide: { [polyQuotaServiceKey as symbol]: service } },
    });
  return { start, finish, cancel, query, open, account };
}

afterEach(() => {
  sessionStorage.clear();
  vi.useRealTimers();
});

describe("auth session restoration", () => {
  it("restores device presentation without starting or polling and keeps the id on unmount", async () => {
    const { start, finish, cancel, query, open } = await setup();
    sessionStorage.setItem(key, pending.sessionId);
    const wrapper = open();
    await flushPromises();
    expect(wrapper.text()).toContain("ABCD-1234");
    expect(wrapper.get(".verification-uri").attributes("href")).toBe(pending.verificationUri);
    expect(start).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(cancel).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBe(pending.sessionId);
    await vi.advanceTimersByTimeAsync(5000);
    expect(query).toHaveBeenCalledOnce();
  });

  it("clears an unknown session after a backend restart without starting or cancelling anything", async () => {
    const { start, finish, cancel, query, open } = await setup();
    query.mockResolvedValue({
      ok: false,
      error: { code: "not-found", message: "授权会话不存在", retryable: false },
    });
    sessionStorage.setItem(key, pending.sessionId);
    const wrapper = open();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(wrapper.text()).toContain("授权会话不存在");
    expect(query).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("cancels an explicitly closed restored session", async () => {
    const { cancel, open } = await setup();
    sessionStorage.setItem(key, pending.sessionId);
    const wrapper = open();
    await flushPromises();
    await wrapper.get('button[aria-label="关闭"]').trigger("click");
    expect(cancel).toHaveBeenCalledWith(pending.sessionId);
    expect(sessionStorage.getItem(key)).toBeNull();
    wrapper.unmount();
  });

  it("recovers a retained terminal account and never repeats start or finish", async () => {
    const { query, start, finish, open, account } = await setup();
    query.mockResolvedValue({ ok: true, value: { ...pending, status: "completed", account } });
    sessionStorage.setItem(key, pending.sessionId);
    const wrapper = open();
    await flushPromises();
    expect(wrapper.emitted("connected")).toEqual([[account]]);
    expect(start).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBeNull();
    wrapper.unmount();
  });

  it("does not lose reload recovery when an in-flight finish returns to an unmounted component", async () => {
    const { finish, open, account, cancel } = await setup();
    let resolve!: (value: ServiceResult<PublicAccount>) => void;
    finish.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    sessionStorage.setItem(key, pending.sessionId);
    const wrapper = open();
    await flushPromises();
    await wrapper.get("footer .primary-action").trigger("click");
    wrapper.unmount();
    resolve({ ok: true, value: account });
    await flushPromises();
    expect(sessionStorage.getItem(key)).toBe(pending.sessionId);
    expect(cancel).not.toHaveBeenCalled();
    expect(wrapper.emitted("connected")).toBeUndefined();
  });

  it("reports completion only once when the detail poll wins the finish race", async () => {
    const { query, finish, open, account } = await setup();
    let resolve!: (value: ServiceResult<PublicAccount>) => void;
    finish.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    sessionStorage.setItem(key, pending.sessionId);
    const wrapper = open();
    await flushPromises();
    await wrapper.get("footer .primary-action").trigger("click");
    query.mockResolvedValue({ ok: true, value: { ...pending, status: "completed", account } });
    await vi.advanceTimersByTimeAsync(1500);
    resolve({ ok: true, value: account });
    await flushPromises();
    expect(wrapper.emitted("connected")).toEqual([[account]]);
    wrapper.unmount();
  });

  it("cancels a late start only after an explicit close", async () => {
    const { start, cancel, open } = await setup();
    let resolve!: (value: ServiceResult<AuthStartResult>) => void;
    start.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const wrapper = open();
    const tab = wrapper
      .findAll(".auth-tabs button")
      .find((button) => button.text().includes("设备码"))!;
    await tab.trigger("click");
    await wrapper.get("footer .primary-action").trigger("click");
    await wrapper.get('button[aria-label="关闭"]').trigger("click");
    wrapper.unmount();
    resolve({
      ok: true,
      value: {
        status: "pending",
        sessionId: pending.sessionId,
        interaction: "device-code",
        userCode: pending.userCode!,
        verificationUri: pending.verificationUri!,
      },
    });
    await flushPromises();
    expect(cancel).toHaveBeenCalledWith(pending.sessionId);
    expect(sessionStorage.getItem(key)).toBeNull();
  });
});
