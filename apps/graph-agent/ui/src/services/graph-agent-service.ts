import type { IGraphAgentService } from "@astra-conductor/contract/graph-agent";
import {
  FetchServiceTransport,
  ServiceClientBase,
  mixin,
  withCredentialManagement,
  withProviderManagement,
} from "@astra-conductor/shared-ui/services";

const GraphAgentServiceBase = mixin(
  ServiceClientBase,
  withProviderManagement,
  withCredentialManagement,
);
export class HttpGraphAgentService extends GraphAgentServiceBase implements IGraphAgentService {}

export function createGraphAgentService(baseUrl = window.location.origin): IGraphAgentService {
  return new HttpGraphAgentService(new FetchServiceTransport({ baseUrl }));
}
