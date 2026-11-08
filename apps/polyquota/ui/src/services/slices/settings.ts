import { polyQuotaOperations, type Settings } from "@astra-conductor/contract/polyquota";
import { defineServiceSlice, ServiceClientBase } from "@astra-conductor/shared-ui/services";
export const withSettings = defineServiceSlice(
  ["saveSettings", "getSystemStatus"],
  (Base: typeof ServiceClientBase) =>
    class extends Base {
      saveSettings(settings: Settings) {
        return this.transport.request(polyQuotaOperations.saveSettings, settings);
      }
      getSystemStatus() {
        return this.transport.request(polyQuotaOperations.getSystemStatus, undefined);
      }
    },
);
