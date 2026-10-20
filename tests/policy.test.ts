import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialize, setPolicy, reserve, getSpending, getPolicy, dayAt, accountId,
  DAY_NS, U128_MAX, MIN_PAY_GAS, MAX_PAY_GAS, type Host, type Payment,
} from "../contract/policy.ts";

function fixture() {
  let caller = "owner.test.near";
  let now = 20000n * DAY_NS;
  let deposit = 0n;
  let gas = MIN_PAY_GAS;
  let storage = new Map<string, string>();
  const host: Host = {
    predecessor: () => caller, currentAccount: () => "guard.test.near",
    attachedDeposit: () => deposit, prepaidGas: () => gas, timestamp: () => now,
    read: (key) => storage.get(key) ?? null, write: (key, value) => { storage.set(key, value); },
  };
  const config = initialize(host, caller, "agent.test.near");
  const policy = {
    token_id: "usdc.test.near", max_per_payment: "50000000", daily_limit: "100000000",
    recipients: ["alice.test.near"],
  };
  setPolicy(host, config, policy);
  caller = config.agent_id;
  const payment = { token_id: policy.token_id, recipient_id: policy.recipients[0], amount: "40000000" };
  let sequence = 0;
  return {
    host, config, policy, payment,
    caller: (value: string) => { caller = value; },
    time: (value: bigint) => { now = value; },
    deposit: (value: bigint) => { deposit = value; },
    gas: (value: bigint) => { gas = value; },
    // Model independent receipt hosts against persisted storage, with rollback on panic.
    tx(input: Omit<Payment, "request_id"> & { request_id?: string } = payment) {
      const before = new Map(storage);
      try { return reserve({ ...host }, { ...config }, { request_id: "unit-" + ++sequence, ...input } as Payment); }
      catch (error) { storage = before; throw error; }
    },
    reload: () => { storage = new Map(JSON.parse(JSON.stringify([...storage]))); },
    spent: () => getSpending(host, policy.token_id, dayAt(host)),
  };
}

test("three independent reservations persist 40 + 40 and reject third 40 USDC", () => {
  const f = fixture();
  f.tx(); f.reload();
  f.tx({ ...f.payment, token_id: "USDC.TEST.NEAR" }); f.reload();
  assert.throws(() => f.tx(), /daily_limit/);
  assert.equal(f.spent(), "80000000");
});

test("only configured predecessor agent can reserve (owner cannot pay either)", () => {
  const f = fixture();
  for (const caller of [f.config.owner_id, "mallory.test.near", "guard.test.near"]) {
    f.caller(caller);
    assert.throws(() => f.tx(), /agent_only/);
  }
  assert.equal(f.spent(), "0");
});

test("owner-only policy changes; reconfiguration and token casing cannot reset spending", () => {
  const f = fixture(); f.tx();
  for (const caller of [f.config.agent_id, "mallory.test.near"]) {
    f.caller(caller);
    assert.throws(() => setPolicy(f.host, f.config, { ...f.policy, daily_limit: "999999999" }), /owner_only/);
  }
  f.caller(f.config.owner_id);
  setPolicy(f.host, f.config, { ...f.policy, token_id: "USDC.TEST.NEAR" });
  assert.equal(f.spent(), "40000000");
  setPolicy(f.host, f.config, { ...f.policy, max_per_payment: "10", daily_limit: "10" });
  f.caller(f.config.agent_id);
  assert.throws(() => f.tx({ ...f.payment, amount: "1" }), /daily_limit/);
});

test("missing, malformed, unknown tokens and unapproved recipients do not spend", () => {
  const f = fixture();
  for (const token_id of [undefined, null, 4, "", " usdc.test.near", "a..near", "usdc:near"]) {
    assert.throws(() => f.tx({ ...f.payment, token_id } as Payment), /bad_account_id/);
  }
  assert.throws(() => f.tx({ ...f.payment, token_id: "unknown.near" }), /unknown_token/);
  assert.throws(() => f.tx({ ...f.payment, recipient_id: "mallory.near" }), /unapproved_recipient/);
  assert.equal(f.spent(), "0");
});

test("strict integer u128 amounts and per-payment overflow", () => {
  const f = fixture();
  for (const value of [undefined, null, 40, 0, "0", "-1", "1.5", "01", "1e6", "Infinity", " 40", "40\n", "9".repeat(40)]) {
    assert.throws(() => f.tx({ ...f.payment, amount: value } as Payment), /bad_amount/);
  }
  assert.throws(() => f.tx({ ...f.payment, amount: (U128_MAX + 1n).toString() }), /amount_overflow/);
  assert.throws(() => f.tx({ ...f.payment, amount: "50000001" }), /max_per_payment/);
  assert.equal(f.spent(), "0");
});

test("integer arithmetic remains exact beyond JavaScript safe integers and at u128 maximum", () => {
  const f = fixture(); f.caller(f.config.owner_id);
  setPolicy(f.host, f.config, { ...f.policy, max_per_payment: U128_MAX.toString(), daily_limit: U128_MAX.toString() });
  f.caller(f.config.agent_id);
  const big = 9007199254740993n;
  f.tx({ ...f.payment, amount: big.toString() });
  f.tx({ ...f.payment, amount: (U128_MAX - big).toString() });
  assert.equal(f.spent(), U128_MAX.toString());
  assert.throws(() => f.tx({ ...f.payment, amount: "1" }), /daily_limit/);
});

test("UTC midnight creates new bucket; historical days and tokens remain isolated", () => {
  const f = fixture();
  f.time(20001n * DAY_NS - 1n); f.tx();
  f.caller(f.config.owner_id);
  setPolicy(f.host, f.config, { ...f.policy, token_id: "other.test.near" });
  f.caller(f.config.agent_id);
  f.tx({ ...f.payment, token_id: "other.test.near" });
  assert.equal(f.spent(), "40000000");
  f.time(20001n * DAY_NS);
  assert.equal(f.spent(), "0"); f.tx();
  assert.equal(getSpending(f.host, f.policy.token_id, "20000"), "40000000");
  assert.equal(getSpending(f.host, "other.test.near", "20000"), "40000000");
});

test("failed asynchronous execution never releases committed reservation", () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const transfer = f.tx(); f.reload();
    // Separate downstream receipt: failure cannot roll back the prior receipt.
    assert.throws(() => { throw new Error(`ft_transfer failed: ${transfer.amount}`); }, /ft_transfer failed/);
  }
  assert.equal(f.spent(), "80000000");
  assert.throws(() => f.tx(), /daily_limit/);
});

test("zero deposit and bounded prepaid gas are mandatory", () => {
  const f = fixture(); f.deposit(1n);
  assert.throws(() => f.tx(), /zero_deposit_required/);
  f.deposit(0n);
  for (const gas of [MIN_PAY_GAS - 1n, MAX_PAY_GAS + 1n]) {
    f.gas(gas); assert.throws(() => f.tx(), /pay_gas_out_of_range/);
  }
  assert.equal(f.spent(), "0");
});

test("trusted initialization requires distinct owner, agent, guard and authentic owner", () => {
  const f = fixture();
  assert.throws(() => initialize(f.host, f.config.owner_id, f.config.agent_id), /owner_only/);
  f.caller(f.config.owner_id);
  assert.throws(() => initialize(f.host, f.config.owner_id, f.config.owner_id), /separate_agent_required/);
  assert.throws(() => initialize(f.host, f.config.owner_id, "guard.test.near"), /separate_agent_required/);
});

test("policy validation is complete before write, and empty recipients pause payments", () => {
  const f = fixture(); f.caller(f.config.owner_id);
  for (const update of [
    { max_per_payment: "100000001" }, { daily_limit: "0" },
    { max_per_payment: undefined }, { daily_limit: undefined },
    { recipients: ["bad..near"] }, { recipients: ["guard.test.near"] },
    { token_id: "guard.test.near" },
  ]) assert.throws(() => setPolicy(f.host, f.config, { ...f.policy, ...update }));
  assert.deepEqual(getPolicy(f.host, f.policy.token_id), {
    max_per_payment: f.policy.max_per_payment, daily_limit: f.policy.daily_limit, recipients: f.policy.recipients,
  });
  setPolicy(f.host, f.config, { ...f.policy, recipients: [] });
  f.caller(f.config.agent_id);
  assert.throws(() => f.tx(), /unapproved_recipient/);
});

test("normalization validates canonical token account IDs without symbol aliases", () => {
  assert.equal(accountId("USDC.TEST.NEAR"), "usdc.test.near");
  for (const id of ["a", "a_-.near", ".near", "a.near.", "K.near", "alice.near\n", "a".repeat(65)]) {
    assert.throws(() => accountId(id), /bad_account_id/);
  }
});

test("request IDs persist across reload, policy changes, payload changes and UTC days", () => {
  const f = fixture();
  const payment = { ...f.payment, request_id: "invoice-1" };
  f.tx(payment); f.reload();
  assert.throws(() => f.tx(payment), /duplicate_request/);
  assert.throws(() => f.tx({ ...payment, amount: "1" }), /duplicate_request/);
  assert.equal(f.spent(), "40000000");
  f.caller(f.config.owner_id); setPolicy(f.host, f.config, f.policy);
  f.caller(f.config.agent_id); f.time(20001n * DAY_NS);
  assert.throws(() => f.tx(payment), /duplicate_request/);
  assert.equal(f.spent(), "0");
  f.tx({ ...payment, request_id: "invoice-2" });
  assert.equal(f.spent(), "40000000");
});

test("invalid and rejected request IDs cannot reserve budget or poison a valid retry", () => {
  const f = fixture();
  for (const id of [undefined, null, 1, "", "a".repeat(65), "a:b", "invoice 1", "invoice\n"]) {
    assert.throws(() => f.tx({ ...f.payment, request_id: id } as Payment), /bad_request_id/);
  }
  const payment = { ...f.payment, request_id: "retry-valid" };
  assert.throws(() => f.tx({ ...payment, amount: "50000001" }), /max_per_payment/);
  f.tx(payment);
  assert.equal(f.spent(), "40000000");
});

test("UTC day lookup rejects trailing newline instead of reading a noncanonical key", () => {
  const f = fixture();
  assert.throws(() => getSpending(f.host, f.policy.token_id, "20000\n"), /bad_day/);
});
