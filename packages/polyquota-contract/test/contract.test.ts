import { describe, expect, it } from "vitest";
import {
  ContractValidationError,
  parseChangedEvent,
  parseRedeemResetCreditOutcome,
  parseRedeemResetCreditRequest,
  parseSettings,
  parseStartAuthRequest,
} from "../src/index";

describe("PolyQuota contract", () => {
  it("accepts only currently implemented authentication combinations", () => {
    expect(
      parseStartAuthRequest({
        provider: "glm",
        method: "api-key",
        region: "china",
        apiKey: "secret",
      }),
    ).toEqual({ provider: "glm", method: "api-key", region: "china", apiKey: "secret" });
    expect(() =>
      parseStartAuthRequest({ provider: "codex", method: "api-key", apiKey: "secret" }),
    ).toThrow(ContractValidationError);
    expect(parseStartAuthRequest({ provider: "grok-build", method: "device-code" })).toEqual({
      provider: "grok-build",
      method: "device-code",
    });
    expect(parseStartAuthRequest({ provider: "antigravity", method: "browser-oauth" })).toEqual({
      provider: "antigravity",
      method: "browser-oauth",
    });
    expect(() => parseStartAuthRequest({ provider: "antigravity", method: "device-code" })).toThrow(
      ContractValidationError,
    );
  });

  it("rejects unknown request fields and invalid polling intervals", () => {
    expect(() => parseSettings({ pollingEnabled: true, pollingIntervalMinutes: 4 })).toThrow(
      ContractValidationError,
    );
    expect(() =>
      parseStartAuthRequest({ provider: "codex", method: "cli-import", token: "secret" }),
    ).toThrow(ContractValidationError);
  });

  it("rejects changed events from a different contract version", () => {
    expect(() =>
      parseChangedEvent({
        schemaVersion: 2,
        revision: 1,
        reasons: ["usage"],
        occurredAt: "2026-09-27T00:00:00.000Z",
      }),
    ).toThrow(ContractValidationError);
  });

  it("accepts only bounded reset-credit use requests", () => {
    expect(
      parseRedeemResetCreditRequest({ accountId: "glm-1", selectionToken: "record-42" }),
    ).toEqual({ accountId: "glm-1", selectionToken: "record-42" });
    expect(() =>
      parseRedeemResetCreditRequest({ accountId: "../glm-1", selectionToken: "record-42" }),
    ).toThrow(ContractValidationError);
    expect(() => parseRedeemResetCreditRequest({ accountId: "glm-1", selectionToken: "" })).toThrow(
      ContractValidationError,
    );
  });

  it("keeps the reconciled remaining count in reset-credit outcomes", () => {
    expect(
      parseRedeemResetCreditOutcome({
        status: "redeemed",
        accountId: "glm-1",
        refreshStatus: "updated",
        remainingResetCredits: 1,
      }),
    ).toEqual({
      status: "redeemed",
      accountId: "glm-1",
      refreshStatus: "updated",
      remainingResetCredits: 1,
    });
    expect(() =>
      parseRedeemResetCreditOutcome({
        status: "redeemed",
        accountId: "glm-1",
        refreshStatus: "updated",
        remainingResetCredits: -1,
      }),
    ).toThrow(ContractValidationError);
  });
});
