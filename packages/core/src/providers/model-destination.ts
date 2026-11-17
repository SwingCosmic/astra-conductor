import type { ModelRoute } from "@astra-conductor/contract/common";
import type { Account } from "../models.js";

// Registered coding-plan offerings document the original Chat Completions output-limit
// field. DeepSeek's official endpoint implements it too, and compatible or custom
// accounts can point straight at that host, so the destination decides as well.
const legacyOutputLimitProviders = new Set(["glm", "opencode-go"]);
const legacyOutputLimitHosts = new Set(["api.deepseek.com"]);

/** Which request field carries the maximum output tokens for this destination. */
export function usesLegacyOutputLimitField(account: Account, route: ModelRoute): boolean {
  if (legacyOutputLimitProviders.has(account.provider)) return true;
  try {
    return legacyOutputLimitHosts.has(new URL(route.baseUrl).hostname);
  } catch {
    return false;
  }
}
