import { describe, expect, it } from "vitest";
import {
  ContractValidationError,
  POLYQUOTA_SCHEMA_VERSION,
  parseChangedEvent,
  parseProviderDescriptor,
  parseRedeemResetCreditOutcome,
  parseRedeemResetCreditRequest,
  parseSettings,
  parseSnapshot,
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
        schemaVersion: 3,
        revision: 1,
        reasons: ["usage"],
        occurredAt: "2026-09-27T00:00:00.000Z",
      }),
    ).toThrow(ContractValidationError);
  });

  it("parses provider descriptors with offerings and auth methods", () => {
    expect(
      parseProviderDescriptor({
        provider: "glm",
        displayName: "GLM Coding Plan",
        offerings: [
          {
            id: "bigmodel-coding-plan",
            provider: "glm",
            displayName: "BigModel Coding Plan",
            region: "china",
            authMethods: [
              { method: "cli-import", interaction: "local-import", sourceLabel: "ZCode" },
              { method: "api-key", interaction: "secret-form" },
            ],
          },
        ],
      }),
    ).toEqual({
      provider: "glm",
      displayName: "GLM Coding Plan",
      offerings: [
        {
          id: "bigmodel-coding-plan",
          provider: "glm",
          displayName: "BigModel Coding Plan",
          region: "china",
          authMethods: [
            { method: "cli-import", interaction: "local-import", sourceLabel: "ZCode" },
            { method: "api-key", interaction: "secret-form" },
          ],
        },
      ],
    });
  });

  it("rejects provider descriptors with broken ownership or duplicates", () => {
    expect(() =>
      parseProviderDescriptor({
        provider: "codex",
        displayName: "Codex",
        offerings: [{ id: "codex", provider: "glm", displayName: "Codex", authMethods: [] }],
      }),
    ).toThrow(ContractValidationError);
    expect(() =>
      parseProviderDescriptor({
        provider: "codex",
        displayName: "Codex",
        offerings: [
          { id: "codex", provider: "codex", displayName: "Codex", authMethods: [] },
          { id: "codex", provider: "codex", displayName: "Codex", authMethods: [] },
        ],
      }),
    ).toThrow(ContractValidationError);
    expect(() =>
      parseProviderDescriptor({
        provider: "codex",
        displayName: "Codex",
        offerings: [
          {
            id: "codex",
            provider: "codex",
            displayName: "Codex",
            authMethods: [
              { method: "browser-oauth", interaction: "browser-callback" },
              { method: "browser-oauth", interaction: "browser-callback" },
            ],
          },
        ],
      }),
    ).toThrow(ContractValidationError);
  });

  it("requires the provider catalog in snapshots and rejects duplicates", () => {
    const snapshotBase = {
      schemaVersion: POLYQUOTA_SCHEMA_VERSION,
      revision: 1,
      generatedAt: "2026-09-27T00:00:00.000Z",
      accounts: [],
      usageByAccountId: {},
      operations: [],
      settings: { pollingEnabled: true, pollingIntervalMinutes: 15 },
      scheduler: {
        status: "waiting",
        intervalMinutes: 15,
        nextRunAt: null,
        lastRunStartedAt: null,
        lastRunFinishedAt: null,
        lastResult: null,
      },
    };
    const codexDescriptor = {
      provider: "codex",
      displayName: "OpenAI Codex",
      offerings: [
        {
          id: "codex",
          provider: "codex",
          displayName: "OpenAI Codex",
          authMethods: [{ method: "browser-oauth", interaction: "browser-callback" }],
        },
      ],
    };
    expect(parseSnapshot({ ...snapshotBase, providers: [codexDescriptor] }).providers).toHaveLength(
      1,
    );
    expect(() => parseSnapshot({ ...snapshotBase, providers: [] })).not.toThrow();
    expect(() =>
      parseSnapshot({ ...snapshotBase, providers: [codexDescriptor, codexDescriptor] }),
    ).toThrow(ContractValidationError);
    const { providers: _providers, ...withoutProviders } = {
      ...snapshotBase,
      providers: [],
    };
    expect(() => parseSnapshot(withoutProviders)).toThrow(ContractValidationError);
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
