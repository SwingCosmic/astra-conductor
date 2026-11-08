import type { IPolyQuotaService } from "@astra-conductor/contract/polyquota";
import type { IHostService, INotificationService } from "@astra-conductor/contract/common";
import {
  ServiceClientBase,
  mixin,
  withProviderManagement,
  withCredentialManagement,
} from "@astra-conductor/shared-ui/services";
import { withSnapshot } from "./slices/snapshot";
import { withUsage } from "./slices/usage";
import { withSettings } from "./slices/settings";
import { withHost } from "./slices/host";
export class HttpPolyQuotaService
  extends mixin(
    ServiceClientBase,
    withProviderManagement,
    withCredentialManagement,
    withSnapshot,
    withUsage,
    withSettings,
    withHost,
  )
  implements IPolyQuotaService, IHostService, INotificationService {}
