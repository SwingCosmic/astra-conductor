import type { ICustomProviderService } from "./custom-providers.js";
export * from "./custom-providers.js";
import type { ICommonProductService } from "../common/index.js";
import type { IGraphAgentChatService } from "./chat.js";
import type { IGraphAgentModelService } from "./models.js";

export * from "../common/index.js";
export * from "./legacy-import.js";
export * from "./chat.js";
export * from "./models.js";
export * from "./model-operations.js";

export interface IGraphAgentService
  extends ICommonProductService,
    IGraphAgentModelService,
    IGraphAgentChatService {
  readonly customProviders: ICustomProviderService;
}
