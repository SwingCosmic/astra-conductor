import { EmptyPolyQuotaService, type IPolyQuotaService } from "./polyquota-service";
import { HttpPolyQuotaService } from "./http-polyquota-service";

/** Entry configuration is explicit; an unavailable backend never selects demo data. */
export function createServices(mode?: string, apiBase?: string) {
  if (mode === "demo")
    return { service: new EmptyPolyQuotaService() as IPolyQuotaService, host: null };
  const client = new HttpPolyQuotaService(
    mode === "web" ? (apiBase ?? "http://127.0.0.1:4877/api") : "polyquota-app://app",
  );
  return { service: client as IPolyQuotaService, host: client };
}
