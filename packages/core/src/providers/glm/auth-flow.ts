import { AppError } from "../../errors.js";
import type { Account, AuthMethod, GlmRegion } from "../../models.js";
import type { AuthFlowStart, AuthStartOptions, ProviderAuthFlow } from "../../auth/types.js";
import type { GlmAccountProvisioner, GlmAdapter } from "./adapter.js";
import { readZCodeCodingPlanApiKey } from "./zcode-credentials.js";

interface GlmAuthFlowDeps {
  adapter: Pick<GlmAdapter, "createProvisioning">;
  provisioner: Pick<GlmAccountProvisioner, "save">;
  readZCodeCredentials?: (region: GlmRegion) => Promise<string>;
}

const SUPPORTED_METHODS: readonly AuthMethod[] = ["cli-import", "api-key"];

export function createGlmAuthFlow(deps: GlmAuthFlowDeps): ProviderAuthFlow {
  return {
    provider: "glm",
    supportedMethods: SUPPORTED_METHODS,
    async start(method: AuthMethod, options: AuthStartOptions): Promise<AuthFlowStart> {
      if (method !== "api-key" && method !== "cli-import") {
        throw new AppError("validation", "GLM Coding Plan 仅支持 ZCode 导入或 API Key 接入");
      }
      if (options.region !== "china" && options.region !== "international") {
        throw new AppError("validation", "请选择有效的 GLM 服务区域");
      }
      const apiKey =
        method === "cli-import"
          ? await (deps.readZCodeCredentials ?? readZCodeCodingPlanApiKey)(options.region)
          : (options.apiKey ?? "");
      const provisioning = await deps.adapter.createProvisioning(apiKey, options.region, method);
      return { status: "completed", account: await deps.provisioner.save(provisioning) };
    },
  };
}
