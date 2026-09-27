import { createApp } from "vue";
import App from "./App.vue";
import { resolvePolyQuotaService } from "./services/polyquota-service";
import { polyQuotaServiceKey } from "./services/polyquota-service-vue";
import "./styles.css";

const polyQuotaService = resolvePolyQuotaService(window.polyQuotaElectronService);

createApp(App).provide(polyQuotaServiceKey, polyQuotaService).mount("#app");
