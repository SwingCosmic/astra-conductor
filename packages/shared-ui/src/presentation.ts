import antigravityIcon from "./assets/icon/antigravity.png";
import bigmodelIcon from "./assets/icon/bigmodel.svg";
import claudeIcon from "./assets/icon/claude.svg";
import copilotIcon from "./assets/icon/copilot.svg";
import gptIcon from "./assets/icon/gpt.png";
import grokIcon from "./assets/icon/grok.svg";
import opencodeIcon from "./assets/icon/opencode.png";
import zaiIcon from "./assets/icon/zai.svg";
import type {
  PublicAccount,
  PublicAuthInteraction,
  PublicOfferingDescriptor,
  PublicProviderDescriptor,
} from "@astra-conductor/contract/common";

/**
 * 本地视觉与枚举文案层。目录、标准名称、CLI 导入路径提示全部来自主进程
 * 快照中的 provider 目录（core 单一来源）；这里只保留图标资产、图标缺失时
 * 的首字符占位、封闭枚举的文本映射和窗口时长等纯展示计算。套餐档位的
 * 匹配发生在主进程（解析结果随快照下发），前端不做任何匹配。
 */

/** 图标资产映射：core 声明 iconKey，UI 持有资产；缺失映射时用首字符占位。 */
const iconAssets: Record<string, string> = {
  codex: gptIcon,
  bigmodel: bigmodelIcon,
  zai: zaiIcon,
  grok: grokIcon,
  antigravity: antigravityIcon,
  claude: claudeIcon,
  opencode: opencodeIcon,
  copilot: copilotIcon,
};

/** 无图标时的占位字符：取展示名的第一个字符大写，不维护逐供应商清单。 */
function fallbackMark(name: string): string {
  return name.charAt(0).toUpperCase() || "?";
}

/**
 * 常见认证方式的固定文本映射，不是供应商事实。认证方式是随目录扩张的
 * 动态集合（无封闭词表）：目录 `sourceLabel` 优先，未知 id 回退为连字符
 * 转空格的原文。
 */
const authMethodTexts: Record<string, string> = {
  "browser-oauth": "浏览器 OAuth",
  "device-code": "设备码",
  "cli-import": "CLI 导入",
  "api-key": "API Key",
};

export function authMethodLabel(method: string): string {
  return authMethodTexts[method] ?? method.replaceAll("-", " ");
}

export interface AuthMethodPresentation {
  id: string;
  label: string;
  interaction: PublicAuthInteraction;
}

export interface ProviderPresentation {
  /** offering id：展示行与账号分组的稳定键。 */
  id: string;
  provider: string;
  name: string;
  description: string;
  mark: string;
  icon?: string;
  websiteUrl?: string;
  authMethods: AuthMethodPresentation[];
  cliImportPath?: string;
}

function toPresentation(
  offering: PublicOfferingDescriptor,
  providerName: string,
): ProviderPresentation {
  const icon = offering.iconKey ? iconAssets[offering.iconKey] : undefined;
  const name = offering.displayName || providerName;
  return {
    id: offering.id,
    provider: offering.provider,
    name,
    description: offering.description ?? "",
    mark: fallbackMark(name),
    icon,
    websiteUrl: offering.websiteUrl,
    authMethods: offering.authMethods.map((method) => ({
      id: method.method,
      label: method.sourceLabel ?? authMethodLabel(method.method),
      interaction: method.interaction,
    })),
    cliImportPath: offering.authMethods.find((method) => method.method === "cli-import")
      ?.sourcePathHint,
  };
}

/**
 * 把主进程提供的 provider 目录投影为接入页的展示行。目录决定结构与全部
 * 供应商事实；目录为空（例如浏览器预览）时不虚构任何服务商。
 */
export function catalogPresentations(
  catalog: readonly PublicProviderDescriptor[] | null | undefined,
): ProviderPresentation[] {
  if (!catalog?.length) return [];
  const rows: ProviderPresentation[] = [];
  for (const descriptor of catalog) {
    for (const offering of descriptor.offerings) {
      rows.push(toPresentation(offering, descriptor.displayName));
    }
  }
  return rows;
}

/** 未知 offering 在展示层显式显示占位，不回退到第一个展示条目（§12.3）。 */
const unknownPresentation = (offeringId: string, provider: string): ProviderPresentation => ({
  id: offeringId,
  provider,
  name: offeringId,
  description: "",
  mark: fallbackMark(offeringId),
  authMethods: [],
});

export function accountPresentation(
  account: PublicAccount,
  catalog: readonly PublicProviderDescriptor[] | null | undefined,
): ProviderPresentation {
  for (const descriptor of catalog ?? []) {
    const offering = descriptor.offerings.find((item) => item.id === account.offeringId);
    if (offering) return toPresentation(offering, descriptor.displayName);
  }
  return unknownPresentation(account.offeringId, account.provider);
}
