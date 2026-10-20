import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const module = new WebAssembly.Module(await readFile("build/guard.wasm"));
const methods = WebAssembly.Module.exports(module).filter((entry) => entry.kind === "function").map((entry) => entry.name).sort();
assert.deepEqual(methods, ["activate_policy", "cancel_policy", "disable_policy", "get_pending_policy", "get_config", "get_policy", "get_spending", "init", "pay", "set_policy"].sort());
console.log("Guard WASM exports verified:", methods.join(", "));
