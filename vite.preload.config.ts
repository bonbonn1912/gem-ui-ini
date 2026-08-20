import { defineConfig } from "vite";

export default defineConfig({
  build: {
    sourcemap: true,
    rollupOptions: {
      input: {
        preload: "src/preload/index.ts",
      },
      output: {
        entryFileNames: "[name].cjs",
      },
    },
  },
});
