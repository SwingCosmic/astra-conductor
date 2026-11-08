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
  it("uses API capability rather than component version while keeping return-to-private available", async () => {
    const status: CredentialSharingStatus = {
      available: true,
      installState: "incompatible",
      installedVersion: "9.9.9",
      installedApiLevel: "2.124999999999999999",
      requiredApiLevel: "2.125",
      installationDirectory: "C:/test/old-install",
      localPackageDirectory: "C:/test/download/0.0.1",
      downloadState: "not-configured",
      localPackageState: "ready",
      directorySelectionAvailable: true,
      serviceState: "NOT_CHECKED",
      exportState: "none",
      vaultDirectory: "C:/test/vault",
      storageVersion: null,
      recordCount: 0,
      frozen: false,
      deliveryAcknowledged: false,
      rememberedKey: false,
      selectedBackend: "private",
      activeBackend: "private",
      sharingState: "none",
      snapshotAt: null,
      keyCleanupPending: false,
      sessionCleanupPending: false,
      brokerOwnership: "NOT_CHECKED",
      lastError: null,
    };
    const sharing = {
      getStatus: vi.fn(async () => ({ ok: true as const, value: { ...status } })),
      install: vi.fn(async () => {
        status.installState = "installed";
        status.installedVersion = "0.0.1";
        status.installedApiLevel = "2.125";
        return { ok: true as const, value: undefined };
      }),
      exportCredentials: vi.fn(),
      enableShared: vi.fn(),
      returnToPrivate: vi.fn(async () => {
        Object.assign(status, {
          selectedBackend: "private",
          activeBackend: "private",
          sharingState: "private",
        });
        return { ok: true as const, value: undefined };
      }),
      rejoinShared: vi.fn(async () => ({ ok: true as const, value: undefined })),
    };
    const service = Object.assign(new EmptyPolyQuotaService(), {
      credentials: {
        ...new EmptyPolyQuotaService().credentials,
        ...sharing,
        cancelExport:
          "cancel" in sharing
            ? sharing.cancel
            : new EmptyPolyQuotaService().credentials.cancelExport,
      },
    });
    const wrapper = mount(CredentialStorageManager, {
      global: {
        provide: {
          [polyQuotaServiceKey as symbol]: service,
          [credentialServiceKey as symbol]: service.credentials,
        },
      },
    });
    const button = (label: string) =>
      wrapper.findAll("button").find((item) => item.text() === label)!;
    const reload = async () => {
      await button("重新检查").trigger("click");
      await flushPromises();
    };
    await flushPromises();
    expect(wrapper.text()).toContain("当前凭据共享服务不满足应用的通信或接口要求");
    expect(wrapper.text()).toContain("支持 API 2.125 及以上的兼容组件");
    expect(wrapper.text()).toContain("当前组件 API 2.124999999999999999");
    expect(wrapper.text()).toContain("版本 9.9.9");
    expect(wrapper.text()).not.toContain("最低兼容版本");
    expect(button("准备导出").attributes("disabled")).toBeDefined();
    expect(button("安装兼容本地包").attributes("disabled")).toBeUndefined();
    await button("准备导出").trigger("click");
    expect(sharing.exportCredentials).not.toHaveBeenCalled();
    Object.assign(status, { exportState: "exported", deliveryAcknowledged: true, frozen: true });
    await reload();
    expect(button("启用共享").attributes("disabled")).toBeDefined();
    await button("启用共享").trigger("click");
    expect(sharing.enableShared).not.toHaveBeenCalled();
    Object.assign(status, {
      selectedBackend: "shared",
      activeBackend: "unavailable",
      sharingState: "active",
      frozen: false,
    });
    await reload();
    expect(button("返回内置存储").attributes("disabled")).toBeUndefined();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await button("返回内置存储").trigger("click");
    await flushPromises();
    expect(sharing.returnToPrivate).toHaveBeenCalledWith(true);
    expect(
      wrapper.get('input[aria-label="重新输入迁移密钥"]').attributes("disabled"),
    ).toBeDefined();
    expect(button("验证并恢复共享").attributes("disabled")).toBeDefined();
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(sharing.rejoinShared).not.toHaveBeenCalled();
    await button("安装兼容本地包").trigger("click");
    await flushPromises();
    expect(sharing.install).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain("版本 0.0.1");
    expect(wrapper.text()).toContain("当前组件 API 2.125");
    await wrapper.get('input[aria-label="重新输入迁移密钥"]').setValue("acm1_FICTIONAL-REENTRY");
    expect(button("验证并恢复共享").attributes("disabled")).toBeUndefined();
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(sharing.rejoinShared).toHaveBeenCalledWith("acm1_FICTIONAL-REENTRY");
    confirm.mockRestore();
    wrapper.unmount();
  });
  it("shows explicit delivery, clears the migration key after acknowledgement and never treats export as shared", async () => {
    const status: CredentialSharingStatus = {
      available: true,
      installState: "installed",
      installedVersion: "0.2.0",
      installedApiLevel: "2",
      requiredApiLevel: "2",
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
      sharingState: "none",
      snapshotAt: null,
      keyCleanupPending: false,
      sessionCleanupPending: false,
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
      enableShared: vi.fn(async () => ({ ok: true as const, value: undefined })),
      returnToPrivate: vi.fn(async (_accepted: boolean) => {
        Object.assign(status, {
          selectedBackend: "private",
          activeBackend: "private",
          sharingState: "private",
          rememberedKey: false,
        });
        return { ok: true as const, value: undefined };
      }),
      rejoinShared: vi.fn(async (_key: string) => {
        Object.assign(status, {
          selectedBackend: "shared",
          activeBackend: "shared",
          sharingState: "active",
          rememberedKey: true,
        });
        return { ok: true as const, value: undefined };
      }),
    };
    const service = Object.assign(new EmptyPolyQuotaService(), {
      credentials: {
        ...new EmptyPolyQuotaService().credentials,
        ...sharing,
        cancelExport:
          "cancel" in sharing
            ? sharing.cancel
            : new EmptyPolyQuotaService().credentials.cancelExport,
      },
    });
    const wrapper = mount(CredentialStorageManager, {
      global: {
        provide: {
          [polyQuotaServiceKey as symbol]: service,
          [credentialServiceKey as symbol]: service.credentials,
        },
      },
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
    Object.assign(status, {
      exportState: "exported",
      selectedBackend: "shared",
      activeBackend: "shared",
      sharingState: "active",
    });
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "重新检查")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("已建立共享");
    expect(wrapper.text()).not.toContain("等待接收方导入");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "返回内置存储")!
      .trigger("click");
    await flushPromises();
    expect(sharing.returnToPrivate).toHaveBeenCalledWith(true);
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("令牌轮换可能使另一侧失效"));
    await wrapper.get('input[aria-label="重新输入迁移密钥"]').setValue("acm1_REENTRY-FICTIONAL");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(sharing.rejoinShared).toHaveBeenCalledWith("acm1_REENTRY-FICTIONAL");
    expect(wrapper.find('input[aria-label="重新输入迁移密钥"]').exists()).toBe(false);
    expect(wrapper.html()).not.toContain("acm1_REENTRY-FICTIONAL");
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
