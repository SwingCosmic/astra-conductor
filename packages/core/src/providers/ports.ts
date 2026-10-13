import type { ClockPort, HttpPort, StoragePort } from "../ports.js";
import type { StartOAuthCallbackServer } from "../auth/types.js";
import type { CredentialVault } from "../credential-vault.js";

/**
 * 宿主端口的统一形状：供应商组合需要的全部能力经参数注入，core 不提供
 * 默认实现，实现不得导入 Electron 或直接读取产品数据库。
 */
export interface ProviderPorts {
  http: HttpPort;
  browser: { openExternal(url: string): Promise<void> };
  callbackServer: { start: StartOAuthCallbackServer };
  storage: StoragePort;
  vault: CredentialVault;
  clock?: ClockPort;
}
