import { test } from "node:test";
import assert from "node:assert/strict";
import { createPaymentGuard } from "./checkPayment.ts";
import type { Policy } from "./checkPayment.ts";

const policy: Policy = {
  maxPerPayment: { USDC: 50 },
  dailyLimit: { USDC: 100 },
  knownAddresses: ["alice.near"],
};

test("allows a normal payment", () => {
  const checkPayment = createPaymentGuard();
  assert.equal(checkPayment({ to: "alice.near", amount: 10, token: "USDC" }, policy).allow, true);
});

test("blocks unknown address", () => {
  const checkPayment = createPaymentGuard();
  const d = checkPayment({ to: "mallory.near", amount: 10, token: "USDC" }, policy);
  assert.equal(d.allow, false);
});

test("blocks above per-payment cap", () => {
  const checkPayment = createPaymentGuard();
  const d = checkPayment({ to: "alice.near", amount: 60, token: "USDC" }, policy);
  assert.equal(d.allow, false);
});

test("blocks above daily limit", () => {
  const checkPayment = createPaymentGuard();
  const d = checkPayment({ to: "alice.near", amount: 40, token: "USDC" }, policy, { USDC: 70 });
  assert.equal(d.allow, false);
});

test("blocks a token with no configured payment or daily limit", () => {
  const checkPayment = createPaymentGuard();
  const d = checkPayment({ to: "alice.near", amount: 1000, token: "UNKNOWN" }, policy);
  assert.equal(d.allow, false, "a completely unconfigured token must not bypass spending limits");
});

test("blocks a token with a per-payment cap but no daily limit", () => {
  const checkPayment = createPaymentGuard();
  const incompletePolicy: Policy = { ...policy, dailyLimit: {} };
  const d = checkPayment({ to: "alice.near", amount: 50, token: "USDC" }, incompletePolicy);
  assert.equal(d.allow, false, "a token must have both spending limits configured");
  if (!d.allow) assert.equal(d.rule, "unknown_token");
});

test("blocks lowercase usdc above the configured USDC per-payment cap", () => {
  const checkPayment = createPaymentGuard();
  const d = checkPayment({ to: "alice.near", amount: 60, token: "usdc" }, policy);
  assert.equal(d.allow, false, "token casing must not bypass the configured USDC cap");
  if (!d.allow) assert.equal(d.rule, "max_per_payment");
});

// TODO(temi): break it. negative/NaN amounts, case tricks on addresses, token spoofing, splitting one big payment into many small ones.

test("empty caller totals cannot bypass sequential daily spending", () => {
  const check = createPaymentGuard(() => new Date("2026-10-20T12:00:00Z"));
  const payment = { to: "alice.near", amount: 40, token: "USDC" };
  assert.equal(check(payment, policy, {}).allow, true);
  assert.equal(check({ ...payment, token: "usdc" }, policy, {}).allow, true);
  const third = check(payment, policy, {});
  assert.equal(third.allow, false);
  if (!third.allow) assert.equal(third.rule, "daily_limit");
});

test("rejected payments do not consume budget", () => {
  const check = createPaymentGuard();
  for (const payment of [
    { to: "mallory.near", amount: 40, token: "USDC" },
    { to: "alice.near", amount: 60, token: "USDC" },
    { to: "alice.near", amount: 40, token: "UNKNOWN" },
    { to: "alice.near", amount: Infinity, token: "USDC" },
  ]) assert.equal(check(payment, policy).allow, false);
  const payment = { to: "alice.near", amount: 50, token: "USDC" };
  assert.equal(check(payment, policy).allow, true);
  assert.equal(check({ ...payment, amount: 51 }, { ...policy, maxPerPayment: { USDC: 100 } }).allow, false);
  assert.equal(check(payment, policy).allow, true);
});

test("ledger rolls over at UTC midnight and separates tokens", () => {
  let time = "2026-10-20T23:59:59.999Z";
  const check = createPaymentGuard(() => new Date(time));
  const limits = { ...policy, maxPerPayment: { USDC: 100, NEAR: 100 }, dailyLimit: { USDC: 100, NEAR: 100 } };
  const payment = { to: "alice.near", amount: 100, token: "USDC" };
  assert.equal(check(payment, limits).allow, true);
  assert.equal(check({ ...payment, token: "near" }, limits).allow, true);
  assert.equal(check({ ...payment, token: "usdc" }, limits).allow, false);
  time = "2026-10-21T01:00:00+01:00";
  assert.equal(check(payment, limits).allow, true);
});

test("concurrently scheduled authorizations share reservations", async () => {
  const check = createPaymentGuard();
  const decisions = await Promise.all(Array.from({ length: 3 }, () => Promise.resolve().then(() =>
    check({ to: "alice.near", amount: 40, token: "USDC" }, policy, {}))));
  assert.deepEqual(decisions.map((d) => d.allow), [true, true, false]);
  const blocked = decisions[2];
  if (!blocked.allow) assert.equal(blocked.rule, "daily_limit");
});
