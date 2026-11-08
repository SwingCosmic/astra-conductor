import {
  polyQuotaOperations,
  type ResetCreditRedemption,
} from "@astra-conductor/contract/polyquota";
import { defineServiceSlice, ServiceClientBase } from "@astra-conductor/shared-ui/services";
export const withUsage = defineServiceSlice(
  ["refreshAccount", "refreshAll", "redeemResetCredit"],
  (Base: typeof ServiceClientBase) =>
    class extends Base {
      refreshAccount(accountId: string) {
        return this.transport.request(polyQuotaOperations.refreshAccount, { accountId });
      }
      refreshAll() {
        return this.transport.request(polyQuotaOperations.refreshAll, undefined);
      }
      redeemResetCredit(accountId: string, redemption: ResetCreditRedemption) {
        return this.transport.request(polyQuotaOperations.redeemResetCredit, {
          accountId,
          redemption,
        });
      }
    },
);
