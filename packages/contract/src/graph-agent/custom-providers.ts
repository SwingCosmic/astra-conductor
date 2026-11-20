import {
  apiOperation,
  parseHttpBaseUrl,
  parseFamilyPolicy,
  assertFamilyRoots,
  protocolFamilies,
  type ProtocolFamilyPolicy,
  type ProtocolFamily,
  parseModelRouteInput,
  type ModelRouteInput,
  type ModelPrice,
  type CommandContext,
  type ServiceResult,
} from "../common/index.js";
import { object, exact, fail, parseAccountId } from "../common/validation/request.js";

export interface CustomOffering {
  offeringId: string;
  name: string;
  siteBaseUrl?: string;
  routes: ModelRouteInput[];
}
export type CustomProviderTemplateKind = "generic" | "new-api";
export interface CustomProviderDraft {
  familyPolicies?: Partial<Record<ProtocolFamily, ProtocolFamilyPolicy>>;
  templateKind?: CustomProviderTemplateKind;
  name: string;
  icon: string | null;
  offerings: CustomOffering[];
}
export interface CustomProvider extends CustomProviderDraft {
  templateKind: CustomProviderTemplateKind;
  providerId: string;
  revision: number;
}
export interface CustomProviderReference {
  accountId: string;
  bindingRevision: string;
  displayName: string;
  offeringId: string;
  enabled: boolean;
}
export interface BindCustomAccount {
  accountId: string;
  providerId: string;
  offeringId: string | null;
  expectedRevision: string;
  expectedOfferingId?: string;
}
export interface NewApiSiteCatalogQuery {
  providerId: string;
  offeringId: string;
  expectedRevision: number;
}
export interface NewApiSiteModel {
  modelId: string;
  displayName: string;
  endpointTypes: string[];
  prices: ModelPrice[];
  billing: {
    kind: "token-ratio" | "per-request" | "dynamic" | "unknown";
    modelRatio: number | null;
    completionRatio: number | null;
    modelPrice: number | null;
  };
}
export interface ICustomProviderService {
  list(): Promise<ServiceResult<CustomProvider[]>>;
  listSiteModels(
    input: NewApiSiteCatalogQuery,
    signal?: AbortSignal,
  ): Promise<ServiceResult<NewApiSiteModel[]>>;
  create(
    draft: CustomProviderDraft & { operationId: string },
  ): Promise<ServiceResult<CustomProvider>>;
  edit(
    id: string,
    draft: CustomProviderDraft & { expectedRevision: number },
  ): Promise<ServiceResult<CustomProvider>>;
  configureForAccount(
    input: CustomProviderDraft & { accountId: string; expectedRevision: string },
  ): Promise<ServiceResult<CustomProvider>>;
  references(id: string): Promise<ServiceResult<CustomProviderReference[]>>;
  remove(id: string, expectedRevision: number): Promise<ServiceResult<void>>;
  bindAccount(input: BindCustomAccount): Promise<ServiceResult<void>>;
}

function label(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128 || /[\x00-\x1f]/.test(value))
    return fail(key);
  return value.trim();
}
export function providerSlug(value: unknown, field = "providerId"): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) return fail(field);
  return value;
}
function parseSiteBaseUrl(value: unknown): string {
  const site = parseHttpBaseUrl(value, "offerings.siteBaseUrl");
  if (/\/(?:v1|api)$/i.test(site)) return fail("offerings.siteBaseUrl");
  return site;
}
export function parseProviderDraft(value: unknown, previous?: CustomProvider): CustomProviderDraft {
  const v = object(value, "provider");
  const templateKind =
    v.templateKind === undefined ? (previous?.templateKind ?? "generic") : v.templateKind;
  if (
    (templateKind !== "generic" && templateKind !== "new-api") ||
    (previous && templateKind !== previous.templateKind)
  )
    return fail("templateKind");
  const name = label(v.name, "name");
  const policies = v.familyPolicies ?? previous?.familyPolicies ?? {};
  const policyRows = object(policies, "familyPolicies");
  exact(policyRows, [...protocolFamilies], "familyPolicies");
  const familyPolicies = Object.fromEntries(
    Object.entries(policyRows)
      .map(([family, policy]) => [family, parseFamilyPolicy(policy)])
      .filter(([, policy]) => Object.keys(policy).length),
  );
  if (
    v.icon != null &&
    (typeof v.icon !== "string" || v.icon.length > 2048 || /[\x00-\x1f]/.test(v.icon))
  )
    return fail("icon");
  if (!Array.isArray(v.offerings) || !v.offerings.length || v.offerings.length > 64)
    return fail("offerings");
  const offerings = v.offerings.map((row): CustomOffering => {
    const r = object(row, "offering");
    exact(r, ["offeringId", "name", "routes", "siteBaseUrl"], "offering");
    if (templateKind === "generic" && r.siteBaseUrl !== undefined)
      return fail("offerings.siteBaseUrl");
    const offeringId = providerSlug(r.offeringId, "offeringId");
    const site =
      r.siteBaseUrl === undefined
        ? previous?.offerings.find((o) => o.offeringId === offeringId)?.siteBaseUrl
        : r.siteBaseUrl;
    if (!Array.isArray(r.routes) || !r.routes.length || r.routes.length > 64) return fail("routes");
    const prior = previous?.offerings.find((o) => o.offeringId === offeringId);
    const routes = r.routes.map(parseModelRouteInput).map((route) => {
      const existing = prior?.routes.find((old) => old.protocol === route.protocol);
      if (route.requestRule === undefined && existing?.requestRule)
        return { ...route, requestRule: existing.requestRule };
      if (route.requestRule && Object.keys(route.requestRule).length === 1) {
        const { requestRule: _, ...cleared } = route;
        return cleared;
      }
      return route;
    });
    if (new Set(routes.map((x) => x.protocol)).size !== routes.length) return fail("routes");
    assertFamilyRoots(routes);
    return {
      offeringId,
      name: label(r.name, "offering.name"),
      routes,
      ...(templateKind === "new-api" && { siteBaseUrl: parseSiteBaseUrl(site) }),
    };
  });
  if (new Set(offerings.map((x) => x.offeringId)).size !== offerings.length)
    return fail("offerings");
  return {
    name,
    icon: typeof v.icon === "string" && v.icon ? v.icon : null,
    offerings,
    ...(Object.keys(familyPolicies).length && { familyPolicies }),
    // Preserve the canonical creation hash used by pre-template generic providers.
    ...(templateKind === "new-api" && { templateKind }),
  };
}
export function customRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    return fail("expectedRevision");
  return value;
}
export function parseBinding(value: unknown): BindCustomAccount {
  const r = object(value, "binding");
  return {
    accountId: parseAccountId(r.accountId),
    providerId: providerSlug(r.providerId),
    offeringId: r.offeringId === null ? null : providerSlug(r.offeringId, "offeringId"),
    expectedRevision: label(r.expectedRevision, "expectedRevision"),
    ...(r.expectedOfferingId === undefined
      ? {}
      : {
          expectedOfferingId:
            r.expectedOfferingId === ""
              ? ""
              : providerSlug(r.expectedOfferingId, "expectedOfferingId"),
        }),
  };
}
const base = "/api/v1/graph-agent/custom-providers";
const body = <T>(v: T) => v;
type Guarded<T> = CommandContext & T;
export const customProviderOperations = {
  list: apiOperation<void, CustomProvider[]>("GET", base),
  listSiteModels: apiOperation<NewApiSiteCatalogQuery, NewApiSiteModel[]>(
    "GET",
    ({ providerId, offeringId, expectedRevision }) =>
      base +
      "/" +
      providerSlug(providerId) +
      "/offerings/" +
      providerSlug(offeringId, "offeringId") +
      "/catalog?revision=" +
      customRevision(expectedRevision),
  ),
  create: apiOperation<Guarded<CustomProviderDraft & { operationId: string }>, CustomProvider>(
    "POST",
    base + "/create",
    { body },
  ),
  configureForAccount: apiOperation<
    Guarded<CustomProviderDraft & { accountId: string; expectedRevision: string }>,
    CustomProvider
  >("POST", base + "/configure-account-provider", { body }),
  edit: apiOperation<
    Guarded<CustomProviderDraft & { providerId: string; expectedRevision: number }>,
    CustomProvider
  >("POST", base + "/edit", { body }),
  references: apiOperation<{ providerId: string }, CustomProviderReference[]>(
    "GET",
    ({ providerId }) => base + "/" + providerSlug(providerId) + "/references",
  ),
  remove: apiOperation<Guarded<{ providerId: string; expectedRevision: number }>, void>(
    "POST",
    base + "/remove",
    { body },
  ),
  bindAccount: apiOperation<Guarded<BindCustomAccount>, void>("POST", base + "/bind-account", {
    body,
  }),
};
