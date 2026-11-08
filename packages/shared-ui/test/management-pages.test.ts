import { mount, flushPromises } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type {
  CredentialManagementStatus,
  CredentialExportDelivery,
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
  exportState: "none",
  vaultDirectory: "C:/vault",
  storageVersion: null,
  recordCount: 0,
  frozen: false,
  deliveryAcknowledged: false,
  rememberedKey: false,
  selectedBackend: "shared",
  activeBackend: "unavailable",
  sharingState: "none",
  snapshotAt: null,
  keyCleanupPending: false,
  sessionCleanupPending: false,
  brokerOwnership: "broker",
  lastError: null,
  role: "receiver",
  privateAvailable: false,
  importState: "none",
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
    returnToPrivate: unavailable,
    rejoinShared: unavailable,
    verifyImport: unavailable,
    confirmImport: unavailable,
    cancelPreview: unavailable,
    retry: unavailable,
  };
}

describe("shared management pages", () => {
  it("clears an expired import preview and asks for verification again", async () => {
    const service = credentials();
    vi.spyOn(service, "verifyImport").mockResolvedValue({
      ok: true,
      value: { previewId: "expired-preview", recordCount: 0, storageVersion: "old", accounts: [] },
    });
    vi.spyOn(service, "confirmImport").mockResolvedValue({
      ok: false,
      error: {
        code: "import-preview-expired",
        message: "导入预览已过期，请重新验证",
        retryable: false,
      },
    });
    const wrapper = mount(CredentialsPage, {
      global: { provide: { [credentialServiceKey as symbol]: service } },
    });
    await flushPromises();
    await wrapper.get('input[aria-label="导入迁移密钥"]').setValue("first-key");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((item) => item.text() === "确认导入")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.find('[aria-label="导入预览"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("导入预览已过期，请重新验证");
    wrapper.unmount();
  });

  it("retires the old preview when a replacement verification fails", async () => {
    const service = credentials();
    vi.spyOn(service, "verifyImport")
      .mockResolvedValueOnce({
        ok: true,
        value: {
          previewId: "retired-preview",
          recordCount: 0,
          storageVersion: "old",
          accounts: [],
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "invalid-key", message: "新的迁移密钥无效", retryable: false },
      });
    const confirm = vi.spyOn(service, "confirmImport");
    const wrapper = mount(CredentialsPage, {
      global: { provide: { [credentialServiceKey as symbol]: service } },
    });
    await flushPromises();
    await wrapper.get('input[aria-label="导入迁移密钥"]').setValue("first-key");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.find('[aria-label="导入预览"]').exists()).toBe(true);
    await wrapper.get('input[aria-label="导入目录"]').setValue("C:/replacement-vault");
    await wrapper.get('input[aria-label="导入迁移密钥"]').setValue("invalid-key");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.find('[aria-label="导入预览"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("新的迁移密钥无效");
    expect(confirm).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("keeps an unconfirmed directory preview after a busy response and retries the same preview", async () => {
    const service = credentials();
    let current: CredentialManagementStatus = {
      ...status,
      instanceId: "host-1",
      contextId: "private-1",
      selectedBackend: "private",
      activeBackend: "private",
      importState: "import-ready",
      vaultDirectory: "C:/old-vault",
      accounts: [
        { id: "old", provider: "test", maskedIdentifier: "ol***", canRefresh: true, revision: "1" },
      ],
    };
    service.getStatus = async () => ({ ok: true, value: { ...current } });
    const verify = vi.spyOn(service, "verifyImport").mockResolvedValue({
      ok: true,
      value: {
        previewId: "new-preview",
        recordCount: 1,
        storageVersion: "new",
        accounts: [
          {
            id: "new",
            provider: "test",
            maskedIdentifier: "ne***",
            canRefresh: true,
            revision: "1",
          },
        ],
      },
    });
    const confirm = vi
      .spyOn(service, "confirmImport")
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "operation-in-progress",
          message: "后台正在处理凭据，请稍后重试",
          retryable: true,
        },
      })
      .mockImplementation(async () => {
        current = { ...current, vaultDirectory: "C:/new-vault" };
        return { ok: true, value: undefined };
      });
    const wrapper = mount(CredentialsPage, {
      global: { provide: { [credentialServiceKey as symbol]: service } },
    });
    await flushPromises();
    await wrapper.get('input[aria-label="导入目录"]').setValue("C:/new-vault");
    await wrapper.get('input[aria-label="导入迁移密钥"]').setValue("new-key");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(verify).toHaveBeenCalledWith({
      vaultDirectory: "C:/new-vault",
      migrationKey: "new-key",
    });
    expect(wrapper.text()).toContain("目录验证成功，仍需确认");
    expect(wrapper.text()).toContain("导入预览待确认，当前绑定尚未更改");
    expect(wrapper.get('[aria-label="已确认绑定目录"]').text()).toBe("C:/old-vault");
    expect(wrapper.get('[aria-label="待确认预览目录"]').text()).toBe("C:/new-vault");
    // Editing the next draft must not relabel an already verified preview.
    await wrapper.get('input[aria-label="导入目录"]').setValue("C:/other-draft");
    const confirmButton = () =>
      wrapper.findAll("button").find((item) => item.text() === "确认导入")!;
    await confirmButton().trigger("click");
    await flushPromises();
    expect(confirm).toHaveBeenNthCalledWith(1, "new-preview");
    expect(wrapper.text()).toContain("后台正在处理凭据，请稍后重试");
    expect(wrapper.text()).toContain("导入预览待确认，当前绑定尚未更改");
    expect(wrapper.get('[aria-label="已确认绑定目录"]').text()).toBe("C:/old-vault");
    expect(wrapper.get('[aria-label="待确认预览目录"]').text()).toBe("C:/new-vault");
    expect(wrapper.get('[aria-label="导入预览"]').text()).toContain("ne***");
    expect(confirmButton().attributes("disabled")).toBeUndefined();
    await confirmButton().trigger("click");
    await flushPromises();
    expect(confirm).toHaveBeenNthCalledWith(2, "new-preview");
    expect(wrapper.find('[aria-label="导入预览"]').exists()).toBe(false);
    expect(wrapper.get('[aria-label="已确认绑定目录"]').text()).toBe("C:/new-vault");
    expect((wrapper.get('input[aria-label="导入目录"]').element as HTMLInputElement).value).toBe(
      "C:/new-vault",
    );
    wrapper.unmount();
  });

  it("retains a receiver directory draft through refreshes until import confirmation or instance replacement", async () => {
    const service = credentials();
    let current: CredentialManagementStatus = {
      ...status,
      instanceId: "host-1",
      contextId: "private-1",
      selectedBackend: "private",
      activeBackend: "private",
      importState: "import-ready",
      vaultDirectory: "C:/old-vault",
      directorySelectionAvailable: true,
    };
    service.getStatus = async () => ({ ok: true, value: { ...current } });
    let changed = (): void => {};
    service.subscribe = (listener) => {
      changed = () =>
        listener({
          schemaVersion: 1,
          instanceId: current.instanceId!,
          revision: 1,
          occurredAt: "now",
          reasons: ["credentials"],
        });
      return () => {};
    };
    vi.spyOn(service, "selectDirectory").mockResolvedValue({ ok: true, value: "C:/new-vault" });
    const verify = vi.spyOn(service, "verifyImport").mockResolvedValue({
      ok: true,
      value: { previewId: "new-preview", recordCount: 0, storageVersion: "new", accounts: [] },
    });
    vi.spyOn(service, "cancelPreview").mockResolvedValue({ ok: true, value: undefined });
    const confirm = vi.spyOn(service, "confirmImport").mockImplementation(async () => {
      current = { ...current, vaultDirectory: "C:/confirmed-vault" };
      return { ok: true, value: undefined };
    });
    const wrapper = mount(CredentialsPage, {
      global: { provide: { [credentialServiceKey as symbol]: service } },
    });
    await flushPromises();
    const directory = () => wrapper.get('input[aria-label="导入目录"]');
    const directoryValue = () => (directory().element as HTMLInputElement).value;
    const button = (label: string) =>
      wrapper.findAll("button").find((item) => item.text() === label)!;
    expect(directoryValue()).toBe("C:/old-vault");
    await button("选择文件夹").trigger("click");
    await flushPromises();
    // The directory chooser itself reloads status when its operation finishes.
    expect(directoryValue()).toBe("C:/new-vault");
    await button("重新检查").trigger("click");
    await flushPromises();
    expect(directoryValue()).toBe("C:/new-vault");
    await wrapper.get('input[aria-label="导入迁移密钥"]').setValue("retired-key");
    current = { ...current, contextId: "private-2" };
    changed();
    await flushPromises();
    expect(directoryValue()).toBe("C:/new-vault");
    expect(
      (wrapper.get('input[aria-label="导入迁移密钥"]').element as HTMLInputElement).value,
    ).toBe("");
    await wrapper.get('input[aria-label="导入迁移密钥"]').setValue("new-key");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(verify).toHaveBeenLastCalledWith({
      vaultDirectory: "C:/new-vault",
      migrationKey: "new-key",
    });
    expect(directoryValue()).toBe("C:/new-vault");
    await button("取消预览").trigger("click");
    await flushPromises();
    await directory().setValue("C:/typed-vault");
    changed();
    await flushPromises();
    expect(directoryValue()).toBe("C:/typed-vault");
    await wrapper.get('input[aria-label="导入迁移密钥"]').setValue("typed-key");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(verify).toHaveBeenLastCalledWith({
      vaultDirectory: "C:/typed-vault",
      migrationKey: "typed-key",
    });
    await button("确认导入").trigger("click");
    await flushPromises();
    expect(confirm).toHaveBeenCalledWith("new-preview");
    expect(directoryValue()).toBe("C:/confirmed-vault");
    await directory().setValue("C:/unsaved-vault");
    current = { ...current, instanceId: "host-2", vaultDirectory: "C:/replacement-vault" };
    changed();
    await flushPromises();
    expect(directoryValue()).toBe("C:/replacement-vault");
    wrapper.unmount();
  });

  it("keeps pending shared records distinct from the selected private backend and reports retry honestly", async () => {
    const service = credentials();
    let current: CredentialManagementStatus = {
      ...status,
      instanceId: "host",
      contextId: "private",
      privateAvailable: true,
      selectedBackend: "private",
      activeBackend: "private",
      importState: "import-ready",
      connected: false,
      brokerOwnership: "source",
      accounts: [
        {
          id: "pending",
          provider: "codex",
          maskedIdentifier: "ma***",
          revision: "1",
          canRefresh: true,
        },
      ],
      capabilities: { retry: { state: "enabled" } },
    };
    service.getStatus = async () => ({ ok: true, value: current });
    const retry = vi.spyOn(service, "retry").mockResolvedValue({ ok: true, value: undefined });
    const wrapper = mount(CredentialsPage, {
      global: { provide: { [credentialServiceKey as symbol]: service } },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("所选凭据存储");
    expect(wrapper.text()).toContain("实际凭据后端");
    expect(wrapper.text()).toContain("待接管的共享凭据");
    expect(wrapper.text()).toContain("当前继续使用内置存储，可在服务商页管理本端账号");
    const button = wrapper.findAll("button").find((item) => item.text() === "重试共享连接")!;
    await button.trigger("click");
    await flushPromises();
    expect(retry).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("导入已就绪，等待来源应用启用共享");
    expect(wrapper.text()).not.toContain("已重新连接共享凭据");
    expect(wrapper.text()).not.toContain("共享已连接");
    current = {
      ...current,
      contextId: "shared",
      selectedBackend: "shared",
      activeBackend: "shared",
      importState: "shared",
      connected: true,
    };
    await button.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("共享凭据已连接");
    expect(wrapper.text()).toContain("共享已连接");
    wrapper.unmount();
  });

  it("offers separate cancelled-export recovery and a confirmed new-directory export", async () => {
    const service = credentials();
    let current: CredentialManagementStatus = {
      ...status,
      instanceId: "host",
      contextId: "private",
      role: "source",
      selectedBackend: "private",
      activeBackend: "private",
      exportState: "cancelled",
      storageVersion: "old-version",
      vaultDirectory: "C:/old-vault",
      directorySelectionAvailable: true,
      capabilities: {
        resumeExport: { state: "disabled", reason: "内置凭据已更新，请重新导出" },
        restartExport: { state: "enabled" },
      },
    };
    service.getStatus = async () => ({ ok: true, value: { ...current } });
    const resume = vi.spyOn(service, "resumeExport");
    vi.spyOn(service, "selectDirectory").mockResolvedValue({ ok: true, value: "C:/new-vault" });
    const restart = vi.spyOn(service, "restartExport").mockImplementation(async () => {
      current = {
        ...current,
        contextId: "new-export-context",
        exportState: "exported",
        storageVersion: "new-version",
        vaultDirectory: "C:/new-vault",
      };
      return {
        ok: true,
        value: { storageVersion: "new-version", migrationKey: "acm1_NEW-FICTIONAL" },
      };
    });
    const wrapper = mount(CredentialsPage, {
      global: { provide: { [credentialServiceKey as symbol]: service } },
    });
    await flushPromises();
    const find = (label: string) =>
      wrapper.findAll("button").find((item) => item.text() === label)!;
    expect(find("恢复原导出").attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("内置凭据已更新，请重新导出");
    await find("选择新目录重新导出").trigger("click");
    await flushPromises();
    expect(wrapper.get('[aria-label="确认重新导出"]').text()).toContain("C:/new-vault");
    expect(wrapper.get('[aria-label="共享目录"]').text()).toBe("C:/old-vault");
    expect(wrapper.text()).toContain("原导出目录、文件和密钥均保留");
    expect(restart).not.toHaveBeenCalled();
    await find("确认重新导出").trigger("click");
    await flushPromises();
    expect(resume).not.toHaveBeenCalled();
    expect(restart).toHaveBeenCalledWith("C:/new-vault");
    expect(
      (wrapper.get('textarea[aria-label="迁移密钥"]').element as HTMLTextAreaElement).value,
    ).toBe("acm1_NEW-FICTIONAL");
    expect(wrapper.get('[aria-label="共享目录"]').text()).toBe("C:/new-vault");
    wrapper.unmount();
  });

  it("resumes an acknowledged export without inventing a second key delivery", async () => {
    const service = credentials();
    let current: CredentialManagementStatus = {
      ...status,
      role: "source",
      selectedBackend: "private",
      activeBackend: "private",
      exportState: "cancelled",
      deliveryAcknowledged: true,
      capabilities: { resumeExport: { state: "enabled" }, restartExport: { state: "enabled" } },
    };
    service.getStatus = async () => ({ ok: true, value: current });
    const resume = vi.spyOn(service, "resumeExport").mockImplementation(async () => {
      current = { ...current, exportState: "exported" };
      return { ok: true, value: null };
    });
    const wrapper = mount(CredentialsPage, {
      global: { provide: { [credentialServiceKey as symbol]: service } },
    });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((item) => item.text() === "恢复原导出")!
      .trigger("click");
    await flushPromises();
    expect(resume).toHaveBeenCalledOnce();
    expect(wrapper.find("textarea").exists()).toBe(false);
    expect(wrapper.text()).toContain("迁移密钥已经确认交付");
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
  it("shows one receiver workflow, clears the migration key and confirms only the preview id", async () => {
    const service = credentials();
    let current: CredentialManagementStatus = { ...status };
    service.getStatus = async () => ({ ok: true, value: current });
    const verify = vi.spyOn(service, "verifyImport").mockResolvedValue({
      ok: true,
      value: {
        previewId: "preview-1",
        recordCount: 1,
        storageVersion: "1",
        accounts: [
          {
            id: "a1",
            provider: "test",
            maskedIdentifier: "te***",
            canRefresh: true,
            revision: "1",
          },
        ],
      },
    });
    const confirm = vi.spyOn(service, "confirmImport").mockImplementation(async () => {
      current = {
        ...current,
        importState: "import-ready",
        selectedBackend: "private",
        activeBackend: "private",
        connected: false,
      };
      return { ok: true, value: undefined };
    });
    const wrapper = mount(CredentialsPage, {
      global: { provide: { [credentialServiceKey as symbol]: service } },
    });
    await flushPromises();
    expect(wrapper.text()).not.toContain("导出与存储切换");
    await wrapper.get('input[aria-label="导入迁移密钥"]').setValue("fictional-migration-key");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(verify).toHaveBeenCalledWith({
      vaultDirectory: "C:/vault",
      migrationKey: "fictional-migration-key",
    });
    expect(
      (wrapper.get('input[aria-label="导入迁移密钥"]').element as HTMLInputElement).value,
    ).toBe("");
    expect(wrapper.text()).toContain("te***");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "确认导入")!
      .trigger("click");
    await flushPromises();
    expect(confirm).toHaveBeenCalledWith("preview-1");
    expect(wrapper.text()).toContain("导入已就绪，等待来源应用启用共享");
    expect(wrapper.text()).not.toContain("已接入共享凭据");
    wrapper.unmount();
  });

  it("closes an export confirmation and clears its directory after a backend or instance change", async () => {
    const service = credentials();
    let current: CredentialManagementStatus = {
      ...status,
      role: "source",
      instanceId: "host-1",
      contextId: "private-1",
      selectedBackend: "private",
      activeBackend: "private",
      vaultDirectory: "C:/old-vault",
    };
    service.getStatus = async () => ({ ok: true, value: { ...current } });
    let changed = (): void => {};
    service.subscribe = (listener) => {
      changed = () =>
        listener({
          schemaVersion: 1,
          instanceId: current.instanceId!,
          revision: 1,
          occurredAt: "now",
          reasons: ["credentials"],
        });
      return () => {};
    };
    const exportCredentials = vi.spyOn(service, "exportCredentials");
    const wrapper = mount(CredentialsPage, {
      global: { provide: { [credentialServiceKey as symbol]: service } },
    });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "准备导出")!
      .trigger("click");
    expect(wrapper.find('[aria-label="确认导出"]').exists()).toBe(true);
    // A restarted process may select an identical context label; instance identity still retires the form.
    current = { ...current, instanceId: "host-2", vaultDirectory: null };
    changed();
    await flushPromises();
    expect(wrapper.find('[aria-label="确认导出"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("C:/old-vault");
    expect(wrapper.get('[aria-label="共享目录"]').text()).toBe("尚未选择文件夹");
    expect(exportCredentials).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("discards a delayed migration-key delivery after the backend context changes", async () => {
    const service = credentials();
    let current: CredentialManagementStatus = {
      ...status,
      role: "source",
      instanceId: "host-1",
      contextId: "private-1",
      selectedBackend: "private",
      activeBackend: "private",
      vaultDirectory: "C:/old-vault",
    };
    service.getStatus = async () => ({ ok: true, value: { ...current } });
    let changed = (): void => {};
    service.subscribe = (listener) => {
      changed = () =>
        listener({
          schemaVersion: 1,
          instanceId: current.instanceId!,
          revision: 1,
          occurredAt: "now",
          reasons: ["credentials"],
        });
      return () => {};
    };
    let deliver!: (result: ServiceResult<CredentialExportDelivery>) => void;
    vi.spyOn(service, "exportCredentials").mockImplementation(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    const wrapper = mount(CredentialsPage, {
      global: { provide: { [credentialServiceKey as symbol]: service } },
    });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "准备导出")!
      .trigger("click");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "确认导出")!
      .trigger("click");
    current = { ...current, contextId: "private-2", vaultDirectory: "C:/new-vault" };
    changed();
    await flushPromises();
    deliver({ ok: true, value: { migrationKey: "acm1_FICTIONAL-RETIRED", storageVersion: "1" } });
    await flushPromises();
    expect(wrapper.find("textarea").exists()).toBe(false);
    expect(wrapper.html()).not.toContain("acm1_FICTIONAL-RETIRED");
    expect(wrapper.text()).not.toContain("导出成功。请保存迁移密钥");
    expect(wrapper.get('[aria-label="共享目录"]').text()).toBe("C:/new-vault");
    wrapper.unmount();
  });
});
