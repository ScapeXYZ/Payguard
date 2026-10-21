import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "near-workspaces";
import { KeyPair, transactions } from "near-api-js";
import { readFile, writeFile } from "node:fs/promises";
import { SandboxServer } from "near-workspaces/dist/server/server.js";
import { lockGuard } from "../scripts/lock-guard.mjs";

// Test-only genesis tuning, before the node starts or any account is created.
// Long epochs make day-long fastForward jumps cheap. This changes neither the
// contract delay nor its block clock and never patches deployed contract state.
const initSandbox = SandboxServer.init.bind(SandboxServer);
SandboxServer.init = async (config) => {
  const server = await initSandbox(config);
  const path = `${server.homeDir}/genesis.json`;
  const genesis = JSON.parse(await readFile(path, "utf8"));
  genesis.epoch_length = 1_000_000;
  await writeFile(path, JSON.stringify(genesis));
  return server;
};

// Advance real Sandbox blocks; never patch contract state or supply a clock.
async function activatePending(worker, caller, guard) {
  const pending = await guard.view("get_pending_policy");
  assert.ok(pending);
  for (let jumps = 0; jumps < 40; jumps++) {
    const block = await worker.provider.block({ finality: "final" });
    if (BigInt(block.header.timestamp_nanosec) >= BigInt(pending.activate_after)) break;
    await worker.provider.fastForward(1_000_000);
  }
  const block = await worker.provider.block({ finality: "final" });
  assert.ok(BigInt(block.header.timestamp_nanosec) >= BigInt(pending.activate_after));
  await caller.call(guard, "activate_policy", { proposal_id: pending.proposal_id });
}

// Explicit network avoids environment-driven testnet selection. No public RPCs.
async function fixture(t) {
  const worker = await Worker.init({ network: "sandbox" });
  t.after(() => worker.tearDown());
  const owner = await worker.rootAccount.createSubAccount("owner", { initialBalance: 100n * 10n ** 24n });
  const exit = await worker.rootAccount.createSubAccount("cold");
  const guardian = await worker.rootAccount.createSubAccount("guardian");
  const agent = await owner.createSubAccount("agent", { initialBalance: 5n * 10n ** 24n });
  const alice = await owner.createSubAccount("alice", { initialBalance: 10n ** 24n });
  const stranger = await owner.createSubAccount("stranger", { initialBalance: 10n ** 24n });
  const guard = owner.getSubAccount("guard");
  const token = await owner.createSubAccount("usdc", { initialBalance: 10n * 10n ** 24n });
  const guardSigner = KeyPair.fromRandom("ed25519");
  const backup = KeyPair.fromRandom("ed25519");
  const guardFunctionKey = KeyPair.fromRandom("ed25519");
  // Deployment + initialization in one transaction from trusted owner.
  const deployment = await owner.batch(guard)
    .createAccount()
    .transfer(10n ** 25n)
    .addKey(guardSigner.getPublicKey(), transactions.fullAccessKey())
    .addKey(backup.getPublicKey(), transactions.fullAccessKey())
    .addKey(guardFunctionKey.getPublicKey(), transactions.functionCallAccessKey(guard.accountId, ["pay"], 10n ** 24n))
    .deployContract(await readFile("build/guard.wasm"))
    .functionCall("init", { owner_id: owner.accountId, agent_id: agent.accountId, guardian_id: guardian.accountId, exit_id: exit.accountId }, { gas: 30_000_000_000_000n })
    .transact();
  assert.equal(deployment.failed, false);
  await token.deploy("build/mock-ft.wasm");
  await owner.call(token, "init", { owner_id: owner.accountId, total_supply: "1000000000" });
  for (const account of [guard, alice, exit]) {
    await owner.call(token, "storage_deposit", { account_id: account.accountId }, { attachedDeposit: 10n ** 22n });
  }
  await owner.call(token, "ft_transfer", { receiver_id: guard.accountId, amount: "500000000" }, { attachedDeposit: 1n });
  const policy = { token_id: token.accountId, max_per_payment: "50000000", daily_limit: "100000000", recipients: [alice.accountId] };
  await owner.call(guard, "set_policy", policy);
  await activatePending(worker, owner, guard);

  const restricted = KeyPair.fromRandom("ed25519");
  const allowance = 10n ** 24n; // Finite 1 NEAR gas budget, local fake funds only.
  const added = await agent.batch(agent).addKey(restricted.getPublicKey(),
    transactions.functionCallAccessKey(guard.accountId, ["pay"], allowance)).transact();
  assert.equal(added.failed, false);
  const access = await agent.viewAccessKey(agent.accountId, restricted.getPublicKey());
  assert.equal(access.permission.FunctionCall.receiver_id, guard.accountId);
  assert.deepEqual(access.permission.FunctionCall.method_names, ["pay"]);
  assert.equal(access.permission.FunctionCall.allowance, allowance.toString());
  // Prove agent predecessor authentication before retiring its setup authority.
  await assert.rejects(agent.call(token, "forward_pay", {
    guard_id: guard.accountId,
    payment: { request_id: "relay-before-lock", token_id: token.accountId,
      recipient_id: alice.accountId, amount: "1" },
  }, { gas: 150_000_000_000_000n }), /agent_only/);
  await assert.rejects(agent.call(guard, "pay", {
    request_id: "deposit-before-lock", token_id: token.accountId,
    recipient_id: alice.accountId, amount: "1",
  }, { gas: 80_000_000_000_000n, attachedDeposit: 1n }), /not payable/i);
  await assert.rejects(agent.call(guard, "set_policy", policy), /owner_only/);
  await assert.rejects(agent.call(guard, "cancel_owner_recovery", {}), /owner_only/);
  await assert.rejects(agent.call(guard, "emergency_sweep", { token_id: token.accountId }, { gas: 200_000_000_000_000n }), /owner_or_guardian_only/);
  const agentSetupKey = await agent.getKey();
  const retired = await agent.batch(agent).deleteKey(agentSetupKey.getPublicKey()).transact();
  assert.equal(retired.failed, false);
  const agentKeys = await agent.viewAccessKeys(agent.accountId);
  assert.equal(agentKeys.keys.length, 1);
  assert.equal(agentKeys.keys[0].public_key, restricted.getPublicKey().toString());

  const ownerKeys = await owner.viewAccessKeys(owner.accountId);
  const before = await guard.viewAccessKeys(guard.accountId);
  assert.equal(before.keys.length, 3);
  assert.equal(before.keys.filter(k => k.access_key.permission === "FullAccess").length, 2);
  await assert.rejects(lockGuard({ guard, provider: worker.provider, signingKey: guardSigner,
    ownerId: owner.accountId, agentId: agent.accountId }), /explicit_irreversible_lock_confirmation_required/);
  assert.equal((await guard.viewAccessKeys(guard.accountId)).keys.length, 3);
  await lockGuard({ guard, provider: worker.provider, signingKey: guardSigner,
    ownerId: owner.accountId, agentId: agent.accountId,
    confirmation: `LOCK ${guard.accountId} IRREVERSIBLY` });
  // Actual RPC list, not local keystore inspection or Sandbox state patching.
  assert.deepEqual((await guard.viewAccessKeys(guard.accountId)).keys, []);
  assert.deepEqual((await owner.viewAccessKeys(owner.accountId)).keys, ownerKeys.keys);
  assert.deepEqual((await agent.viewAccessKeys(agent.accountId)).keys, agentKeys.keys);
  // near-api-js queries on-chain keys before signing and refuses the deleted key.
  await assert.rejects(guard.batch(guard).transfer(1n).transact(guardSigner),
    /no matching key pair exists/);
  await owner.call(guard, "set_policy", { ...policy, max_per_payment: "45000000" });
  assert.equal((await guard.view("get_policy", { token_id: token.accountId })).max_per_payment, "45000000");
  await owner.call(guard, "set_policy", policy);
  await activatePending(worker, stranger, guard);
  assert.deepEqual(await guard.view("get_config"), { owner_id: owner.accountId, agent_id: agent.accountId, guardian_id: guardian.accountId, exit_id: exit.accountId });
  const payment = { token_id: token.accountId, recipient_id: alice.accountId, amount: "40000000" };
  const options = { gas: 80_000_000_000_000n, attachedDeposit: 0n, signWithKey: restricted };
  let sequence = 0;
  return { worker, owner, exit, guardian, agent, alice, stranger, guard, token, policy, payment, options,
    pay: (input = payment) => agent.call(guard, "pay", { request_id: "sandbox-" + ++sequence, ...input }, options),
    spending: (args = {}) => guard.view("get_spending", { token_id: token.accountId, ...args }),
    balance: (account) => token.view("ft_balance_of", { account_id: account.accountId }),
  };
}

test("Sandbox: deletes every guard key then three signed 40 USDC transactions reject third", { timeout: 600000 }, async (t) => {
  const f = await fixture(t);
  await f.pay();
  assert.equal(await f.balance(f.alice), "40000000");
  await f.pay({ ...f.payment, token_id: f.token.accountId.toUpperCase() });
  assert.equal((await f.spending()).spent, "80000000");
  await assert.rejects(f.pay(), /daily_limit/);
  assert.equal(await f.balance(f.alice), "80000000");
  assert.equal(await f.balance(f.guard), "420000000");
  // Neither direct FT calls nor arbitrary method/native transfer can use agent key.
  await assert.rejects(f.agent.call(f.token, "ft_transfer", { receiver_id: f.alice.accountId, amount: "1" }, f.options),
    { type: "ReceiverMismatch" });
  await assert.rejects(f.agent.call(f.guard, "set_policy", f.policy, f.options),
    { type: "MethodNameMismatch" });
  await assert.rejects(f.agent.call(f.guard, "pay", f.payment, { ...f.options, attachedDeposit: 1n }),
    { type: "DepositWithFunctionCall" });
  await assert.rejects(f.agent.batch(f.alice).transfer(1n).transact(f.options.signWithKey),
    { type: "RequiresFullAccess" });
});

test("Sandbox: predecessor authorization, owner policy, input validation, and no reset methods", { timeout: 600000 }, async (t) => {
  const f = await fixture(t);
  for (const caller of [f.owner, f.stranger]) {
    await assert.rejects(caller.call(f.guard, "pay", f.payment, { gas: f.options.gas }), /agent_only/);
  }
  // Full-access test signer deliberately bypasses the method key boundary to test contract authentication.
  await assert.rejects(f.stranger.call(f.guard, "set_policy", f.policy), /owner_only/);
  await assert.rejects(f.owner.call(f.guard, "init", { owner_id: f.owner.accountId, agent_id: f.agent.accountId }));
  for (const method of ["reset_spending", "withdraw", "ft_transfer"]) {
    await assert.rejects(f.stranger.call(f.guard, method, {}));
  }
  const { token_id, ...missingToken } = f.payment;
  await assert.rejects(f.pay(missingToken), /bad_account_id/);
  await assert.rejects(f.pay({ ...f.payment, token_id: "unknown.near" }), /unknown_token/);
  await assert.rejects(f.pay({ ...f.payment, recipient_id: f.stranger.accountId }), /unapproved_recipient/);
  await assert.rejects(f.pay({ ...f.payment, amount: "50000001" }), /max_per_payment/);
  await assert.rejects(f.pay({ ...f.payment, amount: 40 }), /bad_amount/);
  assert.equal((await f.spending()).spent, "0");
  for (const gas of [59_000_000_000_000n, 101_000_000_000_000n]) {
    await assert.rejects(f.agent.call(f.guard, "pay", { ...f.payment, request_id: "gas-test" }, { ...f.options, gas }), /pay_gas_out_of_range/);
  }
  await assert.rejects(f.agent.call(f.guard, "pay", { ...f.payment, request_id: "deposit-test" },
    { ...f.options, attachedDeposit: 1n }), { type: "DepositWithFunctionCall" });
  await f.pay();
  await f.owner.call(f.guard, "set_policy", { ...f.policy, token_id: token_id.toUpperCase() });
  assert.equal((await f.spending()).spent, "40000000");
});

test("Sandbox: failed ft_transfer leaves reservation and funds; UTC day rollover preserves old bucket", { timeout: 600000 }, async (t) => {
  const f = await fixture(t);
  // Stranger is deliberately unregistered on the FT, but approved in guard policy.
  await f.owner.call(f.guard, "set_policy", { ...f.policy, recipients: [f.stranger.accountId] });
  await activatePending(f.worker, f.stranger, f.guard);
  const original = await f.spending();
  const fail = { ...f.payment, recipient_id: f.stranger.accountId };
  await assert.rejects(f.pay(fail), /recipient_not_registered/);
  // The failing downstream receipt must not reopen the same request ID.
  await assert.rejects(f.pay({ ...fail, request_id: "sandbox-1" }), /duplicate_request/);
  await assert.rejects(f.pay(fail), /recipient_not_registered/);
  assert.equal((await f.spending()).spent, "80000000");
  assert.equal(await f.balance(f.guard), "500000000");
  await assert.rejects(f.pay(fail), /daily_limit/);
  // Cross a long test epoch and observe the actual contract clock. Stop
  // as soon as the UTC day changes; never infer elapsed time from height.
  let next = await f.spending();
  for (let jumps = 0; next.day === original.day && jumps < 40; jumps++) {
    await f.worker.provider.fastForward(1_000_000);
    next = await f.spending();
  }
  assert.ok(BigInt(next.day) > BigInt(original.day));
  assert.equal(next.spent, "0");
  assert.equal((await f.spending({ day: original.day })).spent, "80000000");
  await assert.rejects(f.pay({ ...fail, request_id: "sandbox-1" }), /duplicate_request/);
  await f.owner.call(f.guard, "set_policy", f.policy);
  await activatePending(f.worker, f.stranger, f.guard);
  await f.pay();
  assert.equal(await f.balance(f.alice), "40000000");
});

test("Sandbox: duplicate requests cannot pay twice or change payload to reuse an ID", { timeout: 600000 }, async (t) => {
  const f = await fixture(t);
  const payment = { ...f.payment, request_id: "invoice-1" };
  await assert.rejects(f.owner.call(f.token, "forward_pay", {
    guard_id: f.guard.accountId, payment,
  }, { gas: 150_000_000_000_000n }), /agent_only/);
  await assert.rejects(f.agent.call(f.guard, "pay", f.payment, f.options), /bad_request_id/);
  await f.pay(payment);
  await assert.rejects(f.pay(payment), /duplicate_request/);
  await assert.rejects(f.pay({ ...payment, amount: "1" }), /duplicate_request/);
  assert.equal((await f.spending()).spent, "40000000");
  assert.equal(await f.balance(f.alice), "40000000");
  await assert.rejects(f.pay({ ...payment, request_id: null }), /bad_request_id/);
  await assert.rejects(f.pay({ ...payment, request_id: "invoice-1\n" }), /bad_request_id/);
  await assert.rejects(f.pay({ ...f.payment, token_id: f.token.accountId + "\n" }), /bad_account_id/);
  await assert.rejects(f.pay({ ...f.payment, amount: "1\n" }), /bad_amount/);
});


test("Sandbox: owner cap raise cannot pay or activate early; exact pending policy activates after 24 hours", { timeout: 600000 }, async (t) => {
  const f = await fixture(t);
  await f.pay();
  const oldSpending = await f.spending();
  await f.owner.call(f.guard, "set_policy", { ...f.policy, max_per_payment: "60000000" });
  const pending = await f.guard.view("get_pending_policy");
  const block = await f.worker.provider.block({ finality: "final" });
  assert.ok(BigInt(pending.activate_after) > BigInt(block.header.timestamp_nanosec));
  assert.equal((await f.guard.view("get_policy", { token_id: f.token.accountId })).max_per_payment, "50000000");
  await assert.rejects(f.pay({ ...f.payment, amount: "60000000" }), /max_per_payment/);
  for (const caller of [f.owner, f.stranger]) {
    await assert.rejects(caller.call(f.guard, "activate_policy", { proposal_id: pending.proposal_id }), /policy_timelocked/);
  }
  await assert.rejects(f.owner.call(f.guard, "set_policy", { ...f.policy, max_per_payment: "70000000" }), /pending_policy_exists/);
  assert.equal((await f.spending({ day: oldSpending.day })).spent, "40000000");
  await activatePending(f.worker, f.stranger, f.guard);
  assert.equal((await f.guard.view("get_policy", { token_id: f.token.accountId })).max_per_payment, "60000000");
  await f.pay({ ...f.payment, amount: "60000000" });
  assert.equal(await f.balance(f.alice), "100000000");
  assert.equal((await f.spending({ day: oldSpending.day })).spent, "40000000");
  await assert.rejects(f.owner.call(f.guard, "activate_policy", { proposal_id: pending.proposal_id }), /no_pending_policy/);
  // Later tightening invalidates a queued recipient/cap expansion on the keyless guard.
  await f.owner.call(f.guard, "set_policy", { ...f.policy, max_per_payment: "70000000", recipients: [f.alice.accountId, f.stranger.accountId] });
  const stale = await f.guard.view("get_pending_policy");
  await f.owner.call(f.guard, "disable_policy", { token_id: f.token.accountId });
  assert.equal(await f.guard.view("get_pending_policy"), null);
  await assert.rejects(f.stranger.call(f.guard, "activate_policy", { proposal_id: stale.proposal_id }), /no_pending_policy/);
  await assert.rejects(f.pay(), /unknown_token/);
});

test("Sandbox: guardian veto and delayed owner recovery preserve keyless payment isolation", { timeout: 600000 }, async (t) => {
  const f = await fixture(t);
  await f.pay({ ...f.payment, request_id: "recovery-ledger" });
  const spent = await f.spending();
  await f.owner.call(f.guard, "set_policy", { ...f.policy, max_per_payment: "60000000" });
  const vetoed = await f.guard.view("get_pending_policy");
  await assert.rejects(f.stranger.call(f.guard, "cancel_policy", {}), /owner_or_guardian_only/);
  await assert.rejects(f.owner.call(f.guard, "propose_owner_recovery", { owner_id: f.stranger.accountId }), /guardian_only/);
  await assert.rejects(f.stranger.call(f.guard, "propose_owner_recovery", { owner_id: f.stranger.accountId }), /guardian_only/);
  await f.guardian.call(f.guard, "cancel_policy", {});
  await assert.rejects(f.stranger.call(f.guard, "activate_policy", { proposal_id: vetoed.proposal_id }), /no_pending_policy/);
  await assert.rejects(f.pay({ ...f.payment, amount: "60000000" }), /max_per_payment/);
  await assert.rejects(f.guardian.call(f.guard, "pay", { ...f.payment, request_id: "guardian-pay" }, { gas: f.options.gas }), /agent_only/);
  await f.guardian.call(f.guard, "propose_owner_recovery", { owner_id: f.stranger.accountId });
  const canceled = await f.guard.view("get_pending_owner_recovery");
  const config = await f.guard.view("get_config");
  const activePolicy = await f.guard.view("get_policy", { token_id: f.token.accountId });
  for (const caller of [f.guardian, f.stranger]) {
    await assert.rejects(caller.call(f.guard, "cancel_owner_recovery", {}), /owner_only/);
  }
  await assert.rejects(f.agent.call(f.guard, "cancel_owner_recovery", {}, f.options), { type: "MethodNameMismatch" });
  await assert.rejects(f.owner.call(f.guard, "set_policy", { ...f.policy, max_per_payment: "60000000" }), /recovery_pending/);
  await f.owner.call(f.guard, "cancel_owner_recovery", {});
  assert.equal(await f.guard.view("get_pending_owner_recovery"), null);
  await assert.rejects(f.guardian.call(f.guard, "propose_owner_recovery", { owner_id: f.stranger.accountId }), /recovery_cooldown/);
  assert.deepEqual(await f.guard.view("get_config"), config);
  assert.deepEqual(await f.guard.view("get_policy", { token_id: f.token.accountId }), activePolicy);
  assert.equal((await f.spending({ day: spent.day })).spent, spent.spent);
  await assert.rejects(f.stranger.call(f.guard, "activate_owner_recovery", { proposal_id: canceled.proposal_id }), /no_pending_identity/);
  await f.owner.call(f.guard, "set_policy", { ...f.policy, max_per_payment: "60000000" });
  assert.ok(await f.guard.view("get_pending_policy"));
  for (let jumps = 0; jumps < 40; jumps++) {
    const block = await f.worker.provider.block({ finality: "final" });
    if (BigInt(block.header.timestamp_nanosec) >= BigInt(await f.guard.view("get_recovery_cooldown"))) break;
    await f.worker.provider.fastForward(1_000_000);
  }
  assert.ok(BigInt((await f.worker.provider.block({ finality: "final" })).header.timestamp_nanosec) >= BigInt(await f.guard.view("get_recovery_cooldown")));
  await assert.rejects(f.stranger.call(f.guard, "activate_owner_recovery", { proposal_id: canceled.proposal_id }), /no_pending_identity/);
  const beforeProposal = await f.worker.provider.block({ finality: "final" });
  await f.guardian.call(f.guard, "propose_owner_recovery", { owner_id: f.stranger.accountId });
  const pending = await f.guard.view("get_pending_owner_recovery");
  assert.ok(BigInt(pending.proposal_id) > BigInt(canceled.proposal_id));
  assert.ok(BigInt(pending.activate_after) >= BigInt(beforeProposal.header.timestamp_nanosec) + 86_400_000_000_000n);
  assert.ok(BigInt(pending.activate_after) > BigInt(canceled.activate_after));
  await assert.rejects(f.stranger.call(f.guard, "activate_owner_recovery", { proposal_id: pending.proposal_id }), /identity_timelocked/);
  await assert.rejects(f.stranger.call(f.guard, "set_policy", f.policy), /owner_only/);
  await f.owner.call(f.guard, "cancel_policy", {});
  await assert.rejects(f.owner.call(f.guard, "set_policy", { ...f.policy, max_per_payment: "60000000" }), /recovery_pending/);
  for (let jumps = 0; jumps < 40; jumps++) {
    const block = await f.worker.provider.block({ finality: "final" });
    if (BigInt(block.header.timestamp_nanosec) >= BigInt(pending.activate_after)) break;
    await f.worker.provider.fastForward(1_000_000);
  }
  const block = await f.worker.provider.block({ finality: "final" });
  assert.ok(BigInt(block.header.timestamp_nanosec) >= BigInt(pending.activate_after));
  await f.stranger.call(f.guard, "activate_owner_recovery", { proposal_id: pending.proposal_id });
  assert.equal((await f.guard.view("get_config")).owner_id, f.stranger.accountId);
  await assert.rejects(f.owner.call(f.guard, "set_policy", f.policy), /owner_only/);
  await f.stranger.call(f.guard, "set_policy", { ...f.policy, daily_limit: "80000000" });
  assert.equal((await f.guard.view("get_policy", { token_id: f.token.accountId })).daily_limit, "80000000");
  assert.equal((await f.spending({ day: spent.day })).spent, "40000000");
  await assert.rejects(f.pay({ ...f.payment, request_id: "recovery-ledger" }), /duplicate_request/);
  await f.pay(); await f.pay();
  await assert.rejects(f.pay(), /daily_limit/);
  assert.deepEqual((await f.guard.viewAccessKeys(f.guard.accountId)).keys, []);
  await assert.rejects(f.agent.call(f.guard, "propose_owner_recovery", { owner_id: f.owner.accountId }, f.options), { type: "MethodNameMismatch" });
  await assert.rejects(f.owner.call(f.guard, "emergency_sweep", { token_id: f.token.accountId }, { gas: 200_000_000_000_000n }), /owner_or_guardian_only/);
  assert.equal(await f.stranger.call(f.guard, "emergency_sweep", { token_id: f.token.accountId }, { gas: 200_000_000_000_000n }), "transferred");
  assert.equal((await f.guard.view("get_config")).exit_id, f.exit.accountId);
});

test("Sandbox: unvetoed owner replacement despite recovery invalidates queued takeover", { timeout: 600000 }, async (t) => {
  const f = await fixture(t);
  const next = await f.owner.createSubAccount("newguardian", { initialBalance: 10n ** 24n });
  await assert.rejects(f.stranger.call(f.guard, "propose_guardian_change", { guardian_id: next.accountId }), /owner_or_guardian_only/);
  for (const caller of [f.owner, f.guardian]) {
    await assert.rejects(caller.call(f.token, "forward_identity", {
      guard_id: f.guard.accountId, method: "propose_guardian_change", args: { guardian_id: next.accountId },
    }, { gas: 100_000_000_000_000n }), /owner_or_guardian_only/);
  }
  await assert.rejects(f.guardian.call(f.token, "forward_identity", {
    guard_id: f.guard.accountId, method: "propose_owner_recovery", args: { owner_id: f.stranger.accountId },
  }, { gas: 100_000_000_000_000n }), /guardian_only/);
  await f.guardian.call(f.guard, "propose_guardian_change", { guardian_id: next.accountId });
  await f.guardian.call(f.guard, "propose_owner_recovery", { owner_id: f.stranger.accountId });
  const recovery = await f.guard.view("get_pending_owner_recovery");
  const before = await f.worker.provider.block({ finality: "final" });
  await f.owner.call(f.guard, "propose_guardian_change", { guardian_id: next.accountId });
  const p = await f.guard.view("get_pending_guardian_change");
  assert.ok(BigInt(p.activate_after) >= BigInt(before.header.timestamp_nanosec) + 86_400_000_000_000n);
  await assert.rejects(f.stranger.call(f.guard, "activate_guardian_change", { proposal_id: p.proposal_id }), /identity_timelocked/);
  await assert.rejects(f.guardian.call(f.guard, "propose_guardian_change", { guardian_id: f.stranger.accountId }), /owner_guardian_change_pending/);
  await f.guardian.call(f.guard, "propose_owner_recovery", { owner_id: f.stranger.accountId });
  const latest = await f.guard.view("get_pending_owner_recovery");
  assert.deepEqual(await f.guard.view("get_pending_guardian_change"), p);
  for (let jumps = 0; jumps < 40; jumps++) {
    const block = await f.worker.provider.block({ finality: "final" });
    if (BigInt(block.header.timestamp_nanosec) >= BigInt(p.activate_after)) break;
    await f.worker.provider.fastForward(1_000_000);
  }
  assert.ok(BigInt((await f.worker.provider.block({ finality: "final" })).header.timestamp_nanosec) >= BigInt(p.activate_after));
  await f.stranger.call(f.guard, "activate_guardian_change", { proposal_id: p.proposal_id });
  assert.equal((await f.guard.view("get_config")).guardian_id, next.accountId);
  await assert.rejects(f.guardian.call(f.guard, "propose_owner_recovery", { owner_id: f.stranger.accountId }), /guardian_only/);
  await assert.rejects(f.guardian.call(f.guard, "cancel_policy", {}), /owner_or_guardian_only/);
  for (const old of [recovery, latest]) await assert.rejects(f.stranger.call(f.guard, "activate_owner_recovery", { proposal_id: old.proposal_id }), /no_pending_identity/);
  await next.call(f.guard, "cancel_policy", {});
  await next.call(f.guard, "propose_owner_recovery", { owner_id: f.stranger.accountId });
  await assert.rejects(f.guardian.call(f.guard, "emergency_sweep", { token_id: f.token.accountId }, { gas: 200_000_000_000_000n }), /owner_or_guardian_only/);
  assert.equal(await next.call(f.guard, "emergency_sweep", { token_id: f.token.accountId }, { gas: 200_000_000_000_000n }), "transferred");
  assert.equal((await f.guard.view("get_config")).exit_id, f.exit.accountId);
});

test("Sandbox: current guardian veto uses predecessor and preserves recovery, ledger and full replacement delay", { timeout: 600000 }, async (t) => {
  const f = await fixture(t);
  const next = await f.owner.createSubAccount("veto-next", { initialBalance: 10n ** 24n });
  const waitUntil = async (deadline) => {
    for (let jumps = 0; jumps < 40; jumps++) {
      if (BigInt((await f.worker.provider.block({ finality: "final" })).header.timestamp_nanosec) >= BigInt(deadline)) return;
      await f.worker.provider.fastForward(1_000_000);
    }
    assert.fail("Sandbox clock did not reach deadline");
  };
  await f.pay({ ...f.payment, request_id: "guardian-veto-ledger" });
  const spent = await f.spending();
  await f.guardian.call(f.guard, "propose_owner_recovery", { owner_id: f.stranger.accountId });
  await f.owner.call(f.guard, "cancel_owner_recovery", {});
  const cooldown = await f.guard.view("get_recovery_cooldown");
  await waitUntil(cooldown);
  await f.guardian.call(f.guard, "propose_owner_recovery", { owner_id: f.stranger.accountId });
  const recovery = await f.guard.view("get_pending_owner_recovery");
  await f.owner.call(f.guard, "propose_guardian_change", { guardian_id: next.accountId });
  const first = await f.guard.view("get_pending_guardian_change");
  const config = await f.guard.view("get_config");
  const policy = await f.guard.view("get_policy", { token_id: f.token.accountId });
  for (const caller of [f.owner, f.stranger, next]) {
    await assert.rejects(caller.call(f.guard, "cancel_guardian_change", {}), /guardian_only/);
  }
  await assert.rejects(f.agent.call(f.guard, "cancel_guardian_change", {}, f.options), { type: "MethodNameMismatch" });
  await assert.rejects(f.guardian.call(f.token, "forward_identity", {
    guard_id: f.guard.accountId, method: "cancel_guardian_change", args: {},
  }, { gas: 100_000_000_000_000n }), /guardian_only/);
  await assert.rejects(f.guardian.call(f.guard, "cancel_guardian_change", {}, { attachedDeposit: 1n }));
  assert.deepEqual(await f.guard.view("get_pending_guardian_change"), first);
  await f.guardian.call(f.guard, "cancel_guardian_change", {});
  assert.equal(await f.guard.view("get_pending_guardian_change"), null);
  await assert.rejects(f.stranger.call(f.guard, "activate_guardian_change", { proposal_id: first.proposal_id }), /no_pending_identity/);
  await waitUntil(first.activate_after);
  await assert.rejects(f.stranger.call(f.guard, "activate_guardian_change", { proposal_id: first.proposal_id }), /no_pending_identity/);
  assert.deepEqual(await f.guard.view("get_config"), config);
  assert.deepEqual(await f.guard.view("get_pending_owner_recovery"), recovery);
  assert.equal(await f.guard.view("get_recovery_cooldown"), cooldown);
  assert.deepEqual(await f.guard.view("get_policy", { token_id: f.token.accountId }), policy);
  assert.equal((await f.spending({ day: spent.day })).spent, spent.spent);
  await assert.rejects(f.pay({ ...f.payment, request_id: "guardian-veto-ledger" }), /duplicate_request/);
  await f.guardian.call(f.guard, "cancel_policy", {});
  const before = await f.worker.provider.block({ finality: "final" });
  await f.owner.call(f.guard, "propose_guardian_change", { guardian_id: next.accountId });
  const fresh = await f.guard.view("get_pending_guardian_change");
  assert.ok(BigInt(fresh.proposal_id) > BigInt(first.proposal_id));
  assert.ok(BigInt(fresh.activate_after) >= BigInt(before.header.timestamp_nanosec) + 86_400_000_000_000n);
  await assert.rejects(f.stranger.call(f.guard, "activate_guardian_change", { proposal_id: fresh.proposal_id }), /identity_timelocked/);
  await waitUntil(fresh.activate_after);
  await f.stranger.call(f.guard, "activate_guardian_change", { proposal_id: fresh.proposal_id });
  assert.equal(await f.guard.view("get_pending_owner_recovery"), null);
  await next.call(f.guard, "propose_guardian_change", { guardian_id: f.stranger.accountId });
  await assert.rejects(f.guardian.call(f.guard, "cancel_guardian_change", {}), /guardian_only/);
  await next.call(f.guard, "cancel_guardian_change", {});
  assert.equal(await f.guard.view("get_pending_guardian_change"), null);
});

test("Sandbox: cold exit sweeps full balances, fails safely and serializes receipts", { timeout: 600000 }, async (t) => {
  const f = await fixture(t);
  const args = { token_id: f.token.accountId, receiver_id: f.stranger.accountId, exit_id: f.stranger.accountId };
  const opts = { gas: 200_000_000_000_000n };
  await assert.rejects(f.owner.call(f.guard, "init", { owner_id: f.owner.accountId, agent_id: f.agent.accountId, guardian_id: f.guardian.accountId, exit_id: f.stranger.accountId }), /already initialized/i);
  for (const caller of [f.stranger]) {
    await assert.rejects(caller.call(f.guard, "emergency_sweep", args, opts), /owner_or_guardian_only/);
  }
  await assert.rejects(f.agent.call(f.guard, "emergency_sweep", args, f.options), { type: "MethodNameMismatch" });
  await assert.rejects(f.owner.call(f.token, "forward_identity", {
    guard_id: f.guard.accountId, method: "emergency_sweep", args,
  }, { gas: 250_000_000_000_000n }), /owner_or_guardian_only/);
  await assert.rejects(f.owner.call(f.guard, "on_sweep_balance", { token_id: f.token.accountId, sweep_id: "1" }), /private/i);
  await assert.rejects(f.owner.call(f.guard, "emergency_sweep", args, { ...opts, attachedDeposit: 1n }), /not payable/i);
  await f.guardian.call(f.guard, "propose_owner_recovery", { owner_id: f.stranger.accountId });
  await f.owner.call(f.guard, "propose_guardian_change", { guardian_id: f.alice.accountId });
  await f.owner.call(f.guard, "disable_policy", { token_id: f.token.accountId });
  const spending = await f.spending();
  const concurrent = await Promise.allSettled([
    f.owner.call(f.guard, "emergency_sweep", args, opts),
    f.guardian.call(f.guard, "emergency_sweep", args, opts),
  ]);
  assert.ok(concurrent.some(r => r.status === "fulfilled" && r.value === "transferred"));
  for (const result of concurrent) {
    if (result.status === "rejected") assert.match(String(result.reason), /sweep_pending/);
    else assert.ok(["transferred", "zero_balance"].includes(result.value));
  }
  assert.equal(await f.balance(f.guard), "0");
  assert.equal(await f.balance(f.exit), "500000000");
  assert.equal(await f.balance(f.stranger), "0");
  assert.deepEqual(await f.spending(), spending);
  assert.equal(await f.guardian.call(f.guard, "emergency_sweep", args, opts), "zero_balance");
  // Another token has no policy and exit is initially unregistered.
  // Avoid the default 100 NEAR transfer from the already-funded fixture owner.
  // Match the primary token's 10 NEAR budget for contract storage and gas.
  const other = await f.owner.createSubAccount("other", { initialBalance: 10n * 10n ** 24n });
  await other.deploy("build/mock-ft.wasm");
  await f.owner.call(other, "init", { owner_id: f.owner.accountId, total_supply: "123" });
  await f.owner.call(other, "storage_deposit", { account_id: f.guard.accountId });
  await f.owner.call(other, "ft_transfer", { receiver_id: f.guard.accountId, amount: "123" }, { attachedDeposit: 1n });
  const second = { token_id: other.accountId };
  assert.equal(await f.guardian.call(f.guard, "emergency_sweep", second, opts), "transfer_failed");
  assert.equal(await other.view("ft_balance_of", { account_id: f.guard.accountId }), "123");
  await f.owner.call(other, "storage_deposit", { account_id: f.exit.accountId });
  assert.equal(await f.guardian.call(f.guard, "emergency_sweep", second, opts), "transferred");
  assert.equal(await other.view("ft_balance_of", { account_id: f.exit.accountId }), "123");
  // Missing ft_balance_of gives a recoverable query failure on every retry.
  for (let i = 0; i < 2; i++) assert.equal(await f.owner.call(f.guard, "emergency_sweep", { token_id: f.stranger.accountId }, opts), "balance_query_failed");
  assert.equal((await f.guard.view("get_config")).exit_id, f.exit.accountId);
});
