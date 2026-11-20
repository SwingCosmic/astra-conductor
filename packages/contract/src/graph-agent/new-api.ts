import {
  apiOperation,
  type CommandContext,
  type PublicConnection,
  type ServiceResult,
} from "../common/index.js";
import {
  exact,
  fail,
  object,
  parseAccountId,
  parseCommandContext,
} from "../common/validation/request.js";
import { customRevision, providerSlug } from "./custom-providers.js";

export interface NewApiOfferingRequest extends CommandContext {
  providerId: string;
  offeringId: string;
  expectedProviderRevision: number;
}
export interface NewApiAccountRequest extends NewApiOfferingRequest {
  accountId: string;
  expectedRecordRevision: string;
}
export interface NewApiOfferingKeysRequest extends NewApiOfferingRequest {
  accessToken: string;
  page: number;
}
export interface NewApiCreateAccountRequest extends NewApiOfferingRequest {
  accessToken: string;
  tokenId: number;
  operationId: string;
  displayName: string;
}
export interface NewApiListKeysRequest extends NewApiAccountRequest {
  accessToken: string;
  page: number;
}
export interface NewApiSelectKeyRequest extends NewApiAccountRequest {
  accessToken: string;
  tokenId: number;
}
export interface NewApiUsage {
  totalGranted: number | null;
  totalUsed: number | null;
  totalAvailable: number | null;
  unlimitedQuota: boolean | null;
  /** Unix seconds; the upstream returns zero for an unexpiring token. */
  expiresAt: number | null;
  userQuota: { totalAvailable: number | null; totalUsed: number | null } | null;
}
export interface NewApiKeySummary {
  id: number;
  name: string;
  status: number | null;
  group: string;
  /** Unix seconds; the upstream token list uses -1 for an unexpiring token. */
  expiresAt: number | null;
}
export interface NewApiKeyPage {
  page: number;
  pageSize: number;
  total: number;
  items: NewApiKeySummary[];
}
export interface INewApiService {
  listOfferingKeys(
    input: NewApiOfferingKeysRequest,
    signal?: AbortSignal,
  ): Promise<ServiceResult<NewApiKeyPage>>;
  createAccountWithKey(
    input: NewApiCreateAccountRequest,
    signal?: AbortSignal,
  ): Promise<ServiceResult<PublicConnection>>;
  getUsage(input: NewApiAccountRequest, signal?: AbortSignal): Promise<ServiceResult<NewApiUsage>>;
  listKeys(
    input: NewApiListKeysRequest,
    signal?: AbortSignal,
  ): Promise<ServiceResult<NewApiKeyPage>>;
  selectKey(input: NewApiSelectKeyRequest, signal?: AbortSignal): Promise<ServiceResult<void>>;
}

function offeringRequest(row: Record<string, unknown>, extra: string[]): NewApiOfferingRequest {
  exact(
    row,
    ["providerId", "offeringId", "instanceId", "contextId", "expectedProviderRevision", ...extra],
    "newApi",
  );
  return {
    ...parseCommandContext(row),
    providerId: providerSlug(row.providerId),
    offeringId: providerSlug(row.offeringId, "offeringId"),
    expectedProviderRevision: customRevision(row.expectedProviderRevision),
  };
}
function accountRequest(row: Record<string, unknown>, extra: string[] = []): NewApiAccountRequest {
  if (
    typeof row.expectedRecordRevision !== "string" ||
    !/^[\x21-\x7e]{1,256}$/.test(row.expectedRecordRevision)
  )
    return fail("expectedRecordRevision");
  return {
    ...offeringRequest(row, ["accountId", "expectedRecordRevision", ...extra]),
    accountId: parseAccountId(row.accountId),
    expectedRecordRevision: row.expectedRecordRevision,
  };
}
function accessToken(value: unknown): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(value)) return fail("accessToken");
  return value;
}
function positive(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return fail(name);
  return value;
}
export const newApiPath = "/api/v1/graph-agent/new-api";
const body = <T>(value: T) => value;
export const newApiOperations = {
  listOfferingKeys: apiOperation<NewApiOfferingKeysRequest, NewApiKeyPage>(
    "POST",
    newApiPath + "/offering/keys",
    {
      body,
      parseInput: (value) => {
        const row = object(value, "newApi");
        return {
          ...offeringRequest(row, ["accessToken", "page"]),
          accessToken: accessToken(row.accessToken),
          page: positive(row.page, "page"),
        };
      },
    },
  ),
  createAccountWithKey: apiOperation<NewApiCreateAccountRequest, PublicConnection>(
    "POST",
    newApiPath + "/offering/create-account",
    {
      body,
      parseInput: (value) => {
        const row = object(value, "newApi");
        if (typeof row.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.operationId))
          return fail("operationId");
        const token = accessToken(row.accessToken);
        if (
          typeof row.displayName !== "string" ||
          !row.displayName.trim() ||
          row.displayName.length > 128 ||
          /[\x00-\x1f\x7f]/.test(row.displayName) ||
          row.displayName.includes(token)
        )
          return fail("displayName");
        return {
          ...offeringRequest(row, ["accessToken", "tokenId", "operationId", "displayName"]),
          accessToken: token,
          tokenId: positive(row.tokenId, "tokenId"),
          operationId: row.operationId,
          displayName: row.displayName.trim(),
        };
      },
    },
  ),
  getUsage: apiOperation<NewApiAccountRequest, NewApiUsage>("POST", newApiPath + "/usage", {
    body,
    parseInput: (value) => accountRequest(object(value, "newApi")),
  }),
  listKeys: apiOperation<NewApiListKeysRequest, NewApiKeyPage>("POST", newApiPath + "/keys", {
    body,
    parseInput: (value) => {
      const row = object(value, "newApi");
      return {
        ...accountRequest(row, ["accessToken", "page"]),
        accessToken: accessToken(row.accessToken),
        page: positive(row.page, "page"),
      };
    },
  }),
  selectKey: apiOperation<NewApiSelectKeyRequest, void>("POST", newApiPath + "/select-key", {
    body,
    voidResult: true,
    parseInput: (value) => {
      const row = object(value, "newApi");
      return {
        ...accountRequest(row, ["accessToken", "tokenId"]),
        accessToken: accessToken(row.accessToken),
        tokenId: positive(row.tokenId, "tokenId"),
      };
    },
  }),
};
