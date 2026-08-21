import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/main/context-attachments/extraction-worker.ts",
      fileName: () => "extraction-worker.cjs",
      formats: ["cjs"],
    },
    sourcemap: true,
    rollupOptions: {
      output: { codeSplitting: false },
    },
  },
});
