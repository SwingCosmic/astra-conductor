import { describe, expect, it } from "vitest";
import {
  ContractValidationError,
  POLYQUOTA_SCHEMA_VERSION,
  parseRedeemResetCreditRequest,
  parseResetCreditRedemption,
  parseSettings,
  parseStartAuthRequest,
} from "../src/index";

/**
 * 请求侧（renderer → main）校验用例。响应方向零运行期解析（2026-10 校验
 * 归属定稿）：原 parseSnapshot / parseProviderDescriptor / parsePublicUsage
 * 等收包解析与 matchPublicPlan / publicPlanDisplayName 匹配助手已随解析点
 * 上移退役，快照断言移至 apps 的应用服务测试。
 */

describe("PolyQuota contract request validation", () => {
  it("keeps the schema version explicit so preload can compare it", () => {
    expect(POLYQUOTA_SCHEMA_VERSION).toBe(6);
  });

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
  });

  it("checks auth method ids structurally and leaves availability to the catalog", () => {
    // 认证方式是动态集合：契约只约束 slug 结构，是否可用由主进程交叉查目录。
    expect(parseStartAuthRequest({ offeringId: "codex", method: "magic-link" })).toEqual({
      offeringId: "codex",
      method: "magic-link",
    });
    expect(() => parseStartAuthRequest({ offeringId: "codex", method: "Magic Link" })).toThrow(
      ContractValidationError,
    );
    expect(() => parseStartAuthRequest({ offeringId: "codex", method: "" })).toThrow(
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
      parseRedeemResetCreditRequest({
        accountId: "glm-1",
        redemption: { kind: "voucher" },
      }),
    ).toThrow(ContractValidationError);
    expect(() =>
      parseRedeemResetCreditRequest({ accountId: "glm-1", selectionToken: "record-42" }),
    ).toThrow(ContractValidationError);
  });
});
