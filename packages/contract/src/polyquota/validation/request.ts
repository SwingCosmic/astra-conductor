import type { Settings } from "../dto/settings.js";
import type { RedeemResetCreditRequest } from "../dto/operations.js";
import {
  object,
  number,
  boolean,
  fail,
  exact,
  parseAccountId,
  parseResetCreditRedemption,
} from "../../common/validation/request.js";

export function parseSettings(value: unknown): Settings {
  const record = object(value, "settings");
  const pollingIntervalMinutes = number(
    record.pollingIntervalMinutes,
    "settings.pollingIntervalMinutes",
  );
  if (
    !Number.isInteger(pollingIntervalMinutes) ||
    pollingIntervalMinutes < 5 ||
    pollingIntervalMinutes > 1440
  ) {
    return fail("settings.pollingIntervalMinutes");
  }
  return {
    pollingEnabled: boolean(record.pollingEnabled, "settings.pollingEnabled"),
    pollingIntervalMinutes,
    taskbarProgressEnabled:
      record.taskbarProgressEnabled === undefined
        ? true
        : boolean(record.taskbarProgressEnabled, "settings.taskbarProgressEnabled"),
  };
}

export function parseRedeemResetCreditRequest(value: unknown): RedeemResetCreditRequest {
  const record = object(value, "redeemResetCredit");
  exact(record, ["accountId", "redemption"], "redeemResetCredit");
  return {
    accountId: parseAccountId(record.accountId),
    redemption: parseResetCreditRedemption(record.redemption),
  };
}
