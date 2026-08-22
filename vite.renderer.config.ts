import solid from "vite-plugin-solid";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "frontend/renderer",
  plugins: [solid()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./frontend/shared", import.meta.url)),
      "@renderer": fileURLToPath(new URL("./frontend/renderer", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
});
