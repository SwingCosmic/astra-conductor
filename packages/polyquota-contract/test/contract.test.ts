import { describe, expect, it } from "vitest";
import {
  ContractValidationError,
  POLYQUOTA_SCHEMA_VERSION,
  parseChangedEvent,
  parseProviderDescriptor,
  parsePublicAccount,
  parsePublicUsage,
  parseRedeemResetCreditOutcome,
  parseRedeemResetCreditRequest,
  parseResetCreditRedemption,
  parseSettings,
  parseSnapshot,
  parseStartAuthRequest,
  parseSystemStatus,
  publicPlanDisplayName,
} from "../src/index";

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

describe("PolyQuota contract", () => {
  it("accepts shape-valid auth requests keyed by offering id", () => {
    expect(parseStartAuthRequest({ offeringId: "codex", method: "browser-oauth" })).toEqual({
      offeringId: "codex",
      method: "browser-oauth",
    });
    expect(
      parseStartAuthRequest({
        offeringId: "bigmodel-coding-plan",
        method: "api-key",
        apiKey: "secret",
      }),
    ).toEqual({ offeringId: "bigmodel-coding-plan", method: "api-key", apiKey: "secret" });
    expect(parseStartAuthRequest({ offeringId: "grok-build", method: "device-code" })).toEqual({
      offeringId: "grok-build",
      method: "device-code",
    });
    expect(() => parseStartAuthRequest({ offeringId: "Codex", method: "browser-oauth" })).toThrow(
      ContractValidationError,
    );
    expect(() =>
      parseStartAuthRequest({ offeringId: "c".repeat(65), method: "browser-oauth" }),
    ).toThrow(ContractValidationError);
    expect(() => parseStartAuthRequest({ offeringId: "codex", method: "magic-link" })).toThrow(
      ContractValidationError,
    );
  });

  it("rejects unknown request fields, blank keys, and invalid polling intervals", () => {
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
      parseStartAuthRequest({ offeringId: "codex", method: "cli-import", token: "secret" }),
    ).toThrow(ContractValidationError);
    expect(() =>
      parseStartAuthRequest({ offeringId: "codex", method: "api-key", apiKey: "   " }),
    ).toThrow(ContractValidationError);
    expect(() =>
      parseStartAuthRequest({
        offeringId: "codex",
        method: "api-key",
        apiKey: "k".repeat(4097),
      }),
    ).toThrow(ContractValidationError);
    expect(
      parseStartAuthRequest({
        offeringId: "codex",
        method: "api-key",
        apiKey: "k".repeat(4096),
      }),
    ).toEqual({ offeringId: "codex", method: "api-key", apiKey: "k".repeat(4096) });
  });

  it("rejects changed events from a different contract version", () => {
    expect(
      parseChangedEvent({
        schemaVersion: POLYQUOTA_SCHEMA_VERSION,
        revision: 1,
        reasons: ["usage"],
        occurredAt: "2026-09-27T00:00:00.000Z",
      }),
    ).toEqual({
      schemaVersion: POLYQUOTA_SCHEMA_VERSION,
      revision: 1,
      reasons: ["usage"],
      occurredAt: "2026-09-27T00:00:00.000Z",
    });
    expect(() =>
      parseChangedEvent({
        schemaVersion: 3,
        revision: 1,
        reasons: ["usage"],
        occurredAt: "2026-09-27T00:00:00.000Z",
      }),
    ).toThrow(ContractValidationError);
  });

  it("parses provider descriptors with offerings, auth methods, and per-offering plans", () => {
    expect(
      parseProviderDescriptor({
        provider: "glm",
        displayName: "GLM Coding Plan",
        offerings: [
          {
            id: "bigmodel-coding-plan",
            provider: "glm",
            displayName: "BigModel Coding Plan",
            iconKey: "glm",
            authMethods: [
              {
                method: "cli-import",
                interaction: "local-import",
                sourceLabel: "ZCode",
                sourcePathHint: "~/.zcode/auth.json",
              },
              { method: "api-key", interaction: "secret-form" },
            ],
            plans: [{ id: "pro", displayName: "Pro", match: ["pro", "glm coding pro"] }],
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
          iconKey: "glm",
          authMethods: [
            {
              method: "cli-import",
              interaction: "local-import",
              sourceLabel: "ZCode",
              sourcePathHint: "~/.zcode/auth.json",
            },
            { method: "api-key", interaction: "secret-form" },
          ],
          plans: [{ id: "pro", displayName: "Pro", match: ["pro", "glm coding pro"] }],
        },
      ],
    });
  });

  it("rejects provider descriptors carrying removed top-level catalog fields", () => {
    expect(() =>
      parseProviderDescriptor({
        provider: "glm",
        displayName: "GLM Coding Plan",
        plans: [{ id: "pro", displayName: "Pro", match: ["pro"] }],
        offerings: [],
      }),
    ).toThrow(ContractValidationError);
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
        offerings: [
          { id: "codex", provider: "glm", displayName: "Codex", authMethods: [], plans: [] },
        ],
      }),
    ).toThrow(ContractValidationError);
    expect(() =>
      parseProviderDescriptor({
        provider: "codex",
        displayName: "Codex",
        offerings: [
          { id: "codex", provider: "codex", displayName: "Codex", authMethods: [], plans: [] },
          { id: "codex", provider: "codex", displayName: "Codex", authMethods: [], plans: [] },
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
            plans: [],
          },
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
            authMethods: [],
            plans: [
              { id: "pro", displayName: "Pro", match: ["pro"] },
              { id: "pro", displayName: "Pro (alt)", match: ["pro plan"] },
            ],
          },
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
            authMethods: [],
            plans: [
              { id: "pro", displayName: "Pro", match: ["pro"] },
              { id: "max", displayName: "Max", match: ["  Pro  "] },
            ],
          },
        ],
      }),
    ).toThrow(ContractValidationError);
  });

  it("rejects malformed per-offering plans", () => {
    const withPlans = (plans: unknown) =>
      parseProviderDescriptor({
        provider: "codex",
        displayName: "Codex",
        offerings: [
          { id: "codex", provider: "codex", displayName: "Codex", authMethods: [], plans },
        ],
      });
    expect(() => withPlans([{ id: "Pro", displayName: "Pro", match: ["pro"] }])).toThrow(
      ContractValidationError,
    );
    expect(() => withPlans([{ id: "pro", displayName: "  ", match: ["pro"] }])).toThrow(
      ContractValidationError,
    );
    expect(() => withPlans([{ id: "pro", displayName: "Pro", match: [] }])).toThrow(
      ContractValidationError,
    );
  });

  it("requires accounts to pin their offering id", () => {
    const accountBase = {
      id: "acc-1",
      provider: "glm",
      authMethod: "api-key",
      displayName: "BigModel key",
      maskedIdentifier: "sk-***abc",
      enabled: true,
      credentialState: "available",
      tokenExpiresAt: null,
      publicMetadata: {},
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
    };
    expect(parsePublicAccount({ ...accountBase, offeringId: "bigmodel-coding-plan" })).toEqual({
      ...accountBase,
      offeringId: "bigmodel-coding-plan",
    });
    expect(() => parsePublicAccount({ ...accountBase, offeringId: "Bigmodel Plan" })).toThrow(
      ContractValidationError,
    );
    expect(() => parsePublicAccount(accountBase)).toThrow(ContractValidationError);
  });

  it("requires the provider catalog in snapshots and rejects duplicates", () => {
    const codexDescriptor = {
      provider: "codex",
      displayName: "OpenAI Codex",
      offerings: [
        {
          id: "codex",
          provider: "codex",
          displayName: "OpenAI Codex",
          authMethods: [{ method: "browser-oauth", interaction: "browser-callback" }],
          plans: [{ id: "pro", displayName: "Pro", match: ["pro"] }],
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
    const { compositeRemaining: _remaining, ...withoutRemaining } = {
      ...snapshotBase,
      providers: [],
    };
    expect(parseSnapshot(withoutRemaining).compositeRemaining.status).toBe("empty");
  });

  it("rejects snapshot catalogs whose offerings lack plans", () => {
    const codexWithoutPlans = {
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
    expect(() => parseSnapshot({ ...snapshotBase, providers: [codexWithoutPlans] })).toThrow(
      ContractValidationError,
    );
  });

  it("accepts only bounded reset-credit redemptions", () => {
    expect(parseResetCreditRedemption({ kind: "aggregate" })).toEqual({ kind: "aggregate" });
    expect(parseResetCreditRedemption({ kind: "aggregate", type: "five-hour" })).toEqual({
      kind: "aggregate",
      type: "five-hour",
    });
    expect(parseResetCreditRedemption({ kind: "aggregate", type: "t".repeat(64) })).toEqual({
      kind: "aggregate",
      type: "t".repeat(64),
    });
    expect(() => parseResetCreditRedemption({ kind: "aggregate", type: "   " })).toThrow(
      ContractValidationError,
    );
    expect(() => parseResetCreditRedemption({ kind: "aggregate", type: "t".repeat(65) })).toThrow(
      ContractValidationError,
    );
    expect(parseResetCreditRedemption({ kind: "item", itemId: "record-42" })).toEqual({
      kind: "item",
      itemId: "record-42",
    });
    expect(parseResetCreditRedemption({ kind: "item", itemId: "i".repeat(256) })).toEqual({
      kind: "item",
      itemId: "i".repeat(256),
    });
    expect(() => parseResetCreditRedemption({ kind: "item", itemId: "" })).toThrow(
      ContractValidationError,
    );
    expect(() => parseResetCreditRedemption({ kind: "item", itemId: "i".repeat(257) })).toThrow(
      ContractValidationError,
    );
    expect(() => parseResetCreditRedemption({ kind: "voucher" })).toThrow(ContractValidationError);
    expect(() =>
      parseResetCreditRedemption({ kind: "item", itemId: "record-42", token: "secret" }),
    ).toThrow(ContractValidationError);
  });

  it("wraps reset-credit redemptions with a bounded account id", () => {
    expect(
      parseRedeemResetCreditRequest({
        accountId: "glm-1",
        redemption: { kind: "item", itemId: "record-42" },
      }),
    ).toEqual({ accountId: "glm-1", redemption: { kind: "item", itemId: "record-42" } });
    expect(
      parseRedeemResetCreditRequest({ accountId: "glm-1", redemption: { kind: "aggregate" } }),
    ).toEqual({ accountId: "glm-1", redemption: { kind: "aggregate" } });
    expect(() =>
      parseRedeemResetCreditRequest({
        accountId: "../glm-1",
        redemption: { kind: "aggregate" },
      }),
    ).toThrow(ContractValidationError);
    expect(() =>
      parseRedeemResetCreditRequest({ accountId: "glm-1", redemption: { kind: "voucher" } }),
    ).toThrow(ContractValidationError);
    expect(() =>
      parseRedeemResetCreditRequest({ accountId: "glm-1", selectionToken: "record-42" }),
    ).toThrow(ContractValidationError);
  });

  it("validates reset credits in both shapes and tolerates absence", () => {
    const usageBase = {
      accountId: "glm-1",
      plan: "Pro",
      overallRemainingPercentage: 42,
      groups: [],
      extras: [],
      fetchedAt: "2026-09-27T00:00:00.000Z",
    };
    const aggregate = {
      kind: "aggregate",
      totals: [
        { type: "five-hour", total: 1 },
        { type: "weekly", total: 2 },
      ],
    };
    expect(parsePublicUsage({ ...usageBase, resetCredits: aggregate }).resetCredits).toEqual(
      aggregate,
    );
    expect(() =>
      parsePublicUsage({
        ...usageBase,
        resetCredits: {
          kind: "aggregate",
          totals: [
            { type: "five-hour", total: 1 },
            { type: "five-hour", total: 2 },
          ],
        },
      }),
    ).toThrow(ContractValidationError);
    expect(() =>
      parsePublicUsage({ ...usageBase, resetCredits: { kind: "aggregate", totals: [] } }),
    ).toThrow(ContractValidationError);
    expect(() =>
      parsePublicUsage({
        ...usageBase,
        resetCredits: { kind: "aggregate", totals: [{ type: "five-hour", total: -1 }] },
      }),
    ).toThrow(ContractValidationError);
    const itemized = {
      kind: "itemized",
      items: [
        { id: "r-1", type: "five-hour", expiresAt: "2026-10-01T00:00:00.000Z" },
        { id: "r-2", type: "weekly", expiresAt: null },
      ],
    };
    expect(parsePublicUsage({ ...usageBase, resetCredits: itemized }).resetCredits).toEqual(
      itemized,
    );
    expect(() =>
      parsePublicUsage({
        ...usageBase,
        resetCredits: {
          kind: "itemized",
          items: [
            { id: "r-1", type: "five-hour", expiresAt: null },
            { id: "r-1", type: "weekly", expiresAt: null },
          ],
        },
      }),
    ).toThrow(ContractValidationError);
    expect(parsePublicUsage({ ...usageBase, resetCredits: null }).resetCredits).toBeNull();
    expect(parsePublicUsage(usageBase).resetCredits).toBeNull();
    expect(() =>
      parsePublicUsage({ ...usageBase, resetCredits: { kind: "voucher", code: "x" } }),
    ).toThrow(ContractValidationError);
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
    ).toEqual({
      proxyMode: "environment",
      proxyAddress: "http://127.0.0.1:7890",
    });
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
