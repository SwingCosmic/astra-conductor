import { describe, expect, it } from "vitest";
import {
  ContractValidationError,
  parseChangedEvent,
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
});
