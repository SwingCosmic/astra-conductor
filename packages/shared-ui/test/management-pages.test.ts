import { mount, flushPromises } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type {
  CredentialManagementStatus,
  ICredentialManagementService,
  IProviderService,
  OfferingRouteConfig,
  ProviderManagementSnapshot,
  PublicConnection,
  ServiceResult,
} from "@astra-conductor/contract/common";
import {
  AppShell,
  AuthDialog,
  ConnectionDialog,
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
    getConnection: unavailable,
    createConnection: unavailable,
    editConnection: unavailable,
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
    adoptVault: unavailable,
    checkRelease: unavailable,
    installRelease: unavailable,
    install: unavailable,
    uninstall: unavailable,
    exportCredentials: unavailable,
    resumeExport: unavailable,
    clearExportTarget: unavailable,
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
  it.each([
    { confirm: false, busy: false, calls: ["export", "confirm"] },
    { confirm: true, busy: true, calls: ["export", "confirm", "clear"] },
    { confirm: true, busy: false, calls: ["export", "confirm", "clear", "export"] },
  ])("separates confirmation, clearing and one retry ($confirm, $busy)", async (scenario) => {
    const service = credentials();
    const calls: string[] = [];
    const target = "C:/chosen";
    const operation = {
      id: "export-op",
      kind: "export",
      vaultDirectory: target,
      failedVaultId: "old-vault",
    };
    service.getStatus = async () => ({ ok: true, value: { ...status, operation } });
    service.exportCredentials = async () => {
      calls.push("export");
      return {
        ok: false,
        error: { code: "export-target-conflict", message: "不可导出", retryable: false },
      };
    };
    service.clearExportTarget = async (op, id) => {
      calls.push("clear");
      expect([op, id]).toEqual([operation.id, operation.failedVaultId]);
      return scenario.busy
        ? { ok: false, error: { code: "vault-in-use", message: "共享库正在使用", retryable: true } }
        : { ok: true, value: undefined };
    };
    const confirm = vi.spyOn(window, "confirm").mockImplementation((prompt) => {
      expect(prompt).toContain(target);
      calls.push("confirm");
      return scenario.confirm;
    });
    const wrapper = page(service);
    try {
      await flushPromises();
      await wrapper.get("form").trigger("submit");
      await flushPromises();
      expect(calls).toEqual(scenario.calls);
    } finally {
      wrapper.unmount();
      confirm.mockRestore();
    }
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

  it("lets a web receiver pick and adopt a directory, and keeps that form off the desktop page", async () => {
    const service = credentials();
    let current: CredentialManagementStatus = {
      ...status,
      migrationState: null,
      role: "receiver",
      privateAvailable: false,
      selectedBackend: "shared",
      activeBackend: "unavailable",
      vaultDirectory: null,
      directorySelectionAvailable: true,
      capabilities: { adoptVault: { state: "enabled" } },
    };
    service.getStatus = async () => ({ ok: true, value: current });
    service.selectDirectory = async () => ({
      ok: false,
      error: {
        code: "desktop-unavailable",
        message: "当前宿主不能打开目录选择器",
        retryable: false,
      },
    });
    const adopt = vi.spyOn(service, "adoptVault").mockImplementation(async () => {
      current = { ...current, vaultDirectory: "D:/shared/acme-vault" };
      return { ok: true, value: undefined };
    });
    const wrapper = page(service);
    const button = (label: string) =>
      wrapper.findAll("button").find((item) => item.text() === label)!;
    await flushPromises();
    expect(wrapper.text()).toContain("选择已授权的共享目录，或填写绝对路径。");
    expect(button("接入此共享库")).toBeDefined();
    expect(button("导出凭据")).toBeUndefined();
    expect(button("导入凭据")).toBeUndefined();
    await button("选择目录").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("当前宿主不能打开目录选择器");
    service.selectDirectory = async () => ({ ok: true, value: "D:/shared/acme-vault" });
    await button("选择目录").trigger("click");
    await flushPromises();
    const directory = wrapper.get('[aria-label="共享目录"]').element as HTMLInputElement;
    expect(directory.value).toBe("D:/shared/acme-vault");
    await wrapper.get('[aria-label="客户端身份"]').setValue("   ");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(adopt).toHaveBeenLastCalledWith("D:/shared/acme-vault", undefined);
    await wrapper.get('[aria-label="客户端身份"]').setValue("  graph-agent-demo  ");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(adopt).toHaveBeenLastCalledWith("D:/shared/acme-vault", "graph-agent-demo");
    expect((wrapper.get('[aria-label="客户端身份"]').element as HTMLInputElement).value).toBe("");
    expect(button("更换共享目录")).toBeTruthy();
    wrapper.unmount();

    const desktop = credentials();
    const desktopPage = page(desktop);
    await flushPromises();
    const desktopButton = (label: string) =>
      desktopPage.findAll("button").find((item) => item.text() === label);
    expect(desktopButton("导出凭据")).toBeDefined();
    expect(desktopButton("导入凭据")).toBeDefined();
    expect(desktopPage.text()).not.toContain("接入共享目录");
    expect(desktopButton("接入此共享库")).toBeUndefined();
    desktopPage.unmount();
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

  const connectionResult = (overrides: Partial<PublicConnection> = {}): PublicConnection => ({
    instanceId: "inst-1",
    contextId: "ctx-1",
    accountId: "acc-1",
    providerId: "vendor-fixed",
    offeringId: "vendor-fixed-api-key",
    displayName: "Main Key",
    recordRevision: "rev-1",
    routes: [],
    ...overrides,
  });

  it("renders fixed-route offerings from routeConfig without route inputs and submits empty routes", async () => {
    const service = providers();
    const createConnection = vi.spyOn(service, "createConnection").mockResolvedValue({
      ok: true,
      value: connectionResult(),
    });
    const routeConfig: OfferingRouteConfig = {
      mode: "fixed",
      allowedProtocols: ["openai-chat", "openai-responses"],
      defaults: [
        { protocol: "openai-chat", baseUrl: "https://api.vendor.example/v1" },
        { protocol: "openai-responses", baseUrl: "https://api.vendor.example/v1" },
      ],
    };
    const wrapper = mount(ConnectionDialog, {
      props: {
        context: { instanceId: "inst-1", contextId: "ctx-1" },
        providerId: "vendor-fixed",
        offeringId: "vendor-fixed-api-key",
        offeringLabel: "Vendor Fixed",
        routeConfig,
      },
      global: { provide: { [providerServiceKey as symbol]: service } },
    });
    expect(wrapper.findAll('input[type="url"]')).toHaveLength(0);
    await wrapper.get("#connection-name").setValue("Main Key");
    await wrapper.get("#connection-key").setValue("fictional-key");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(createConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "vendor-fixed",
        offeringId: "vendor-fixed-api-key",
        displayName: "Main Key",
        apiKey: "fictional-key",
        routes: [],
      }),
      { instanceId: "inst-1", contextId: "ctx-1" },
    );
    wrapper.unmount();
  });

  it("renders groupByFamily editable routeConfig and preserves requestRule and chatOutputLimitField on edit", async () => {
    const service = providers();
    const createConnection = vi.spyOn(service, "createConnection").mockResolvedValue({
      ok: true,
      value: connectionResult({
        accountId: "acc-2",
        providerId: "vendor-grouped",
        offeringId: "vendor-grouped-api-key",
        displayName: "Grouped Key",
      }),
    });
    const routeConfig: OfferingRouteConfig = {
      mode: "editable",
      groupByFamily: true,
      allowedProtocols: ["openai-chat", "openai-responses", "anthropic-messages"],
      defaults: [
        { protocol: "openai-chat", baseUrl: "https://api.vendor.example" },
        { protocol: "openai-responses", baseUrl: "https://api.vendor.example" },
        {
          protocol: "anthropic-messages",
          baseUrl: "https://api.vendor.example/anthropic/v1",
          protocolVersion: "2023-06-01",
        },
      ],
    };
    const wrapper = mount(ConnectionDialog, {
      props: {
        context: { instanceId: "inst-1", contextId: "ctx-1" },
        providerId: "vendor-grouped",
        offeringId: "vendor-grouped-api-key",
        routeConfig,
      },
      global: { provide: { [providerServiceKey as symbol]: service } },
    });
    expect((wrapper.get("#route-family-openai").element as HTMLInputElement).value).toBe(
      "https://api.vendor.example",
    );
    expect((wrapper.get("#route-family-anthropic").element as HTMLInputElement).value).toBe(
      "https://api.vendor.example/anthropic/v1",
    );
    expect((wrapper.get("#anthropic-version").element as HTMLInputElement).value).toBe(
      "2023-06-01",
    );
    const checkboxes = wrapper.findAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    await checkboxes[1]!.setValue(false);
    await wrapper.get("#connection-name").setValue("Grouped Key");
    await wrapper.get("#connection-key").setValue("fictional-grouped-key");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(createConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        routes: [
          {
            protocol: "openai-chat",
            baseUrl: "https://api.vendor.example",
            protocolVersion: null,
          },
          {
            protocol: "anthropic-messages",
            baseUrl: "https://api.vendor.example/anthropic/v1",
            protocolVersion: "2023-06-01",
          },
        ],
      }),
      { instanceId: "inst-1", contextId: "ctx-1" },
    );
    wrapper.unmount();

    const requestRule = { operation: "chat" as const, body: { custom_flag: true } };
    vi.spyOn(service, "getConnection").mockResolvedValue({
      ok: true,
      value: connectionResult({
        accountId: "acc-2",
        providerId: "vendor-grouped",
        offeringId: "vendor-grouped-api-key",
        displayName: "Grouped Key",
        routes: [
          {
            protocol: "openai-chat",
            baseUrl: "https://gateway.example",
            protocolVersion: null,
            bindingRevision: "bind-1",
            chatOutputLimitField: "max_tokens",
            requestRule,
          },
        ],
      }),
    });
    const editConnection = vi.spyOn(service, "editConnection").mockResolvedValue({
      ok: true,
      value: connectionResult({
        accountId: "acc-2",
        providerId: "vendor-grouped",
        offeringId: "vendor-grouped-api-key",
        displayName: "Grouped Key Renamed",
        recordRevision: "rev-2",
      }),
    });
    const editWrapper = mount(ConnectionDialog, {
      props: {
        context: { instanceId: "inst-1", contextId: "ctx-1" },
        accountId: "acc-2",
        providerId: "vendor-grouped",
        offeringId: "vendor-grouped-api-key",
        routeConfig,
      },
      global: { provide: { [providerServiceKey as symbol]: service } },
    });
    await flushPromises();
    await editWrapper.get("#connection-name").setValue("Grouped Key Renamed");
    await editWrapper.get("form").trigger("submit");
    await flushPromises();
    expect(editConnection).toHaveBeenCalledWith(
      "acc-2",
      expect.objectContaining({
        displayName: "Grouped Key Renamed",
        expectedRecordRevision: "rev-1",
        routes: [
          {
            protocol: "openai-chat",
            baseUrl: "https://gateway.example",
            protocolVersion: null,
            chatOutputLimitField: "max_tokens",
            requestRule,
          },
        ],
      }),
      { instanceId: "inst-1", contextId: "ctx-1" },
    );
    editWrapper.unmount();
  });

  it("renders per-protocol URL inputs for legacy compatible-api-key without routeConfig", async () => {
    const service = providers();
    const createConnection = vi.spyOn(service, "createConnection").mockResolvedValue({
      ok: true,
      value: connectionResult({
        accountId: "acc-3",
        providerId: "compatible-api-key",
        offeringId: "compatible-api-key",
        displayName: "Legacy Relay",
      }),
    });
    const wrapper = mount(ConnectionDialog, {
      props: {
        context: { instanceId: "inst-1", contextId: "ctx-1" },
        providerId: "compatible-api-key",
        offeringId: "compatible-api-key",
      },
      global: { provide: { [providerServiceKey as symbol]: service } },
    });
    expect(wrapper.findAll('input[type="url"]')).toHaveLength(3);
    await wrapper.get("#connection-name").setValue("Legacy Relay");
    await wrapper.get("#connection-key").setValue("fictional-legacy-key");
    await wrapper.get("#route-openai-chat").setValue("https://relay.example/v1");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(createConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Legacy Relay",
        routes: [
          {
            protocol: "openai-chat",
            baseUrl: "https://relay.example/v1",
            protocolVersion: null,
          },
        ],
      }),
      { instanceId: "inst-1", contextId: "ctx-1" },
    );
    wrapper.unmount();
  });
});
