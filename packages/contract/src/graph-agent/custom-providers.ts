import {
  apiOperation,
  parseModelRouteInput,
  type ModelRouteInput,
  type CommandContext,
  type ServiceResult,
} from "../common/index.js";
import { object, exact, fail, parseAccountId } from "../common/validation/request.js";

export interface CustomOffering {
  offeringId: string;
  name: string;
  routes: ModelRouteInput[];
}
export interface CustomProviderDraft {
  name: string;
  icon: string | null;
  offerings: CustomOffering[];
}
export interface CustomProvider extends CustomProviderDraft {
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
export interface ICustomProviderService {
  list(): Promise<ServiceResult<CustomProvider[]>>;
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
export function parseProviderDraft(value: unknown): CustomProviderDraft {
  const v = object(value, "provider");
  const name = label(v.name, "name");
  if (
    v.icon != null &&
    (typeof v.icon !== "string" || v.icon.length > 2048 || /[\x00-\x1f]/.test(v.icon))
  )
    return fail("icon");
  if (!Array.isArray(v.offerings) || !v.offerings.length || v.offerings.length > 64)
    return fail("offerings");
  const offerings = v.offerings.map((row): CustomOffering => {
    const r = object(row, "offering");
    exact(r, ["offeringId", "name", "routes"], "offering");
    if (!Array.isArray(r.routes) || !r.routes.length || r.routes.length > 64) return fail("routes");
    const routes = r.routes.map(parseModelRouteInput);
    if (new Set(routes.map((x) => x.protocolRouteId)).size !== routes.length) return fail("routes");
    return {
      offeringId: providerSlug(r.offeringId, "offeringId"),
      name: label(r.name, "offering.name"),
      routes,
    };
  });
  if (new Set(offerings.map((x) => x.offeringId)).size !== offerings.length)
    return fail("offerings");
  return { name, icon: typeof v.icon === "string" && v.icon ? v.icon : null, offerings };
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
