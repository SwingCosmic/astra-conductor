import type { PublicAccount } from "./account.js";
import type { PublicAuthInteraction } from "../vocabularies.js";

export interface PublicAuthMethodDescriptor {
  method: string;
  interaction: PublicAuthInteraction;
  sourceLabel?: string;
  sourcePathHint?: string;
}

/**
 * 公开目录里的套餐条目只剩展示事实。数据层标识符（match 键）与倍率是 core
 * 内部事实，不过 IPC：匹配只发生在主进程构造快照时，前端只消费解析结果。
 */
export interface PublicPlanDescriptor {
  id: string;
  displayName: string;
}

export interface PublicOfferingDescriptor {
  id: string;
  provider: string;
  displayName: string;
  description?: string;
  websiteUrl?: string;
  iconKey?: string;
  authMethods: PublicAuthMethodDescriptor[];
  plans: readonly PublicPlanDescriptor[];
}

export interface PublicProviderDescriptor {
  provider: string;
  displayName: string;
  offerings: PublicOfferingDescriptor[];
}

/**
 * 认证请求以接入点为稳定入口：`offeringId` 从注册表交叉验证并决定 provider、
 * 端点与实现；`method` 必须是该接入点声明的认证方式（主进程交叉查目录）。
 * secret-form 输入统一走可选 `apiKey`，供应商实现在运行时再次校验，不信任
 * renderer 生成的表单。
 */
export interface StartAuthRequest {
  offeringId: string;
  method: string;
  apiKey?: string;
}

export type AuthStartResult =
  | { status: "completed"; account: PublicAccount }
  | { status: "pending"; sessionId: string; interaction: "browser-callback" }
  | {
      status: "pending";
      sessionId: string;
      interaction: "device-code";
      userCode: string;
      verificationUri: string;
    };
