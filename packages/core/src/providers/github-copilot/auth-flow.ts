import { AppError } from "../../errors.js";
import type { Account, AuthMethod } from "../../models.js";
import type { AuthFlowStart, AuthStartOptions, ProviderAuthFlow } from "../../auth/types.js";
import type {
  CopilotAccountProvisioner,
  CopilotAdapter,
  CopilotDeviceAuthorization,
} from "./adapter.js";

interface CopilotAuthFlowDeps {
  adapter: Pick<CopilotAdapter, "requestDeviceAuthorization" | "finishDeviceAuthorization">;
  provisioner: Pick<CopilotAccountProvisioner, "save">;
}

const SUPPORTED_METHODS: readonly AuthMethod[] = ["device-code"];

export function createCopilotAuthFlow(deps: CopilotAuthFlowDeps): ProviderAuthFlow {
  async function startDeviceLogin(): Promise<AuthFlowStart> {
    const controller = new AbortController();
    const authorization: CopilotDeviceAuthorization =
      await deps.adapter.requestDeviceAuthorization();
    return {
      status: "pending",
      interaction: "device-code",
      expiresAt: new Date(authorization.expiresAtMs).toISOString(),
      userCode: authorization.userCode,
      verificationUri: authorization.verificationUriComplete,
      finish: () =>
        deps.adapter
          .finishDeviceAuthorization(authorization, controller.signal)
          .then((provisioning) => {
            controller.signal.throwIfAborted();
            return deps.provisioner.save(provisioning);
          }),
      cancel: () => controller.abort(),
    };
  }

  return {
    provider: "github-copilot",
    supportedMethods: SUPPORTED_METHODS,
    async start(
      offeringId: string,
      method: AuthMethod,
      _options: AuthStartOptions,
    ): Promise<AuthFlowStart> {
      if (offeringId !== "github-copilot") {
        throw new AppError("validation", `GitHub Copilot 不提供接入点：${offeringId}`);
      }
      if (method !== "device-code") {
        throw new AppError("validation", `GitHub Copilot 不支持接入方式：${method}`);
      }
      return startDeviceLogin();
    },
  };
}
