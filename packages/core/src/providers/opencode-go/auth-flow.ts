import { AppError } from "../../errors.js";
import type { AuthMethod } from "../../models.js";
import type { AuthFlowStart, AuthStartOptions, ProviderAuthFlow } from "../../auth/types.js";
import type { OpencodeGoAccountProvisioner, OpencodeGoAdapter } from "./adapter.js";

interface OpencodeGoAuthFlowDeps {
  adapter: Pick<OpencodeGoAdapter, "createProvisioning">;
  provisioner: Pick<OpencodeGoAccountProvisioner, "save">;
}

const SUPPORTED_METHODS: readonly AuthMethod[] = ["api-key"];

export function createOpencodeGoAuthFlow(deps: OpencodeGoAuthFlowDeps): ProviderAuthFlow {
  return {
    provider: "opencode-go",
    supportedMethods: SUPPORTED_METHODS,
    async start(method: AuthMethod, options: AuthStartOptions): Promise<AuthFlowStart> {
      if (method !== "api-key") {
        throw new AppError("validation", "OpenCode Go 仅支持 API Key 接入");
      }
      const provisioning = await deps.adapter.createProvisioning(options.apiKey ?? "");
      return { status: "completed", account: await deps.provisioner.save(provisioning) };
    },
  };
}
