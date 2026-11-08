import { createApp } from "vue";
import {
  credentialServiceKey,
  providerServiceKey,
  providerUiOptionsKey,
} from "@astra-conductor/shared-ui";
import "@astra-conductor/shared-ui/styles.css";
import App from "./App.vue";
import { createGraphAgentService } from "./services/graph-agent-service.js";

const service = createGraphAgentService();
const app = createApp(App);
app.provide(providerServiceKey, service.providers);
app.provide(credentialServiceKey, service.credentials);
app.provide(providerUiOptionsKey, { sessionPrefix: "graphagent" });
app.mount("#app");
window.addEventListener(
  "beforeunload",
  () => {
    app.unmount();
    service.dispose();
  },
  { once: true },
);
