import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const cargo = spawnSync("cargo", ["--version"], { encoding: "utf8" });
if (cargo.error?.code === "ENOENT") {
  console.error([
    "Rust/Cargo wurde nicht gefunden.",
    "Installiere auf macOS zuerst die Command Line Tools und Rust:",
    "  xcode-select --install",
    "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
    '  source "$HOME/.cargo/env"',
  ].join("\n"));
  process.exit(1);
}
if (cargo.status !== 0) {
  process.stderr.write(cargo.stderr || "Cargo konnte nicht gestartet werden.\n");
  process.exit(cargo.status ?? 1);
}

const require = createRequire(import.meta.url);
const cli = require.resolve("@tauri-apps/cli/tauri.js");
const childEnv = { ...process.env };
if (process.platform === "darwin") {
  for (const name of ["LANG", "LC_ALL", "LC_CTYPE"]) {
    if (childEnv[name]?.toUpperCase() === "C.UTF-8") {
      childEnv[name] = "en_US.UTF-8";
    }
  }
}
if (process.argv.includes("--ci")) {
  childEnv.CI = "true";
}
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: childEnv,
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
