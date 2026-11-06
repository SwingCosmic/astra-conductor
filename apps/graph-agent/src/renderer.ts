import type { AccountPreview, GraphApi, GraphStatus, ImportPreview } from "./contract.js";
declare global {
  interface Window {
    graphAgent: GraphApi;
  }
}
const api = window.graphAgent;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let busy = false;
let preview: ImportPreview | undefined;
let status: GraphStatus | undefined;
let revalidating = false;
const message = (value: string, error = false) => {
  const notice = element("notice");
  notice.hidden = !value;
  notice.textContent = value;
  notice.className = error ? "error" : "";
};
const errorMessages: Record<string, string> = {
  "protocol-incompatible": "凭据共享服务的通信协议不兼容，请先安装协议兼容的组件。",
  "invalid-component-version": "组件版本信息不是有效的 SemVer，请检查组件包元数据。",
  "invalid-migration-key": "迁移密钥格式不正确。",
  "sharing-operation-failed": "验证或连接未完成，请检查迁移密钥与共享目录后重试。",
  "component-not-installed": "请先安装本地凭据共享组件。",
  "import-preview-expired": "预览已过期，请重新验证迁移密钥。",
  "sharing-not-active": "共享尚未启用，请等待 PolyQuota 完成交接。",
  "secure-storage-unavailable": "本机安全存储暂不可用。",
};
function errorMessage(code: string): string | undefined {
  if (
    code === "component-incompatible" ||
    code === "api-incompatible" ||
    code === "method-not-found"
  ) {
    const requirement = status ? `API ${status.requiredApiLevel} 及以上` : "当前应用所需的 API";
    return `凭据共享服务不满足当前应用的接口要求，请安装支持${requirement}的兼容组件。`;
  }
  return errorMessages[code];
}
async function run(operation: () => Promise<void>, success = ""): Promise<void> {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
  });
  message("正在处理…");
  try {
    await operation();
    message(success);
  } catch (error) {
    const code = error instanceof Error ? error.message : "operation-failed";
    message(errorMessage(code) ?? `操作未完成，请重试（${code}）`, true);
  } finally {
    busy = false;
    document.querySelectorAll("button").forEach((button) => {
      button.disabled = false;
    });
    await check().catch(() => undefined);
  }
}
function details(target: string, entries: [string, string | null][]): void {
  element(target).replaceChildren(
    ...entries.flatMap(([name, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = name;
      const dd = document.createElement("dd");
      dd.textContent = value ?? "—";
      return [dt, dd];
    }),
  );
}
function accounts(target: string, values: AccountPreview[], active: boolean): void {
  element(target).replaceChildren(
    ...values.map((account) => {
      const row = document.createElement("div");
      row.className = "account";
      const label = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = account.maskedIdentifier;
      const detail = document.createElement("small");
      detail.textContent = `${account.provider} · 修订 ${account.revision}${account.canRefresh ? "" : " · 无可用刷新协议"}`;
      label.append(name, detail);
      row.append(label);
      if (active && account.canRefresh) {
        const refresh = document.createElement("button");
        refresh.textContent = "刷新凭据";
        refresh.disabled = busy;
        refresh.onclick = () => void run(() => api.refresh(account.id), "凭据已更新。");
        row.append(refresh);
      }
      return row;
    }),
  );
}
async function check(): Promise<void> {
  status = await api.status();
  const componentCompatible = status.installState === "installed";
  const installNames: Record<string, string> = {
    installed: "已安装",
    "not-installed": "未安装",
    damaged: "安装损坏",
    incompatible: "不兼容",
    unknown: "无法确认",
  };
  const packageNames: Record<string, string> = {
    ready: "完整可用",
    missing: "尚未放置",
    invalid: "校验失败",
    unknown: "未检查",
  };
  const serviceNames: Record<string, string> = {
    NOT_CHECKED: "尚未连接",
    NOT_REGISTERED: "尚未登记",
    STOPPED: "已停止",
    STARTING: "正在启动",
    READY: "可用",
    IDLE: "空闲",
    LOCKED: "需要解锁",
    DRAINING: "正在停止",
    FAILED: "启动失败",
    UNAVAILABLE: "暂不可达",
  };
  element("install-badge").textContent = installNames[status.installState] ?? status.installState;
  element("compatibility-hint").hidden = status.installState !== "incompatible";
  element("compatibility-hint").textContent =
    `当前凭据共享服务不满足应用的通信或接口要求。请先安装支持 API ${status.requiredApiLevel} 及以上的兼容组件，再验证或连接共享凭据。`;
  details("component-info", [
    ["组件版本", status.installedVersion],
    ["组件 API", status.installedApiLevel ?? "未声明"],
    ["所需 API", status.requiredApiLevel],
    ["安装位置", status.installationDirectory],
    ["本地包状态", packageNames[status.localPackageState]],
    ["服务状态", serviceNames[status.serviceState] ?? status.serviceState],
  ]);
  element("package-directory").textContent = status.localPackageDirectory;
  element<HTMLButtonElement>("install").textContent =
    status.installState === "installed"
      ? "重新安装本地组件"
      : status.installState === "incompatible"
        ? "安装兼容本地组件"
        : "安装本地组件";
  element<HTMLButtonElement>("install").disabled = busy || status.localPackageState !== "ready";
  element<HTMLButtonElement>("uninstall").disabled =
    busy || status.installState === "not-installed";
  for (const id of ["verify", "confirm", "retry"])
    element<HTMLButtonElement>(id).disabled = busy || !componentCompatible;
  element<HTMLInputElement>("migration-key").disabled = busy || !componentCompatible;
  const stateNames = {
    none: "尚未导入",
    preparing: "等待重试",
    "import-ready": "导入就绪",
    shared: "共享已启用",
  };
  element("sharing-badge").textContent =
    status.state === "shared" && !status.connected ? "等待连接" : stateNames[status.state];
  element("sharing-hint").textContent =
    status.state === "shared"
      ? status.connected
        ? "当前凭据由共享服务管理。可手动刷新支持的账号。"
        : "共享已经建立，当前连接尚未恢复。请检查服务状态并重试。"
      : status.state === "import-ready"
        ? "导入已就绪。请在 PolyQuota 中启用共享，完成后此处会自动连接。"
        : status.state === "preparing"
          ? "本机密钥已保存，请重新连接以完成导入准备。"
          : "从 PolyQuota 导出的目录导入凭据。密钥仅用于本次验证。";
  details(
    "sharing-info",
    status.vaultDirectory
      ? [
          ["共享目录", status.vaultDirectory],
          ["存储版本", status.storageVersion],
          ["主密钥", status.rememberedKey ? "已安全记住" : "需要重新验证"],
        ]
      : [],
  );
  element("import-form").hidden = !!preview || (status.state !== "none" && !revalidating);
  element("preview").hidden = !preview;
  element("connected").hidden = status.state === "none" || !!preview;
  accounts(
    "accounts",
    status.accounts,
    componentCompatible && status.state === "shared" && status.connected,
  );
  if (status.lastError && !busy)
    message(errorMessage(status.lastError) ?? `共享连接需要重试（${status.lastError}）`, true);
}
for (const page of ["home", "settings"])
  element(`${page}-tab`).onclick = () => {
    element("home").hidden = page !== "home";
    element("settings").hidden = page !== "settings";
    element("home-tab").className = page === "home" ? "selected" : "";
    element("settings-tab").className = page === "settings" ? "selected" : "";
    if (page === "settings") void check();
  };
element("check").onclick = () => void run(check);
element("install").onclick = () =>
  void run(async () => {
    await api.install();
  }, "本地组件安装完成。");
element("uninstall").onclick = () => {
  if (confirm("卸载会暂停当前用户的全部共享客户端。共享数据、主密钥和绑定会保留，是否继续？"))
    void run(() => api.uninstall(), "组件已卸载，共享数据已保留。");
};
element("choose").onclick = () =>
  void run(async () => {
    const directory = await api.selectDirectory();
    if (directory) element<HTMLInputElement>("directory").value = directory;
  });
element("verify").onclick = () =>
  void run(async () => {
    const key = element<HTMLInputElement>("migration-key");
    try {
      preview = await api.verifyImport({
        vaultDirectory: element<HTMLInputElement>("directory").value,
        migrationKey: key.value,
      });
      accounts("preview-accounts", preview.accounts, false);
    } finally {
      key.value = "";
    }
  });
element("confirm").onclick = () =>
  void run(async () => {
    if (!preview) return;
    const id = preview.previewId;
    preview = undefined;
    revalidating = false;
    await api.confirmImport(id);
  }, "导入准备已完成。");
element("cancel").onclick = () =>
  void run(async () => {
    await api.cancelPreview();
    preview = undefined;
  });
element("retry").onclick = () => void run(() => api.retry(), "连接状态已更新。");
element("revalidate").onclick = () => {
  revalidating = true;
  element<HTMLInputElement>("directory").value = status?.vaultDirectory ?? "";
  void check();
};
void check().catch(() => message("暂时无法读取状态，请重新检查。", true));
setInterval(() => {
  if (!busy && !element("settings").hidden) void check().catch(() => undefined);
}, 3000);
