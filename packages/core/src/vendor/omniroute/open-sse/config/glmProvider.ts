type JsonRecord = Record<string, unknown>;

export type GlmApiRegion = "international" | "china";

export const GLM_QUOTA_URLS = Object.freeze({
  international: "https://api.z.ai/api/monitor/usage/quota/limit",
  china: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
});

export const GLM_RESET_CARD_URLS = Object.freeze({
  international: "https://api.z.ai/api/biz/customer-package-reset",
  china: "https://open.bigmodel.cn/api/biz/customer-package-reset",
});

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getGlmApiRegion(providerSpecificData: unknown): GlmApiRegion {
  const data = asRecord(providerSpecificData);
  return data.apiRegion === "china" ? "china" : "international";
}

const organizationKeys = ["glmOrganizationId", "bigmodelOrganization", "glmOrganization"];
const projectKeys = ["glmProjectId", "bigmodelProject", "glmProject"];

function firstString(data: JsonRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = asString(data[key]);
    if (value) return value;
  }
  return null;
}

export type GlmTeamQuotaConfig =
  | { state: "none" }
  | { state: "configured"; organizationId: string; projectId: string }
  | { state: "incomplete"; missing: "glmOrganizationId" | "glmProjectId" };

export function getGlmTeamQuotaConfig(providerSpecificData: unknown): GlmTeamQuotaConfig {
  const data = asRecord(providerSpecificData);
  const organizationId = firstString(data, organizationKeys);
  const projectId = firstString(data, projectKeys);
  if (!organizationId && !projectId) return { state: "none" };
  if (organizationId && projectId) {
    return { state: "configured", organizationId, projectId };
  }
  return {
    state: "incomplete",
    missing: organizationId ? "glmProjectId" : "glmOrganizationId",
  };
}

function withTeamHeaders(
  headers: Record<string, string>,
  providerSpecificData: unknown,
): Record<string, string> {
  const team = getGlmTeamQuotaConfig(providerSpecificData);
  if (team.state === "configured") {
    headers["bigmodel-organization"] = team.organizationId;
    headers["bigmodel-project"] = team.projectId;
  }
  return headers;
}

export function buildGlmQuotaFetch(
  apiKey: string,
  providerSpecificData?: unknown,
): { url: string; headers: Record<string, string> } {
  const team = getGlmTeamQuotaConfig(providerSpecificData);
  const baseUrl = GLM_QUOTA_URLS[getGlmApiRegion(providerSpecificData)];
  return {
    url: team.state === "configured" ? `${baseUrl}?type=2` : baseUrl,
    headers: withTeamHeaders(
      { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      providerSpecificData,
    ),
  };
}

export function buildGlmResetCardListFetch(
  apiKey: string,
  providerSpecificData?: unknown,
): { url: string; headers: Record<string, string> } {
  const baseUrl = GLM_RESET_CARD_URLS[getGlmApiRegion(providerSpecificData)];
  return {
    url: `${baseUrl}/list?targetType=PERSONAL`,
    headers: withTeamHeaders(
      { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      providerSpecificData,
    ),
  };
}
