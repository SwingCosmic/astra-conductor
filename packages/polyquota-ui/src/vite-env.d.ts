/// <reference types="vite/client" />

import type { IPolyQuotaService } from "./services/polyquota-service";

declare global {
  interface Window {
    polyQuotaElectronService?: IPolyQuotaService;
  }
}
