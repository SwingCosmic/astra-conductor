import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
const backend = process.env.GRAPH_AGENT_DEV_SERVER ?? "http://127.0.0.1:4878";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [vue()],
  define: { "import.meta.env.VITE_APP_VERSION": JSON.stringify(version) },
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: {
      "/api": {
        target: backend,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (request) => {
            if (request.hasHeader("origin")) request.setHeader("origin", new URL(backend).origin);
          });
        },
      },
    },
  },
});
