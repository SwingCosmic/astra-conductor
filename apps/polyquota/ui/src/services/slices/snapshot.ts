import {
  polyQuotaEventChannel,
  polyQuotaOperations,
  type PolyQuotaChangedEvent,
} from "@astra-conductor/contract/polyquota";
import { defineServiceSlice, ServiceClientBase } from "@astra-conductor/shared-ui/services";
export const withSnapshot = defineServiceSlice(
  ["getSnapshot", "subscribe"],
  (Base: typeof ServiceClientBase) =>
    class extends Base {
      getSnapshot() {
        return this.transport.request(polyQuotaOperations.getSnapshot, undefined);
      }
      subscribe(listener: (event: PolyQuotaChangedEvent) => void): () => void {
        return this.transport.subscribe(polyQuotaEventChannel, listener);
      }
    },
);
