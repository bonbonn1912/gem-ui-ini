import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "src/renderer",
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(
      new URL("./.vite/renderer/main_window", import.meta.url),
    ),
    sourcemap: true,
  },
});
