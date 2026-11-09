import { mount, flushPromises } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type {
  CredentialManagementStatus,
  ICredentialManagementService,
  IProviderService,
  ProviderManagementSnapshot,
  ServiceResult,
} from "@astra-conductor/contract/common";
import {
  AppShell,
  AuthDialog,
  CredentialsPage,
  ProvidersPage,
  credentialServiceKey,
  providerServiceKey,
  providerUiOptionsKey,
} from "../src/index";

const unavailable = <T>(): Promise<ServiceResult<T>> =>
  Promise.resolve({
    ok: false,
    error: { code: "unavailable", message: "功能不可用", retryable: false },
  });
const snapshot = (instanceId = "instance-1", revision = 0): ProviderManagementSnapshot => ({
  schemaVersion: 1,
  instanceId,
  revision,
  generatedAt: "2026-11-08T00:00:00Z",
  stamp: { instanceId, revision, scope: "providers" },
  backend: { contextId: instanceId, selected: "shared", active: "unavailable" },
  accounts: [],
  connections: [],
  providers: [
    {
      provider: "test",
      displayName: "Test",
      offerings: [
        {
          id: "test",
          provider: "test",
          displayName: "Test",
          authMethods: [{ method: "api-key", interaction: "secret-form" }],
          plans: [],
        },
      ],
    },
  ],
  actions: { startAuth: { state: "disabled", reason: "共享服务尚未连接" } },
});
function providers(): IProviderService {
  return {
    getSnapshot: async () => ({ ok: true, value: snapshot() }),
    subscribe: () => () => {},
    startAuth: unavailable,
    getAuthSession: unavailable,
    finishAuth: unavailable,
    cancelAuth: unavailable,
    setAccountEnabled: unavailable,
    deleteAccount: unavailable,
    refreshCredentials: unavailable,
  };
}
const status: CredentialManagementStatus = {
  available: true,
  installState: "installed",
  installedVersion: "1.0.0",
  requiredApiLevel: "2",
  installationDirectory: null,
  localPackageDirectory: "C:/package",
  localPackageState: "ready",
  downloadState: "not-configured",
  directorySelectionAvailable: false,
  serviceState: "READY",
  migrationState: "private",
  vaultDirectory: "C:/vault",
  storageVersion: null,
  recordCount: 0,
  frozen: false,
  deliveryAcknowledged: false,
  rememberedKey: false,
  selectedBackend: "private",
  activeBackend: "private",
  snapshotAt: null,
  keyCleanupPending: false,
  sessionCleanupPending: false,
  brokerOwnership: "broker",
  lastError: null,
  role: "receiver",
  privateAvailable: true,
  capabilities: { verifyImport: { state: "enabled" }, confirmImport: { state: "enabled" } },
};
function credentials(): ICredentialManagementService {
  return {
    getStatus: async () => ({ ok: true, value: status }),
    subscribe: () => () => {},
    selectDirectory: unavailable,
    install: unavailable,
    uninstall: unavailable,
    exportCredentials: unavailable,
    resumeExport: unavailable,
    restartExport: unavailable,
    acknowledgeDelivery: unavailable,
    cancel: unavailable,
    cancelExport: unavailable,
    enableShared: unavailable,
    switchToPrivate: unavailable,
    relocate: unavailable,
    returnToPrivate: unavailable,
    rejoinShared: unavailable,
    verifyImport: unavailable,
    confirmImport: unavailable,
    cancelPreview: unavailable,
    retry: unavailable,
  };
}

describe("shared management pages", () => {
  const page = (service: ICredentialManagementService) =>
    mount(CredentialsPage, {
      global: { provide: { [credentialServiceKey as symbol]: service } },
    });
  it("keeps the verified import and private backend across status refresh and a retryable failure", async () => {
    const service = credentials();
    const wrapper = page(service);
    const button = (label: string) =>
      wrapper.findAll("button").find((item) => item.text() === label)!;
    vi.spyOn(service, "verifyImport").mockResolvedValue({
      ok: true,
      value: { previewId: "preview", storageVersion: "v1", recordCount: 0, accounts: [] },
    });
    const confirm = vi
      .spyOn(service, "confirmImport")
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "secure-storage", message: "保存失败", retryable: true },
      })
      .mockImplementation(async () => {
        service.getStatus = async () => ({
          ok: true,
          value: { ...status, migrationState: "import-ready", rememberedKey: true },
        });
        return { ok: true, value: undefined };
      });
    await flushPromises();
    await button("导入凭据").trigger("click");
    expect(wrapper.find('[aria-label="导出目录"]').exists()).toBe(false);
    await wrapper.get('[aria-label="导入目录"]').setValue("C:/new");
    await wrapper.get('[aria-label="导入迁移密钥"]').setValue("fictional");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect((wrapper.get('input[type="password"]').element as HTMLInputElement).value).toBe("");
    await button("重新检查").trigger("click");
    await flushPromises();
    await button("确认导入").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("保存失败");
    expect(wrapper.find('[aria-label="导入预览"]').exists()).toBe(true);
    await button("确认导入").trigger("click");
    await flushPromises();
    expect(confirm.mock.calls).toEqual([["preview"], ["preview"]]);
    expect(wrapper.text()).toContain("导入成功，等待迁移");
    expect(button("迁移到共享存储")).toBeDefined();
    wrapper.unmount();
  });

  it("restores a live host preview after reopening, and expires only the preview", async () => {
    const service = credentials();
    const operation = { id: "import-op", kind: "import", vaultDirectory: "C:/chosen" };
    let current: CredentialManagementStatus = {
      ...status,
      operation,
      importPreview: { previewId: "p", storageVersion: "v", recordCount: 0, accounts: [] },
    };
    service.getStatus = async () => ({ ok: true, value: current });
    const wrapper = page(service);
    await flushPromises();
    expect(wrapper.find('[aria-label="导入预览"]').exists()).toBe(true);
    current = { ...current, importPreview: null };
    await wrapper
      .findAll("button")
      .find((item) => item.text() === "重新检查")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.find('[aria-label="导入预览"]').exists()).toBe(false);
    expect((wrapper.get('[aria-label="导入目录"]').element as HTMLInputElement).value).toBe(
      "C:/chosen",
    );
    wrapper.unmount();
  });

  it("recovers an outstanding delivery in shared mode and clears it on acknowledgement", async () => {
    const service = credentials();
    let current: CredentialManagementStatus = {
      ...status,
      migrationState: "shared",
      selectedBackend: "shared",
      activeBackend: "shared",
      storageVersion: "v1",
      rememberedKey: true,
      capabilities: { recoverDelivery: { state: "enabled" } },
    };
    service.getStatus = async () => ({ ok: true, value: current });
    service.resumeExport = async () => ({
      ok: true,
      value: { storageVersion: "v1", migrationKey: "fictional-delivery" },
    });
    service.acknowledgeDelivery = async () => {
      current = { ...current, deliveryAcknowledged: true };
      return { ok: true, value: undefined };
    };
    const wrapper = page(service);
    const button = (label: string) =>
      wrapper.findAll("button").find((item) => item.text() === label)!;
    await flushPromises();
    await button("恢复密钥交付").trigger("click");
    await flushPromises();
    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe(
      "fictional-delivery",
    );
    await button("我已保存").trigger("click");
    await flushPromises();
    expect(wrapper.find("textarea").exists()).toBe(false);
    expect(wrapper.text()).toContain("迁移完成");
    wrapper.unmount();
  });
  it("keeps the two return steps separate and never offers a private form to a Web host", async () => {
    const service = credentials();
    let current: CredentialManagementStatus = {
      ...status,
      migrationState: "shared",
      selectedBackend: "shared",
      activeBackend: "shared",
      rememberedKey: true,
    };
    service.getStatus = async () => ({ ok: true, value: current });
    const prepare = vi.spyOn(service, "returnToPrivate").mockImplementation(async () => {
      current = { ...current, migrationState: "private-ready" };
      return { ok: true, value: undefined };
    });
    const switchBackend = vi.spyOn(service, "switchToPrivate");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const wrapper = page(service);
    const button = (label: string) =>
      wrapper.findAll("button").find((item) => item.text() === label)!;
    await flushPromises();
    await button("准备返回内置存储").trigger("click");
    await flushPromises();
    expect(prepare).toHaveBeenCalledWith(true);
    expect(switchBackend).not.toHaveBeenCalled();
    expect(button("切换到内置存储")).toBeDefined();
    expect(wrapper.text()).toContain("已记住");
    current = {
      ...current,
      migrationState: null,
      privateAvailable: false,
      activeBackend: "unavailable",
    };
    await button("重新检查").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("尚未接入共享");
    expect(button("导入凭据")).toBeUndefined();
    expect(button("准备返回内置存储")).toBeUndefined();
    confirm.mockRestore();
    wrapper.unmount();
  });
  it("renders product-injected navigation and the purple theme", async () => {
    const wrapper = mount(AppShell, {
      props: {
        brand: { name: "GraphAgent", icon: "brand.svg", theme: "purple" },
        activeId: "home",
        navigation: [
          { id: "home", label: "主页" },
          { id: "providers", label: "服务商" },
        ],
      },
      slots: { default: "Product page" },
    });
    expect(wrapper.classes()).toContain("theme-purple");
    await wrapper.findAll("nav button")[1]!.trigger("click");
    expect(wrapper.emitted("navigate")).toEqual([["providers"]]);
    expect(wrapper.text()).toContain("Product page");
    wrapper.unmount();
  });
  it("shows host restrictions and never calls authentication when a broker is unavailable", async () => {
    const service = providers();
    const start = vi.spyOn(service, "startAuth");
    const stop = vi.fn();
    service.subscribe = () => stop;
    const wrapper = mount(ProvidersPage, {
      global: { provide: { [providerServiceKey as symbol]: service } },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("共享服务尚未连接");
    const add = wrapper.findAll("button").find((button) => button.text() === "添加账号")!;
    expect(add.attributes("disabled")).toBeDefined();
    await add.trigger("click");
    expect(start).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("clears a submitted secret and uses the injected product session namespace", async () => {
    const service = providers();
    const start = vi.spyOn(service, "startAuth").mockImplementation(unavailable);
    const wrapper = mount(AuthDialog, {
      props: {
        provider: {
          id: "test",
          provider: "test",
          name: "Test",
          mark: "T",
          description: "",
          authMethods: [{ id: "api-key", label: "API Key", interaction: "secret-form" }],
        },
      },
      global: {
        provide: {
          [providerServiceKey as symbol]: service,
          [providerUiOptionsKey as symbol]: { sessionPrefix: "graphagent" },
        },
      },
    });
    await wrapper.get('input[type="password"]').setValue("fictional-secret");
    await wrapper.get("footer .primary-action").trigger("click");
    await flushPromises();
    expect(start).toHaveBeenCalledWith(
      { offeringId: "test", method: "api-key", apiKey: "fictional-secret" },
      undefined,
    );
    expect((wrapper.get('input[type="password"]').element as HTMLInputElement).value).toBe("");
    expect(sessionStorage.getItem("graphagent.auth.test")).toBeNull();
    wrapper.unmount();
  });
});
