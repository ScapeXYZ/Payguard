import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getRecoveryCooldown, RECOVERY_COOLDOWN_NS, proposeOwnerRecovery, cancelOwnerRecovery, activateOwnerRecovery, getPendingOwnerRecovery, proposeGuardianChange, cancelGuardianChange, activateGuardianChange, getPendingGuardianChange,
  initialize, setPolicy, activatePolicy, getPendingPolicy, disablePolicy, cancelPolicy, POLICY_DELAY_NS, reserve, getSpending, getPolicy, dayAt, accountId,
  DAY_NS, U128_MAX, MIN_PAY_GAS, MAX_PAY_GAS, type Host, type Payment,
} from "../contract/policy.ts";

function fixture() {
  let caller = "owner.test.near";
  let now = 19999n * DAY_NS;
  let deposit = 0n;
  let gas = MIN_PAY_GAS;
  let storage = new Map<string, string>();
  const host: Host = {
    predecessor: () => caller, currentAccount: () => "guard.test.near",
    attachedDeposit: () => deposit, prepaidGas: () => gas, timestamp: () => now,
    read: (key) => storage.get(key) ?? null, write: (key, value) => { storage.set(key, value); },
  };
  const config = initialize(host, caller, "agent.test.near", "guardian.test.near");
  const policy = {
    token_id: "usdc.test.near", max_per_payment: "50000000", daily_limit: "100000000",
    recipients: ["alice.test.near"],
  };
  setPolicy(host, config, policy);
  now += POLICY_DELAY_NS;
  activatePolicy(host, getPendingPolicy(host)!.proposal_id);
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
    snapshot: () => [...storage.entries()].sort(),
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
  f.time(20001n * DAY_NS);
  activatePolicy(f.host, getPendingPolicy(f.host)!.proposal_id);
  f.caller(f.config.agent_id);
  const big = 9007199254740993n;
  f.tx({ ...f.payment, amount: big.toString() });
  f.tx({ ...f.payment, amount: (U128_MAX - big).toString() });
  assert.equal(f.spent(), U128_MAX.toString());
  assert.throws(() => f.tx({ ...f.payment, amount: "1" }), /daily_limit/);
});

test("UTC midnight creates new bucket; historical days and tokens remain isolated", () => {
  const f = fixture();
  f.caller(f.config.owner_id);
  f.time(19999n * DAY_NS);
  setPolicy(f.host, f.config, { ...f.policy, token_id: "other.test.near" });
  f.time(20000n * DAY_NS);
  activatePolicy(f.host, getPendingPolicy(f.host)!.proposal_id);
  f.caller(f.config.agent_id);
  f.time(20001n * DAY_NS - 1n); f.tx();
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
  assert.throws(() => initialize(f.host, f.config.owner_id, f.config.agent_id, "guardian.test.near"), /owner_only/);
  f.caller(f.config.owner_id);
  assert.throws(() => initialize(f.host, f.config.owner_id, f.config.owner_id, "guardian.test.near"), /separate_agent_required/);
  assert.throws(() => initialize(f.host, f.config.owner_id, "guard.test.near", "guardian.test.near"), /separate_agent_required/);
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


test("cap raise persists pending, rejects payment and activation until exact trusted deadline", () => {
  const f = fixture(); f.tx(); f.caller(f.config.owner_id);
  setPolicy(f.host, f.config, { ...f.policy, max_per_payment: "60000000" });
  const pending = getPendingPolicy(f.host)!;
  assert.equal(pending.activate_after, (20000n * DAY_NS + POLICY_DELAY_NS).toString());
  f.reload(); f.caller(f.config.agent_id);
  assert.throws(() => f.tx({ ...f.payment, amount: "60000000" }), /max_per_payment/);
  f.time(BigInt(pending.activate_after) - 1n);
  assert.throws(() => activatePolicy(f.host, pending.proposal_id), /policy_timelocked/);
  assert.equal(getSpending(f.host, f.policy.token_id, "20000"), "40000000");
  f.time(BigInt(pending.activate_after)); f.caller("stranger.near");
  assert.throws(() => activatePolicy(f.host, "wrong"), /proposal_id_mismatch/);
  activatePolicy(f.host, pending.proposal_id);
  assert.equal(getPendingPolicy(f.host), null);
  assert.throws(() => activatePolicy(f.host, pending.proposal_id), /no_pending_policy/);
  f.caller(f.config.agent_id); f.tx({ ...f.payment, amount: "60000000" });
  assert.equal(getSpending(f.host, f.policy.token_id, "20000"), "40000000");
});

test("mixed updates apply intersection immediately; queued policies cannot overwrite tightening", () => {
  const f = fixture(); f.caller(f.config.owner_id);
  setPolicy(f.host, f.config, { ...f.policy, max_per_payment: "60000000", daily_limit: "80000000",
    recipients: ["bob.near"] });
  const first = getPendingPolicy(f.host)!;
  assert.deepEqual(getPolicy(f.host, f.policy.token_id), {
    max_per_payment: "50000000", daily_limit: "80000000", recipients: [],
  });
  assert.throws(() => setPolicy(f.host, f.config, f.policy), /pending_policy_exists/);
  assert.throws(() => setPolicy(f.host, f.config, { ...f.policy, token_id: "other.near" }), /pending_policy_exists/);
  setPolicy(f.host, f.config, { ...f.policy, max_per_payment: "10", daily_limit: "20", recipients: [] });
  f.time(BigInt(first.activate_after));
  assert.throws(() => activatePolicy(f.host, first.proposal_id), /no_pending_policy/);
  setPolicy(f.host, f.config, f.policy);
  const second = getPendingPolicy(f.host)!;
  assert.notEqual(first.proposal_id, second.proposal_id);
  assert.throws(() => activatePolicy(f.host, first.proposal_id), /proposal_id_mismatch/);
  assert.throws(() => activatePolicy(f.host, second.proposal_id), /policy_timelocked/);
});

test("disable, re-enable, recipient additions and cancellations cannot bypass delay or erase spending", () => {
  const f = fixture(); f.tx(); f.caller(f.config.owner_id);
  setPolicy(f.host, f.config, { ...f.policy, recipients: [...f.policy.recipients, "bob.near"] });
  assert.deepEqual(getPolicy(f.host, f.policy.token_id)!.recipients, f.policy.recipients);
  const pending = getPendingPolicy(f.host)!;
  disablePolicy(f.host, f.config, f.policy.token_id.toUpperCase());
  assert.equal(getPolicy(f.host, f.policy.token_id), null);
  assert.equal(f.spent(), "40000000");
  setPolicy(f.host, f.config, f.policy);
  assert.equal(getPolicy(f.host, f.policy.token_id), null);
  assert.throws(() => activatePolicy(f.host, pending.proposal_id), /proposal_id_mismatch/);
  const next = getPendingPolicy(f.host)!;
  f.caller(f.config.agent_id);
  assert.throws(() => f.tx(), /unknown_token/);
  assert.throws(() => cancelPolicy(f.host, f.config), /owner_or_guardian_only/);
  assert.throws(() => disablePolicy(f.host, f.config, f.policy.token_id), /owner_only/);
  f.caller(f.config.owner_id); cancelPolicy(f.host, f.config);
  f.time(BigInt(next.activate_after));
  assert.throws(() => activatePolicy(f.host, next.proposal_id), /no_pending_policy/);
  assert.equal(getSpending(f.host, f.policy.token_id, "20000"), "40000000");
});

test("partial policies reject; empty recipients tighten; public administration requires zero deposit", () => {
  const f = fixture(); f.caller(f.config.owner_id);
  assert.throws(() => setPolicy(f.host, f.config, { token_id: f.policy.token_id } as any), /bad_amount/);
  setPolicy(f.host, f.config, { ...f.policy, recipients: [] });
  assert.equal(getPendingPolicy(f.host), null);
  setPolicy(f.host, f.config, f.policy);
  const pending = getPendingPolicy(f.host)!;
  f.time(BigInt(pending.activate_after)); f.deposit(1n);
  assert.throws(() => activatePolicy(f.host, pending.proposal_id), /zero_deposit_required/);
  assert.throws(() => cancelPolicy(f.host, f.config), /zero_deposit_required/);
  assert.throws(() => disablePolicy(f.host, f.config, f.policy.token_id), /zero_deposit_required/);
  assert.throws(() => setPolicy(f.host, f.config, f.policy), /zero_deposit_required/);
});

test("comparison delays daily raises and recipient additions, including empty-token enablement", () => {
  for (const update of [
    { daily_limit: "200000000" },
    { recipients: ["alice.test.near", "bob.near"] },
    { max_per_payment: "10", recipients: ["bob.near"] },
    { token_id: "new.near", recipients: [] },
  ]) {
    const f = fixture(); f.caller(f.config.owner_id);
    setPolicy(f.host, f.config, { ...f.policy, ...update });
    assert.ok(getPendingPolicy(f.host));
  }
  const f = fixture(); f.caller(f.config.owner_id);
  setPolicy(f.host, f.config, { ...f.policy, recipients: ["ALICE.TEST.NEAR", "alice.test.near"] });
  assert.equal(getPendingPolicy(f.host), null);
});

test("activation preserves spending already recorded on activation day and replay markers", () => {
  const f = fixture(); f.caller(f.config.owner_id);
  f.time(20000n * DAY_NS + DAY_NS / 2n);
  setPolicy(f.host, f.config, { ...f.policy, max_per_payment: "60000000" });
  const pending = getPendingPolicy(f.host)!;
  f.time(20001n * DAY_NS); f.caller(f.config.agent_id);
  f.tx({ ...f.payment, request_id: "before-activation" });
  f.time(BigInt(pending.activate_after));
  activatePolicy(f.host, pending.proposal_id);
  assert.equal(f.spent(), "40000000");
  assert.throws(() => f.tx({ ...f.payment, request_id: "before-activation" }), /duplicate_request/);
  f.tx({ ...f.payment, amount: "60000000" });
  assert.equal(f.spent(), "100000000");
  assert.throws(() => f.tx({ ...f.payment, amount: "1" }), /daily_limit/);
});

test("cross-token tightening cancels pending enablement; re-proposal restarts the full delay", () => {
  const f = fixture(); f.caller(f.config.owner_id);
  const target = { ...f.policy, token_id: "new.near" };
  setPolicy(f.host, f.config, target);
  const first = getPendingPolicy(f.host)!;
  assert.equal(getPolicy(f.host, target.token_id), null);
  f.time(BigInt(first.activate_after) - 1n);
  assert.throws(() => activatePolicy(f.host, first.proposal_id), /policy_timelocked/);
  // A restriction on another token must invalidate the global proposal too.
  setPolicy(f.host, f.config, { ...f.policy, max_per_payment: "1" });
  assert.equal(getPendingPolicy(f.host), null);
  setPolicy(f.host, f.config, target);
  const second = getPendingPolicy(f.host)!;
  assert.equal(BigInt(second.activate_after), BigInt(first.activate_after) - 1n + POLICY_DELAY_NS);
  assert.ok(BigInt(second.proposal_id) > BigInt(first.proposal_id));
  f.reload(); f.time(BigInt(first.activate_after));
  assert.throws(() => activatePolicy(f.host, first.proposal_id), /proposal_id_mismatch/);
  assert.throws(() => activatePolicy(f.host, second.proposal_id), /policy_timelocked/);
  assert.equal(getPolicy(f.host, target.token_id), null);
  f.time(BigInt(second.activate_after));
  activatePolicy(f.host, second.proposal_id);
  assert.equal(getPolicy(f.host, f.policy.token_id)!.max_per_payment, "1");
  assert.deepEqual(getPolicy(f.host, target.token_id), {
    max_per_payment: target.max_per_payment, daily_limit: target.daily_limit, recipients: target.recipients,
  });
});


test("guardian veto leaves policy, spending and replay protection intact", () => {
  const f = fixture(); f.tx({ ...f.payment, request_id: "kept" });
  f.caller(f.config.owner_id);
  setPolicy(f.host, f.config, { ...f.policy, max_per_payment: "60000000" });
  const pending = getPendingPolicy(f.host)!;
  f.caller("stranger.near");
  assert.throws(() => cancelPolicy(f.host, f.config), /owner_or_guardian_only/);
  assert.throws(() => proposeOwnerRecovery(f.host, f.config, "next.near"), /guardian_only/);
  f.caller(f.config.guardian_id); cancelPolicy(f.host, f.config); f.reload();
  f.time(BigInt(pending.activate_after));
  assert.throws(() => activatePolicy(f.host, pending.proposal_id), /no_pending_policy/);
  assert.equal(getPolicy(f.host, f.policy.token_id)!.max_per_payment, "50000000");
  assert.throws(() => f.tx(), /agent_only/);
  assert.throws(() => setPolicy(f.host, f.config, f.policy), /owner_only/);
  f.caller(f.config.agent_id);
  assert.throws(() => f.tx({ ...f.payment, amount: "60000000" }), /max_per_payment/);
  assert.throws(() => f.tx({ ...f.payment, request_id: "kept" }), /duplicate_request/);
  assert.equal(getSpending(f.host, f.policy.token_id, "20000"), "40000000");
});

test("recovery supersession restarts 24 hours; without veto owner loses authority", () => {
  const f = fixture(); f.tx({ ...f.payment, request_id: "before-recovery" });
  const old = f.config.owner_id;
  f.caller(f.config.guardian_id);
  proposeGuardianChange(f.host, f.config, "guardian2.near");
  proposeOwnerRecovery(f.host, f.config, "next.near");
  assert.equal(getPendingGuardianChange(f.host), null);
  const first = getPendingOwnerRecovery(f.host)!;
  f.time(BigInt(first.activate_after) - 1n);
  assert.throws(() => activateOwnerRecovery(f.host, f.config, first.proposal_id), /identity_timelocked/);
  proposeOwnerRecovery(f.host, f.config, "final.near");
  const second = getPendingOwnerRecovery(f.host)!; f.reload();
  assert.ok(BigInt(second.activate_after) > BigInt(first.activate_after));
  assert.throws(() => activateOwnerRecovery(f.host, f.config, first.proposal_id), /proposal_id_mismatch/);
  assert.throws(() => proposeGuardianChange(f.host, f.config, "guardian2.near"), /recovery_pending/);
  f.caller(old);
  assert.throws(() => proposeOwnerRecovery(f.host, f.config, "attacker.near"), /guardian_only/);
  cancelPolicy(f.host, f.config);
  assert.throws(() => setPolicy(f.host, f.config, { ...f.policy, max_per_payment: "60000000" }), /recovery_pending/);
  assert.throws(() => activatePolicy(f.host, "1"), /recovery_pending/);
  f.caller("final.near");
  assert.throws(() => setPolicy(f.host, f.config, f.policy), /owner_only/);
  f.time(BigInt(second.activate_after) - 1n);
  assert.throws(() => activateOwnerRecovery(f.host, f.config, second.proposal_id), /identity_timelocked/);
  f.time(BigInt(second.activate_after)); activateOwnerRecovery(f.host, f.config, second.proposal_id);
  assert.equal(f.config.owner_id, "final.near");
  setPolicy(f.host, f.config, f.policy);
  f.caller(old); assert.throws(() => setPolicy(f.host, f.config, f.policy), /owner_only/);
  assert.throws(() => activateOwnerRecovery(f.host, f.config, second.proposal_id), /no_pending_identity/);
  f.caller(f.config.agent_id);
  assert.throws(() => f.tx({ ...f.payment, request_id: "before-recovery" }), /duplicate_request/);
  assert.equal(getSpending(f.host, f.policy.token_id, "20000"), "40000000");
});

test("guardian changes accept owner or current guardian and a full delay; identities remain separate", () => {
  const f = fixture();
  f.caller(f.config.owner_id);
  for (const id of [f.config.owner_id, f.config.agent_id, "guard.test.near"]) {
    assert.throws(() => initialize(f.host, f.config.owner_id, f.config.agent_id, id), /separate_guardian_required/);
  }
  f.caller("stranger.near");
  assert.throws(() => proposeGuardianChange(f.host, f.config, "next.near"), /owner_or_guardian_only/);
  f.caller(f.config.guardian_id);
  for (const id of [f.config.owner_id, f.config.agent_id, f.config.guardian_id, "guard.test.near"]) {
    assert.throws(() => proposeOwnerRecovery(f.host, f.config, id), /separate_replacement_required/);
    assert.throws(() => proposeGuardianChange(f.host, f.config, id), /separate_replacement_required/);
  }
  f.deposit(1n);
  assert.throws(() => proposeOwnerRecovery(f.host, f.config, "next.near"), /zero_deposit_required/);
  f.deposit(0n);
  proposeGuardianChange(f.host, f.config, "next.near");
  const p = getPendingGuardianChange(f.host)!;
  f.time(BigInt(p.activate_after) - 1n);
  assert.throws(() => activateGuardianChange(f.host, f.config, p.proposal_id), /identity_timelocked/);
  f.time(BigInt(p.activate_after)); activateGuardianChange(f.host, f.config, p.proposal_id);
  assert.throws(() => proposeOwnerRecovery(f.host, f.config, "newowner.near"), /guardian_only/);
  f.caller("next.near"); proposeOwnerRecovery(f.host, f.config, "newowner.near");
});


test("owner veto clears only recovery, releases freeze and gives fresh recovery a full delay", () => {
  const f = fixture();
  f.tx({ ...f.payment, request_id: "veto-kept" });
  const config = { ...f.config };
  const policy = getPolicy(f.host, f.policy.token_id);
  const day = dayAt(f.host);
  f.caller(f.config.guardian_id);
  proposeOwnerRecovery(f.host, f.config, "next.near");
  const first = getPendingOwnerRecovery(f.host)!;
  for (const caller of [f.config.guardian_id, f.config.agent_id, "stranger.near", "guard.test.near"]) {
    f.caller(caller);
    assert.throws(() => cancelOwnerRecovery(f.host, f.config), /owner_only/);
    assert.deepEqual(getPendingOwnerRecovery(f.host), first);
  }
  f.time(BigInt(first.activate_after) - 1n);
  f.caller(f.config.owner_id);
  f.deposit(1n);
  assert.throws(() => cancelOwnerRecovery(f.host, f.config), /zero_deposit_required/);
  f.deposit(0n);
  cancelOwnerRecovery(f.host, f.config); f.reload();
  assert.equal(getPendingOwnerRecovery(f.host), null);
  assert.deepEqual(f.config, config);
  assert.deepEqual(getPolicy(f.host, f.policy.token_id), policy);
  assert.equal(getSpending(f.host, f.policy.token_id, day), "40000000");
  assert.throws(() => activateOwnerRecovery(f.host, f.config, first.proposal_id), /no_pending_identity/);
  f.time(BigInt(first.activate_after) + 1n);
  assert.throws(() => activateOwnerRecovery(f.host, f.config, first.proposal_id), /no_pending_identity/);
  setPolicy(f.host, f.config, { ...f.policy, max_per_payment: "60000000" });
  assert.ok(getPendingPolicy(f.host));
  f.caller(f.config.agent_id);
  assert.throws(() => f.tx({ ...f.payment, request_id: "veto-kept" }), /duplicate_request/);
  f.caller(f.config.guardian_id);
  assert.throws(() => proposeOwnerRecovery(f.host, f.config, "next.near"), /recovery_cooldown/);
  f.time(BigInt(getRecoveryCooldown(f.host)));
  proposeOwnerRecovery(f.host, f.config, "next.near");
  const fresh = getPendingOwnerRecovery(f.host)!;
  assert.ok(BigInt(fresh.proposal_id) > BigInt(first.proposal_id));
  assert.equal(BigInt(fresh.activate_after), BigInt(getRecoveryCooldown(f.host)) + DAY_NS);
  assert.equal(getPendingPolicy(f.host), null);
  assert.throws(() => activateOwnerRecovery(f.host, f.config, first.proposal_id), /proposal_id_mismatch/);
  f.time(BigInt(fresh.activate_after) - 1n);
  assert.throws(() => activateOwnerRecovery(f.host, f.config, fresh.proposal_id), /identity_timelocked/);
  // No owner signature is needed for activation when the owner does not veto.
  f.time(BigInt(fresh.activate_after)); f.caller("stranger.near");
  activateOwnerRecovery(f.host, f.config, fresh.proposal_id);
  f.caller(config.owner_id);
  assert.throws(() => cancelOwnerRecovery(f.host, f.config), /owner_only/);
  assert.throws(() => setPolicy(f.host, f.config, f.policy), /owner_only/);
});

test("owner veto remains immediate after a recovery matures", () => {
  const f = fixture(); f.caller(f.config.guardian_id);
  proposeOwnerRecovery(f.host, f.config, "next.near");
  const pending = getPendingOwnerRecovery(f.host)!;
  f.time(BigInt(pending.activate_after)); f.caller(f.config.owner_id);
  cancelOwnerRecovery(f.host, f.config);
  assert.throws(() => activateOwnerRecovery(f.host, f.config, pending.proposal_id), /no_pending_identity/);
});

test("unvetoed owner replacement survives recovery and proposal interference; activation revokes queued authority", () => {
  const f = fixture(); const old = f.config.guardian_id;
  f.caller(old); proposeOwnerRecovery(f.host, f.config, "thief.near");
  const recovery = getPendingOwnerRecovery(f.host)!;
  f.caller(f.config.owner_id); proposeGuardianChange(f.host, f.config, "safe.near");
  const first = getPendingGuardianChange(f.host)!;
  f.time(BigInt(first.activate_after) - 1n);
  proposeGuardianChange(f.host, f.config, "safe.near");
  const pending = getPendingGuardianChange(f.host)!;
  assert.equal(BigInt(pending.activate_after), BigInt(first.activate_after) - 1n + DAY_NS);
  assert.throws(() => activateGuardianChange(f.host, f.config, first.proposal_id), /proposal_id_mismatch/);
  f.caller(old);
  assert.throws(() => proposeGuardianChange(f.host, f.config, "evil.near"), /owner_guardian_change_pending/);
  proposeOwnerRecovery(f.host, f.config, "thief.near");
  const newer = getPendingOwnerRecovery(f.host)!;
  assert.deepEqual(getPendingGuardianChange(f.host), pending);
  f.time(BigInt(pending.activate_after) - 1n);
  assert.throws(() => activateGuardianChange(f.host, f.config, pending.proposal_id), /identity_timelocked/);
  f.reload(); f.time(BigInt(pending.activate_after));
  activateGuardianChange(f.host, f.config, pending.proposal_id);
  assert.equal(getPendingOwnerRecovery(f.host), null);
  assert.throws(() => proposeOwnerRecovery(f.host, f.config, "thief.near"), /guardian_only/);
  assert.throws(() => cancelPolicy(f.host, f.config), /owner_or_guardian_only/);
  for (const p of [recovery, newer]) assert.throws(() => activateOwnerRecovery(f.host, f.config, p.proposal_id), /no_pending_identity/);
  f.caller("safe.near"); cancelPolicy(f.host, f.config);
  proposeOwnerRecovery(f.host, f.config, "legitimate.near");
});

test("veto cooldown persists to exact boundary, no-op cancellation cannot extend it, safe administration works", () => {
  const f = fixture(); f.caller(f.config.guardian_id);
  proposeOwnerRecovery(f.host, f.config, "next.near");
  f.caller(f.config.owner_id); cancelOwnerRecovery(f.host, f.config);
  const until = BigInt(getRecoveryCooldown(f.host));
  assert.equal(until, f.host.timestamp() + RECOVERY_COOLDOWN_NS);
  f.reload(); f.time(until - 1n); cancelOwnerRecovery(f.host, f.config);
  assert.equal(BigInt(getRecoveryCooldown(f.host)), until);
  setPolicy(f.host, f.config, { ...f.policy, max_per_payment: "1" });
  proposeGuardianChange(f.host, f.config, "safe.near");
  f.caller(f.config.guardian_id);
  assert.throws(() => proposeOwnerRecovery(f.host, f.config, "next.near"), /^Error: recovery_cooldown$/);
  f.time(until); proposeOwnerRecovery(f.host, f.config, "next.near");
  const p = getPendingOwnerRecovery(f.host)!;
  assert.equal(BigInt(p.activate_after), until + DAY_NS);
  f.time(until + DAY_NS - 1n);
  assert.throws(() => activateOwnerRecovery(f.host, f.config, p.proposal_id), /identity_timelocked/);
  f.time(until + DAY_NS); activateOwnerRecovery(f.host, f.config, p.proposal_id);
  assert.equal(getPendingGuardianChange(f.host), null);
  assert.equal(f.config.owner_id, "next.near");

  // A replacement queued earlier can mature strictly inside the veto cooldown.
  const g = fixture(); g.caller(g.config.owner_id);
  proposeGuardianChange(g.host, g.config, "safe.near");
  const change = getPendingGuardianChange(g.host)!;
  g.time(BigInt(change.activate_after) - 1n); g.caller(g.config.guardian_id);
  proposeOwnerRecovery(g.host, g.config, "thief.near");
  g.caller(g.config.owner_id); cancelOwnerRecovery(g.host, g.config);
  g.time(BigInt(change.activate_after));
  assert.ok(g.host.timestamp() < BigInt(getRecoveryCooldown(g.host)));
  activateGuardianChange(g.host, g.config, change.proposal_id);
  assert.equal(g.config.guardian_id, "safe.near");
  g.caller("safe.near");
  assert.throws(() => proposeOwnerRecovery(g.host, g.config, "next.near"), /recovery_cooldown/);
});

test("current guardian veto clears only replacement, preserves recovery and gives fresh proposals full delay", () => {
  const f = fixture();
  f.tx({ ...f.payment, request_id: "veto-ledger" });
  f.caller(f.config.guardian_id);
  proposeOwnerRecovery(f.host, f.config, "newowner.near");
  f.caller(f.config.owner_id); cancelOwnerRecovery(f.host, f.config);
  f.time(BigInt(getRecoveryCooldown(f.host)));
  f.caller(f.config.guardian_id);
  proposeOwnerRecovery(f.host, f.config, "newowner.near");
  f.caller(f.config.owner_id);
  proposeGuardianChange(f.host, f.config, "next.near");
  const first = getPendingGuardianChange(f.host)!;
  const config = { ...f.config };
  const before = f.snapshot();
  for (const caller of [f.config.owner_id, f.config.agent_id, "former.near", "next.near", "stranger.near", "guard.test.near"]) {
    f.caller(caller);
    assert.throws(() => cancelGuardianChange(f.host, f.config), /^Error: guardian_only$/);
    assert.deepEqual(f.snapshot(), before);
  }
  f.caller(f.config.guardian_id); f.deposit(1n);
  assert.throws(() => cancelGuardianChange(f.host, f.config), /zero_deposit_required/);
  assert.deepEqual(f.snapshot(), before); f.deposit(0n);
  cancelGuardianChange(f.host, f.config); f.reload();
  assert.deepEqual(f.snapshot(), before.map(([k, v]) => [k, k === "pending_guardian_change" ? "null" : v]));
  assert.deepEqual(f.config, config);
  assert.throws(() => activateGuardianChange(f.host, f.config, first.proposal_id), /^Error: no_pending_identity$/);
  f.time(BigInt(first.activate_after) + 1n);
  assert.throws(() => activateGuardianChange(f.host, f.config, first.proposal_id), /^Error: no_pending_identity$/);
  const after = f.snapshot(); cancelGuardianChange(f.host, f.config);
  assert.deepEqual(f.snapshot(), after);
  cancelPolicy(f.host, f.config); // Current guardian retains authority.
  f.caller(f.config.agent_id);
  assert.throws(() => f.tx({ ...f.payment, request_id: "veto-ledger" }), /duplicate_request/);
  f.caller(f.config.owner_id);
  proposeGuardianChange(f.host, f.config, "next.near");
  const fresh = getPendingGuardianChange(f.host)!;
  assert.ok(BigInt(fresh.proposal_id) > BigInt(first.proposal_id));
  assert.equal(BigInt(fresh.activate_after), BigInt(first.activate_after) + 1n + DAY_NS);
  f.time(BigInt(fresh.activate_after) - 1n);
  assert.throws(() => activateGuardianChange(f.host, f.config, fresh.proposal_id), /identity_timelocked/);
  f.time(BigInt(fresh.activate_after));
  f.caller(f.config.guardian_id); cancelGuardianChange(f.host, f.config);
  assert.throws(() => activateGuardianChange(f.host, f.config, fresh.proposal_id), /^Error: no_pending_identity$/);
  activateOwnerRecovery(f.host, f.config, getPendingOwnerRecovery(f.host)!.proposal_id);
  assert.equal(f.config.owner_id, "newowner.near");
});

test("guardian can veto mature and guardian-proposed changes; former guardian loses veto", () => {
  const f = fixture(); const former = f.config.guardian_id;
  f.caller(former); proposeGuardianChange(f.host, f.config, "next.near");
  const first = getPendingGuardianChange(f.host)!;
  f.time(BigInt(first.activate_after)); cancelGuardianChange(f.host, f.config);
  assert.throws(() => activateGuardianChange(f.host, f.config, first.proposal_id), /no_pending_identity/);
  proposeGuardianChange(f.host, f.config, "next.near");
  const fresh = getPendingGuardianChange(f.host)!;
  f.time(BigInt(fresh.activate_after)); activateGuardianChange(f.host, f.config, fresh.proposal_id);
  f.caller(f.config.owner_id); proposeGuardianChange(f.host, f.config, "third.near");
  f.caller(former);
  assert.throws(() => cancelGuardianChange(f.host, f.config), /guardian_only/);
  assert.ok(getPendingGuardianChange(f.host));
  f.caller(f.config.guardian_id); cancelGuardianChange(f.host, f.config);
  assert.equal(getPendingGuardianChange(f.host), null);
});
