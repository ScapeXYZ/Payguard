import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// near-sdk-js 2's preinstall enforces pnpm. Keep the repository's npm workflow:
// install with --ignore-scripts, then explicitly run these pinned tool installers.
const sdk = "node_modules/near-sdk-js";
const dependencies = ["qjsc", "quickjs/quickjs.c", "wasi-sdk/bin/clang", "binaryen/wasi-stub/run.sh"];
if (!dependencies.every((file) => existsSync(`${sdk}/lib/cli/deps/${file}`))) {
  const result = spawnSync(process.execPath, ["lib/cli/post-install.js"], { cwd: sdk, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const result = spawnSync(process.execPath, ["node_modules/near-sandbox/install.js"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
