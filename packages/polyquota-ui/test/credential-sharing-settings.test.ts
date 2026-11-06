import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import CredentialStorageManager from "../src/components/CredentialStorageManager.vue";
import SettingsView from "../src/views/SettingsView.vue";
import { HttpPolyQuotaService } from "../src/services/http-polyquota-service";
import { EmptyPolyQuotaService } from "../src/services/polyquota-service";
import { polyQuotaServiceKey } from "../src/services/polyquota-service-vue";
import type { CredentialSharingStatus } from "@astra-conductor/polyquota-contract";

describe("credential sharing settings", () => {
  it("shows explicit delivery, clears the migration key after acknowledgement and never treats export as shared", async () => {
    const status: CredentialSharingStatus = {
      available: true,
      installState: "installed",
      installedVersion: "0.1.0",
      installationDirectory: "C:/test/install",
      localPackageDirectory: "C:/test/download",
      downloadState: "not-configured",
      localPackageState: "ready",
      directorySelectionAvailable: true,
      serviceState: "STOPPED",
      exportState: "none",
      vaultDirectory: null,
      storageVersion: null,
      recordCount: 0,
      frozen: false,
      deliveryAcknowledged: false,
      rememberedKey: false,
      selectedBackend: "private",
      activeBackend: "private",
      brokerOwnership: "source",
      lastError: null,
    };
    const sharing = {
      selectDirectory: vi.fn(async () => ({ ok: true as const, value: "C:/test/vault" })),
      getStatus: vi.fn(async () => ({ ok: true as const, value: { ...status } })),
      install: vi.fn(async () => ({ ok: true as const, value: undefined })),
      uninstall: vi.fn(async () => ({ ok: true as const, value: undefined })),
      exportCredentials: vi.fn(async () => {
        Object.assign(status, {
          exportState: "exported",
          frozen: true,
          rememberedKey: true,
          vaultDirectory: "C:/test/vault",
        });
        return {
          ok: true as const,
          value: { migrationKey: "acm1_FICTIONAL", storageVersion: "version" },
        };
      }),
      acknowledgeDelivery: vi.fn(async () => {
        status.deliveryAcknowledged = true;
        return { ok: true as const, value: undefined };
      }),
      cancel: vi.fn(async () => {
        Object.assign(status, { exportState: "cancelled", frozen: false });
        return { ok: true as const, value: undefined };
      }),
    };
    const service = Object.assign(new EmptyPolyQuotaService(), { credentialSharing: sharing });
    const wrapper = mount(CredentialStorageManager, {
      global: { provide: { [polyQuotaServiceKey as symbol]: service } },
    });
    await flushPromises();
    expect(wrapper.find('input[aria-label="共享目录"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="凭据服务组件"]').text()).toContain("下载状态");
    expect(wrapper.find('[aria-label="凭据服务运行状态"]').text()).toContain("尚未配置共享目录");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "选择文件夹")!
      .trigger("click");
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "准备导出")!
      .trigger("click");
    expect(sharing.exportCredentials).not.toHaveBeenCalled();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "确认导出")!
      .trigger("click");
    await flushPromises();
    expect(sharing.exportCredentials).toHaveBeenCalledWith("C:/test/vault");
    expect(wrapper.get("textarea").element.value).toBe("acm1_FICTIONAL");
    expect(wrapper.text()).toContain("导出成功，等待建立共享");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "我已保存迁移密钥")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.find("textarea").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("acm1_FICTIONAL");
    expect(wrapper.text()).toContain("等待接收方导入");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "取消共享切换")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("已恢复使用内置存储独立更新凭据");
    expect(wrapper.text()).toContain("已取消切换，保留原导出记录");
    expect(wrapper.text()).not.toContain("等待");
    expect(wrapper.text()).not.toContain("接收方");
    expect(wrapper.text()).not.toContain("共享凭据更新权");
    expect(wrapper.find("textarea").exists()).toBe(false);
    confirm.mockRestore();
    wrapper.unmount();
  });
  it("opens credential management from a compact settings entry and can return", async () => {
    const service = new EmptyPolyQuotaService();
    const snapshot = await service.getSnapshot();
    if (!snapshot.ok) throw new Error("missing fixture");
    const wrapper = mount(SettingsView, {
      props: { settings: snapshot.value.settings, scheduler: snapshot.value.scheduler },
      global: {
        provide: { [polyQuotaServiceKey as symbol]: service },
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
    const service = new HttpPolyQuotaService("http://localhost", fetcher);
    expect(await service.credentialSharing.selectDirectory()).toEqual({ ok: true, value: null });
    expect(fetcher.mock.calls[0][0]).toBe(
      "http://localhost/v1/polyquota/credential-sharing/selectDirectory",
    );
  });
});
