import { AppError } from "../../errors.js";
import type { Account, AuthMethod } from "../../models.js";
import type { AuthFlowStart, AuthStartOptions, ProviderAuthFlow } from "../../auth/types.js";
import type { GlmAccountProvisioner, GlmAdapter } from "./adapter.js";
import { readZCodeCodingPlanApiKey } from "./zcode-credentials.js";

interface GlmAuthFlowDeps {
  adapter: Pick<GlmAdapter, "createProvisioning">;
  provisioner: Pick<GlmAccountProvisioner, "save">;
  readZCodeCredentials?: (offeringId: string) => Promise<string>;
}

const SUPPORTED_METHODS: readonly AuthMethod[] = ["cli-import", "api-key"];

export function createGlmAuthFlow(deps: GlmAuthFlowDeps): ProviderAuthFlow {
  return {
    provider: "glm",
    supportedMethods: SUPPORTED_METHODS,
    async start(
      offeringId: string,
      method: AuthMethod,
      options: AuthStartOptions,
    ): Promise<AuthFlowStart> {
      if (method !== "api-key" && method !== "cli-import") {
        throw new AppError("validation", "GLM Coding Plan 仅支持 ZCode 导入或 API Key 接入");
      }
      if (offeringId !== "bigmodel-coding-plan" && offeringId !== "zai-coding-plan") {
        throw new AppError("validation", `GLM 不提供接入点：${offeringId}`);
      }
      const apiKey =
        method === "cli-import"
          ? await (deps.readZCodeCredentials ?? readZCodeCodingPlanApiKey)(offeringId)
          : (options.apiKey ?? "");
      const provisioning = await deps.adapter.createProvisioning(apiKey, offeringId, method);
      return { status: "completed", account: await deps.provisioner.save(provisioning) };
    },
  };
}
