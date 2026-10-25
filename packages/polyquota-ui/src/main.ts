import { createServices } from "./services/create-services";
import { hostServiceKey } from "./services/host-service-vue";
import { createApp } from "vue";
import App from "./App.vue";
import { polyQuotaServiceKey } from "./services/polyquota-service-vue";
import "./styles.css";

const { service, host } = createServices(
  import.meta.env.VITE_POLYQUOTA_MODE,
  import.meta.env.VITE_POLYQUOTA_API_BASE,
);
const app = createApp(App).provide(polyQuotaServiceKey, service);
if (host) app.provide(hostServiceKey, host);
app.mount("#app");
