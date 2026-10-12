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
  parseSystemStatus,
  publicPlanDisplayName,
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
    expect(parseStartAuthRequest({ provider: "claude", method: "cli-import" })).toEqual({
      provider: "claude",
      method: "cli-import",
    });
    expect(
      parseStartAuthRequest({ provider: "opencode-go", method: "api-key", apiKey: "oc-key" }),
    ).toEqual({ provider: "opencode-go", method: "api-key", apiKey: "oc-key" });
    expect(() => parseStartAuthRequest({ provider: "claude", method: "browser-oauth" })).toThrow(
      ContractValidationError,
    );
  });

  it("rejects unknown request fields and invalid polling intervals", () => {
    expect(
      parseSettings({
        pollingEnabled: true,
        pollingIntervalMinutes: 15,
        taskbarProgressEnabled: false,
      }),
    ).toEqual({
      pollingEnabled: true,
      pollingIntervalMinutes: 15,
      taskbarProgressEnabled: false,
    });
    expect(parseSettings({ pollingEnabled: true, pollingIntervalMinutes: 15 })).toEqual({
      pollingEnabled: true,
      pollingIntervalMinutes: 15,
      taskbarProgressEnabled: true,
    });
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
        schemaVersion: 4,
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
        plans: [
          {
            id: "pro",
            displayName: "Pro",
            match: ["pro", "glm coding pro"],
            multiplier: 6,
            source: "published",
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
      plans: [{ id: "pro", displayName: "Pro", match: ["pro", "glm coding pro"] }],
    });
  });

  it("resolves plan display names from the catalog and keeps unknown plans verbatim", () => {
    const plans = [{ id: "pro-5x", displayName: "Pro 5x", match: ["prolite", "pro 5x"] }];
    expect(publicPlanDisplayName(plans, "prolite")).toBe("Pro 5x");
    expect(publicPlanDisplayName(plans, "mystery-tier")).toBe("mystery-tier");
    expect(publicPlanDisplayName([], "plus")).toBe("plus");
  });

  it("rejects provider descriptors with broken ownership or duplicates", () => {
    expect(() =>
      parseProviderDescriptor({
        provider: "codex",
        displayName: "Codex",
        offerings: [{ id: "codex", provider: "glm", displayName: "Codex", authMethods: [] }],
        plans: [],
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
        plans: [],
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
        plans: [],
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
      settings: { pollingEnabled: true, pollingIntervalMinutes: 15, taskbarProgressEnabled: true },
      compositeRemaining: {
        status: "empty",
        sessionScore: null,
        weeklyScore: null,
        remaining: null,
        band: "unknown",
        sessionBand: "unknown",
        weeklyBand: "unknown",
        enabledAccountCount: 0,
        scoredAccountCount: 0,
      },
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
      plans: [],
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
    const { compositeRemaining: _remaining, ...withoutRemaining } = {
      ...snapshotBase,
      providers: [],
    };
    expect(parseSnapshot(withoutRemaining).compositeRemaining.status).toBe("empty");
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

  it("parses system status with a known proxy mode and nullable address", () => {
    expect(parseSystemStatus({ proxyMode: "direct", proxyAddress: null })).toEqual({
      proxyMode: "direct",
      proxyAddress: null,
    });
    expect(
      parseSystemStatus({ proxyMode: "environment", proxyAddress: "http://127.0.0.1:7890" }),
    ).toEqual({ proxyMode: "environment", proxyAddress: "http://127.0.0.1:7890" });
    expect(parseSystemStatus({ proxyMode: "unknown", proxyAddress: null })).toEqual({
      proxyMode: "unknown",
      proxyAddress: null,
    });
    expect(() => parseSystemStatus({ proxyMode: "url-probe", proxyAddress: null })).toThrow(
      ContractValidationError,
    );
    expect(() => parseSystemStatus({ proxyMode: "system" })).toThrow(ContractValidationError);
  });
});
