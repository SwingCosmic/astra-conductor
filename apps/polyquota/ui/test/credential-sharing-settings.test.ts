import { FetchServiceTransport } from "@astra-conductor/shared-ui/services";
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  CredentialsPage as CredentialStorageManager,
  credentialServiceKey,
} from "@astra-conductor/shared-ui";
import SettingsView from "../src/pages/SettingsView.vue";
import { HttpPolyQuotaService } from "../src/services/http-polyquota-service";
import { EmptyPolyQuotaService } from "../src/services/polyquota-service";
import { polyQuotaServiceKey } from "../src/services/polyquota-service-vue";
import type { CredentialSharingStatus } from "@astra-conductor/contract/polyquota";

describe("credential sharing settings", () => {
  it("blocks migration to an incompatible broker while preserving the private return path", async () => {
    const status: CredentialSharingStatus = {
      available: true,
      installState: "incompatible",
      installedVersion: "9.9.9",
      installedApiLevel: "2",
      requiredApiLevel: "3",
      installationDirectory: null,
      localPackageDirectory: "package",
      downloadState: "not-configured",
      localPackageState: "ready",
      directorySelectionAvailable: false,
      serviceState: "UNAVAILABLE",
      migrationState: "export-ready",
      vaultDirectory: "C:/vault",
      storageVersion: "version",
      recordCount: 1,
      frozen: false,
      deliveryAcknowledged: true,
      rememberedKey: true,
      selectedBackend: "private",
      activeBackend: "private",
      snapshotAt: null,
      keyCleanupPending: false,
      sessionCleanupPending: false,
      brokerOwnership: "broker",
      lastError: null,
    };
    const service = new EmptyPolyQuotaService();
    const sharing = {
      ...service.credentials,
      getStatus: async () => ({ ok: true as const, value: { ...status } }),
    };
    const wrapper = mount(CredentialStorageManager, {
      global: { provide: { [credentialServiceKey as symbol]: sharing } },
    });
    const button = (label: string) =>
      wrapper.findAll("button").find((item) => item.text() === label)!;
    await flushPromises();
    expect(button("迁移到共享存储").attributes("disabled")).toBeDefined();
    expect(button("安装兼容本地包").attributes("disabled")).toBeUndefined();
    Object.assign(status, {
      migrationState: "shared",
      selectedBackend: "shared",
      activeBackend: "unavailable",
    });
    await button("重新检查").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("已选共享，当前不可用");
    expect(button("准备返回内置存储").attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });
  it("opens credential management from a compact settings entry and can return", async () => {
    const service = new EmptyPolyQuotaService();
    const snapshot = await service.getSnapshot();
    if (!snapshot.ok) throw new Error("missing fixture");
    const wrapper = mount(SettingsView, {
      props: { settings: snapshot.value.settings, scheduler: snapshot.value.scheduler },
      global: {
        provide: {
          [polyQuotaServiceKey as symbol]: service,
          [credentialServiceKey as symbol]: service.credentials,
        },
        stubs: { HostStatus: true },
      },
    });
    await flushPromises();
    expect(wrapper.find('[aria-label="凭据存储管理"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("首次导出凭据");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "管理凭据存储")!
      .trigger("click");
    expect(wrapper.find('[aria-label="凭据存储管理"]').exists()).toBe(true);
    expect(wrapper.find(".settings-page").exists()).toBe(false);
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "返回设置")!
      .trigger("click");
    expect(wrapper.find(".settings-page").exists()).toBe(true);
    wrapper.unmount();
  });
  it("keeps cancellation from the native directory picker as a nullable result", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL) => new Response(JSON.stringify({ ok: true, value: null })),
    );
    const service = new HttpPolyQuotaService(
      new FetchServiceTransport({ baseUrl: "http://localhost", fetchImpl: fetcher }),
    );
    expect(await service.credentials.selectDirectory()).toEqual({ ok: true, value: null });
    expect(fetcher.mock.calls[0][0]).toBe(
      "http://localhost/api/v1/credential-sharing/select-directory",
    );
  });
});
