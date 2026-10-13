import { AppError } from "../../errors.js";
import type { AuthMethod } from "../../models.js";
import { createOAuthCallbackHandler } from "../../auth/callback-handler.js";
import type {
  AuthFlowStart,
  AuthStartOptions,
  ProviderAuthFlow,
  StartOAuthCallbackServer,
} from "../../auth/types.js";
import type {
  AntigravityBrowserAuthorization,
  AntigravityAccountProvisioner,
  AntigravityAdapter,
} from "./adapter.js";

interface AntigravityAuthFlowDeps {
  adapter: Pick<AntigravityAdapter, "createBrowserAuthorization" | "finishBrowserAuthorization">;
  provisioner: Pick<AntigravityAccountProvisioner, "save">;
  openExternal: (url: string) => Promise<void>;
  startCallbackServer: StartOAuthCallbackServer;
}

const CALLBACK = {
  host: "127.0.0.1",
  redirectHost: "localhost",
  port: 0,
  path: "/callback",
} as const;

const SUPPORTED_METHODS: readonly AuthMethod[] = ["browser-oauth"];

export function createAntigravityAuthFlow(deps: AntigravityAuthFlowDeps): ProviderAuthFlow {
  async function startBrowserLogin(): Promise<AuthFlowStart> {
    const controller = new AbortController();
    let expectedState = "";
    const handler = createOAuthCallbackHandler({
      label: "antigravity",
      callbackPath: CALLBACK.path,
      expectedState: () => expectedState,
      signal: controller.signal,
    });
    let port: number;
    try {
      ({ port } = await deps.startCallbackServer({
        label: "antigravity",
        host: CALLBACK.host,
        port: CALLBACK.port,
        handler,
      }));
    } catch (error) {
      controller.abort();
      if (error instanceof AppError) throw error;
      throw new AppError("network", "无法监听 antigravity 授权回调端口", false, { cause: error });
    }
    const redirectUri = `http://${CALLBACK.redirectHost}:${port}${CALLBACK.path}`;
    const authorization: AntigravityBrowserAuthorization =
      deps.adapter.createBrowserAuthorization(redirectUri);
    expectedState = authorization.state;
    const account = handler.completion
      .then((code) => deps.adapter.finishBrowserAuthorization(authorization, code))
      .then((provisioning) => deps.provisioner.save(provisioning));
    void account.catch(() => undefined);
    try {
      await deps.openExternal(authorization.url);
    } catch (error) {
      controller.abort();
      throw error;
    }
    return {
      status: "pending",
      interaction: "browser-callback",
      finish: () => account,
      cancel: () => controller.abort(),
    };
  }

  return {
    provider: "antigravity",
    supportedMethods: SUPPORTED_METHODS,
    async start(
      offeringId: string,
      method: AuthMethod,
      _options: AuthStartOptions,
    ): Promise<AuthFlowStart> {
      if (offeringId !== "antigravity") {
        throw new AppError("validation", `Antigravity 不提供接入点：${offeringId}`);
      }
      if (method === "browser-oauth") return startBrowserLogin();
      throw new AppError("validation", "Antigravity 仅支持 Google 浏览器授权");
    },
  };
}
