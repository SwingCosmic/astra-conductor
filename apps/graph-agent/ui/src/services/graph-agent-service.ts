import {
  customProviderOperations as customOps,
  type ICustomProviderService,
  type CommandContext,
  type ServiceResult,
  type IGraphAgentService,
} from "@astra-conductor/contract/graph-agent";
import {
  FetchServiceTransport,
  ServiceClientBase,
  mixin,
  withCredentialManagement,
  withProviderManagement,
} from "@astra-conductor/shared-ui/services";
import { withGraphModels } from "./model-management.js";
import type { InjectionKey } from "vue";

export const graphServiceKey: InjectionKey<IGraphAgentService> = Symbol("graphAgentService");

const GraphAgentServiceBase = mixin(
  ServiceClientBase,
  withProviderManagement,
  withCredentialManagement,
  withGraphModels,
);
export class HttpGraphAgentService extends GraphAgentServiceBase implements IGraphAgentService {
  private customContext: CommandContext | null = null;
  private async customWrite<T>(
    run: (ctx: CommandContext) => Promise<ServiceResult<T>>,
  ): Promise<ServiceResult<T>> {
    if (!this.customContext)
      return {
        ok: false,
        error: { code: "stale-context", message: "请先读取供应商目录", retryable: true },
      };
    return run(this.customContext);
  }
  readonly customProviders: ICustomProviderService = {
    list: async () => {
      const result = await this.providers.getSnapshot();
      if (!result.ok) return result;
      this.customContext = {
        instanceId: result.value.instanceId,
        contextId: result.value.backend.contextId,
      };
      return this.transport.request(customOps.list, undefined);
    },
    configureForAccount: (input) =>
      this.customWrite((ctx) =>
        this.transport.request(customOps.configureForAccount, { ...input, ...ctx }),
      ),
    references: (providerId) => this.transport.request(customOps.references, { providerId }),
    create: (draft) =>
      this.customWrite((ctx) => this.transport.request(customOps.create, { ...draft, ...ctx })),
    edit: (providerId, draft) =>
      this.customWrite((ctx) =>
        this.transport.request(customOps.edit, { providerId, ...draft, ...ctx }),
      ),
    remove: (providerId, expectedRevision) =>
      this.customWrite((ctx) =>
        this.transport.request(customOps.remove, { providerId, expectedRevision, ...ctx }),
      ),
    bindAccount: (binding) =>
      this.customWrite((ctx) =>
        this.transport.request(customOps.bindAccount, { ...binding, ...ctx }),
      ),
  };
}

export function createGraphAgentService(baseUrl = window.location.origin): IGraphAgentService {
  return new HttpGraphAgentService(new FetchServiceTransport({ baseUrl }));
}
