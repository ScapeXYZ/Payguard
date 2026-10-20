import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPayment } from "./checkPayment.ts";
import type { Policy } from "./checkPayment.ts";

const policy: Policy = {
  maxPerPayment: { USDC: 50 },
  dailyLimit: { USDC: 100 },
  knownAddresses: ["alice.near"],
};

test("allows a normal payment", () => {
  assert.equal(checkPayment({ to: "alice.near", amount: 10, token: "USDC" }, policy).allow, true);
});

test("blocks unknown address", () => {
  const d = checkPayment({ to: "mallory.near", amount: 10, token: "USDC" }, policy);
  assert.equal(d.allow, false);
});

test("blocks above per-payment cap", () => {
  const d = checkPayment({ to: "alice.near", amount: 60, token: "USDC" }, policy);
  assert.equal(d.allow, false);
});

test("blocks above daily limit", () => {
  const d = checkPayment({ to: "alice.near", amount: 40, token: "USDC" }, policy, { USDC: 70 });
  assert.equal(d.allow, false);
});

test("blocks a token with no configured payment or daily limit", () => {
  const d = checkPayment({ to: "alice.near", amount: 1000, token: "UNKNOWN" }, policy);
  assert.equal(d.allow, false, "a completely unconfigured token must not bypass spending limits");
});

// TODO(temi): break it. negative/NaN amounts, case tricks on addresses, token spoofing, splitting one big payment into many small ones.
