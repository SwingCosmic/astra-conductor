import { HttpPolyQuotaService } from "./services/http-polyquota-service";
import { createApp } from "vue";
import App from "./App.vue";
import { EmptyPolyQuotaService, resolvePolyQuotaService } from "./services/polyquota-service";
import { polyQuotaServiceKey } from "./services/polyquota-service-vue";
import "./styles.css";

const mode = import.meta.env.VITE_POLYQUOTA_MODE;
const polyQuotaService =
  mode === "demo"
    ? new EmptyPolyQuotaService()
    : mode !== "web" && window.polyQuotaElectronService
      ? resolvePolyQuotaService(window.polyQuotaElectronService)
      : new HttpPolyQuotaService(
          import.meta.env.VITE_POLYQUOTA_API_BASE ?? "http://127.0.0.1:4877/api",
        );

createApp(App).provide(polyQuotaServiceKey, polyQuotaService).mount("#app");
