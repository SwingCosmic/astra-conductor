import type { ICommonProductService } from "../common/index.js";

export * from "../common/index.js";
export * from "./legacy-import.js";

/** Model configuration operations are added with the stage-two backend implementation. */
export interface IGraphAgentService extends ICommonProductService {}
