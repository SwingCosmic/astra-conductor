import type { ProviderContribution } from "./registry.js";
import type { ProviderPorts } from "./ports.js";
import { createCodexProvider } from "./codex/bundle.js";
import { createGlmProvider } from "./glm/bundle.js";
import { createGrokBuildProvider } from "./grok-build/bundle.js";
import { createAntigravityProvider } from "./antigravity/bundle.js";
import { createClaudeProvider } from "./claude/bundle.js";
import { createOpencodeGoProvider } from "./opencode-go/bundle.js";

/**
 * 与 providerCatalog 同一收集点的聚合：新增供应商时在 `providers/<id>/`
 * 建立声明与组合工厂并在此登记，桌面组合根一行取得全部 contribution，
 * 不出现按供应商命名的构造与映射。
 */
export function createProviderContributions(ports: ProviderPorts): ProviderContribution[] {
  return [
    createCodexProvider(ports),
    createGlmProvider(ports),
    createGrokBuildProvider(ports),
    createAntigravityProvider(ports),
    createClaudeProvider(ports),
    createOpencodeGoProvider(ports),
  ];
}
