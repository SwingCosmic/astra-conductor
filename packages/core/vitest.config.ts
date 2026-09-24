import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@omniroute/open-sse": fileURLToPath(
        new URL("./src/vendor/omniroute/open-sse", import.meta.url),
      ),
      "@omniroute/src": fileURLToPath(new URL("./src/vendor/omniroute/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
