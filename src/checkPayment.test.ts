import { test } from "node:test";
import assert from "node:assert/strict";
import { createPaymentGuard } from "./checkPayment.ts";
import type { Payment, Policy } from "./checkPayment.ts";

const policy: Policy = {
  maxPerPayment: { USDC: 50 },
  dailyLimit: { USDC: 100 },
  knownAddresses: ["alice.near"],
};

test("allows a normal payment", () => {
  const checkPayment = createPaymentGuard(policy);
  assert.equal(checkPayment({ to: "alice.near", amount: 10, token: "USDC" }).allow, true);
});

test("blocks unknown address", () => {
  const checkPayment = createPaymentGuard(policy);
  const d = checkPayment({ to: "mallory.near", amount: 10, token: "USDC" });
  assert.equal(d.allow, false);
});

test("blocks above per-payment cap", () => {
  const checkPayment = createPaymentGuard(policy);
  const d = checkPayment({ to: "alice.near", amount: 60, token: "USDC" });
  assert.equal(d.allow, false);
});

test("blocks above daily limit", () => {
  const checkPayment = createPaymentGuard(policy);
  const d = checkPayment({ to: "alice.near", amount: 40, token: "USDC" }, { USDC: 70 });
  assert.equal(d.allow, false);
});

test("blocks a token with no configured payment or daily limit", () => {
  const checkPayment = createPaymentGuard(policy);
  const d = checkPayment({ to: "alice.near", amount: 1000, token: "UNKNOWN" });
  assert.equal(d.allow, false, "a completely unconfigured token must not bypass spending limits");
});

test("blocks a token with a per-payment cap but no daily limit", () => {
  const incompletePolicy: Policy = { ...policy, dailyLimit: {} };
  const checkPayment = createPaymentGuard(incompletePolicy);
  const d = checkPayment({ to: "alice.near", amount: 50, token: "USDC" });
  assert.equal(d.allow, false, "a token must have both spending limits configured");
  if (!d.allow) assert.equal(d.rule, "unknown_token");
});

test("blocks lowercase usdc above the configured USDC per-payment cap", () => {
  const checkPayment = createPaymentGuard(policy);
  const d = checkPayment({ to: "alice.near", amount: 60, token: "usdc" });
  assert.equal(d.allow, false, "token casing must not bypass the configured USDC cap");
  if (!d.allow) assert.equal(d.rule, "max_per_payment");
});

test("empty caller totals cannot bypass sequential daily spending", () => {
  const check = createPaymentGuard(policy, () => new Date("2026-10-20T12:00:00Z"));
  const payment = { to: "alice.near", amount: 40, token: "USDC" };
  assert.equal(check(payment, {}).allow, true);
  assert.equal(check({ ...payment, token: "usdc" }, {}).allow, true);
  const third = check(payment, {});
  assert.equal(third.allow, false);
  if (!third.allow) assert.equal(third.rule, "daily_limit");
});

test("rejected payments do not consume budget", () => {
  const check = createPaymentGuard(policy);
  for (const payment of [
    { to: "mallory.near", amount: 40, token: "USDC" },
    { to: "alice.near", amount: 60, token: "USDC" },
    { to: "alice.near", amount: 40, token: "UNKNOWN" },
    { to: "alice.near", amount: Infinity, token: "USDC" },
  ]) assert.equal(check(payment).allow, false);
  const payment = { to: "alice.near", amount: 50, token: "USDC" };
  assert.equal(check(payment).allow, true);
  assert.equal(check({ ...payment, amount: 51 }).allow, false);
  assert.equal(check(payment).allow, true);
});

test("ledger rolls over at UTC midnight and separates tokens", () => {
  let time = "2026-10-20T23:59:59.999Z";
  const limits = { ...policy, maxPerPayment: { USDC: 100, NEAR: 100 }, dailyLimit: { USDC: 100, NEAR: 100 } };
  const check = createPaymentGuard(limits, () => new Date(time));
  const payment = { to: "alice.near", amount: 100, token: "USDC" };
  assert.equal(check(payment).allow, true);
  assert.equal(check({ ...payment, token: "near" }).allow, true);
  assert.equal(check({ ...payment, token: "usdc" }).allow, false);
  time = "2026-10-21T01:00:00+01:00";
  assert.equal(check(payment).allow, true);
});

test("concurrently scheduled authorizations share reservations", async () => {
  const check = createPaymentGuard(policy);
  const decisions = await Promise.all(Array.from({ length: 3 }, () => Promise.resolve().then(() =>
    check({ to: "alice.near", amount: 40, token: "USDC" }, {}))));
  assert.deepEqual(decisions.map((d) => d.allow), [true, true, false]);
  const blocked = decisions[2];
  if (!blocked.allow) assert.equal(blocked.rule, "daily_limit");
});

test("agent-supplied looser policy cannot override the trusted cap", () => {
  const check = createPaymentGuard(policy);
  const loosePolicy: Policy = {
    maxPerPayment: { USDC: 1000000 },
    dailyLimit: { USDC: 1000000 },
    knownAddresses: ["alice.near"],
  };
  // Simulate JavaScript or an untyped agent attempting the old policy argument.
  // @ts-expect-error A policy is no longer accepted at payment time.
  const decision = check({ to: "alice.near", amount: 100, token: "USDC" }, loosePolicy);
  assert.equal(decision.allow, false);
  if (!decision.allow) assert.equal(decision.rule, "max_per_payment");
});

test("caller mutations cannot change the bound policy or its nested containers", () => {
  const configured: Policy = {
    maxPerPayment: { USDC: 50 }, dailyLimit: { USDC: 100 },
    knownAddresses: ["alice.near"],
  };
  const addresses = configured.knownAddresses as string[];
  const check = createPaymentGuard(configured);
  configured.maxPerPayment.USDC = 1000000;
  configured.dailyLimit.USDC = 1000000;
  addresses.push("mallory.near");
  configured.maxPerPayment = { USDC: 1000000 };
  configured.dailyLimit = { USDC: 1000000 };
  configured.knownAddresses = ["mallory.near"];
  const payment = { to: "alice.near", amount: 50, token: "USDC" };
  assert.equal(check({ ...payment, amount: 100 }).allow, false);
  assert.equal(check({ ...payment, to: "mallory.near" }).allow, false);
  assert.equal(check(payment).allow, true);
  assert.equal(check(payment).allow, true);
  const exhausted = check({ ...payment, amount: 1 });
  assert.equal(exhausted.allow, false);
  if (!exhausted.allow) assert.equal(exhausted.rule, "daily_limit");
});

test("missing, null, and non-string tokens return bad_input without consuming budget", () => {
  const check = createPaymentGuard(policy);
  const payment = { to: "alice.near", amount: 50 };
  for (const invalid of [payment, ...[undefined, null, 42, {}, [], true, ""].map((token) => ({ ...payment, token }))]) {
    const decision = check(invalid as Payment);
    assert.equal(decision.allow, false);
    if (!decision.allow) assert.equal(decision.rule, "bad_input");
  }
  assert.equal(check({ ...payment, token: "USDC" }).allow, true);
  assert.equal(check({ ...payment, token: "USDC" }).allow, true);
});

test("a daily limit without a payment cap is an unknown token", () => {
  const check = createPaymentGuard({ ...policy, maxPerPayment: {} });
  const decision = check({ to: "alice.near", amount: 1, token: "USDC" });
  assert.equal(decision.allow, false);
  if (!decision.allow) assert.equal(decision.rule, "unknown_token");
});

test("case variants use the strictest payment and daily caps", () => {
  for (const reverse of [false, true]) {
    const caps = { USDC: 50, usdc: 30 };
    const limits = { USDC: 100, usdc: 50 };
    const check = createPaymentGuard({
      ...policy,
      maxPerPayment: reverse ? Object.fromEntries(Object.entries(caps).reverse()) : caps,
      dailyLimit: reverse ? Object.fromEntries(Object.entries(limits).reverse()) : limits,
    });
    const payment = { to: "ALICE.NEAR", amount: 31, token: "UsDc" };
    const aboveCap = check(payment);
    assert.equal(aboveCap.allow, false);
    if (!aboveCap.allow) assert.equal(aboveCap.rule, "max_per_payment");
    assert.equal(check({ ...payment, amount: 30 }).allow, true);
    assert.equal(check({ ...payment, amount: 20, token: "usdc" }).allow, true);
    const exhausted = check({ ...payment, amount: 1 });
    assert.equal(exhausted.allow, false);
    if (!exhausted.allow) assert.equal(exhausted.rule, "daily_limit");
  }
});

test("case-insensitive legacy spending totals can raise but never reset spending", () => {
  const check = createPaymentGuard(policy);
  const payment = { to: "alice.near", amount: 20, token: "UsDc" };
  const rejected = check(payment, { USDC: 50, usdc: 40 });
  assert.equal(rejected.allow, false);
  if (!rejected.allow) assert.equal(rejected.rule, "daily_limit");
  assert.equal(check(payment, { USDC: 30, usdc: 40 }).allow, true);
  const exhausted = check(payment, {});
  assert.equal(exhausted.allow, false);
  if (!exhausted.allow) assert.equal(exhausted.rule, "daily_limit");
});

test("guards have isolated spending ledgers", () => {
  const first = createPaymentGuard(policy);
  const second = createPaymentGuard(policy);
  const payment = { to: "alice.near", amount: 50, token: "USDC" };
  assert.equal(first(payment).allow, true);
  assert.equal(first(payment).allow, true);
  assert.equal(first(payment).allow, false);
  assert.equal(second(payment).allow, true);
});

test("caller-supplied policy cannot loosen the daily cap or address allowlist", () => {
  const check = createPaymentGuard(policy);
  const loose: Policy = {
    maxPerPayment: { USDC: 1000000 }, dailyLimit: { USDC: 1000000 },
    knownAddresses: ["alice.near", "mallory.near"],
  };
  const payment = { to: "alice.near", amount: 50, token: "USDC" };
  assert.equal(check(payment).allow, true);
  assert.equal(check(payment).allow, true);
  // @ts-expect-error Simulate an untyped caller using the removed policy argument.
  const exhausted = check({ ...payment, amount: 1 }, loose);
  assert.equal(exhausted.allow, false);
  if (!exhausted.allow) assert.equal(exhausted.rule, "daily_limit");
  // @ts-expect-error Simulate an untyped caller attempting to replace the allowlist.
  const unknown = check({ ...payment, to: "mallory.near" }, loose);
  assert.equal(unknown.allow, false);
  if (!unknown.allow) assert.equal(unknown.rule, "unknown_address");
});

test("invalid amounts and clocks fail without charging the ledger", () => {
  let date = new Date(NaN);
  const check = createPaymentGuard(policy, () => date);
  const payment = { to: "alice.near", amount: 50, token: "USDC" };
  const invalidClock = check(payment);
  assert.equal(invalidClock.allow, false);
  if (!invalidClock.allow) assert.equal(invalidClock.rule, "bad_input");
  date = new Date("2026-10-20T12:00:00Z");
  for (const amount of [-1, 0, NaN, Infinity, -Infinity]) {
    const decision = check({ ...payment, amount });
    assert.equal(decision.allow, false);
    if (!decision.allow) assert.equal(decision.rule, "bad_input");
  }
  assert.equal(check(payment).allow, true);
  assert.equal(check(payment).allow, true);
});

test("module exports only the trusted guard factory", async () => {
  const exports = await import("./checkPayment.ts");
  assert.deepEqual(Object.keys(exports), ["createPaymentGuard"]);
});
