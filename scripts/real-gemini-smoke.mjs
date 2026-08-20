import { spawn } from "node:child_process";
import path from "node:path";

const vitestEntry = path.resolve("node_modules/vitest/vitest.mjs");
const child = spawn(
  process.execPath,
  [vitestEntry, "run", "tests/smoke/real-gemini.test.ts"],
  {
    env: { ...process.env, REAL_GEMINI_SMOKE: "1" },
    stdio: "inherit",
    shell: false,
  },
);

child.once("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  if (signal) {
    console.error(`Gemini smoke test ended with ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
