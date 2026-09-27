import { inject, type InjectionKey } from "vue";
import type { IPolyQuotaService } from "./polyquota-service";

export const polyQuotaServiceKey: InjectionKey<IPolyQuotaService> = Symbol("polyQuotaService");

export function usePolyQuotaService(): IPolyQuotaService {
  const service = inject(polyQuotaServiceKey);
  if (!service) throw new Error("PolyQuota service was not provided");
  return service;
}
