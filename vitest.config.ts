import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  resolve: {
    // Vitest transforms modules through its SSR pipeline by default. Force
    // Solid's browser build so lifecycle hooks and effects run in jsdom.
    conditions: ["development", "browser"],
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
