import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

const product = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  define: { "import.meta.env.VITE_APP_VERSION": JSON.stringify(product.version) },
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue()],
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
  },
});
