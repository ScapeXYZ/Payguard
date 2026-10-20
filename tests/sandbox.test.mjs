import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "near-workspaces";
import { KeyPair, transactions } from "near-api-js";
import { readFile } from "node:fs/promises";

// Explicit network avoids environment-driven testnet selection. No public RPCs.
async function fixture(t) {
  const worker = await Worker.init({ network: "sandbox" });
  t.after(() => worker.tearDown());
  const owner = await worker.rootAccount.createSubAccount("owner", { initialBalance: 100n * 10n ** 24n });
  const agent = await owner.createSubAccount("agent", { initialBalance: 5n * 10n ** 24n });
  const alice = await owner.createSubAccount("alice", { initialBalance: 10n ** 24n });
  const stranger = await owner.createSubAccount("stranger", { initialBalance: 10n ** 24n });
  const guard = owner.getSubAccount("guard");
  const token = await owner.createSubAccount("usdc", { initialBalance: 10n * 10n ** 24n });
  // Deployment + initialization in one transaction from trusted owner.
  const deployment = await owner.batch(guard)
    .createAccount()
    .transfer(10n ** 25n)
    .deployContract(await readFile("build/guard.wasm"))
    .functionCall("init", { owner_id: owner.accountId, agent_id: agent.accountId }, { gas: 30_000_000_000_000n })
    .transact();
  assert.equal(deployment.failed, false);
  await token.deploy("build/mock-ft.wasm");
  await owner.call(token, "init", { owner_id: owner.accountId, total_supply: "1000000000" });
  for (const account of [guard, alice]) {
    await owner.call(token, "storage_deposit", { account_id: account.accountId }, { attachedDeposit: 10n ** 22n });
  }
  await owner.call(token, "ft_transfer", { receiver_id: guard.accountId, amount: "500000000" }, { attachedDeposit: 1n });
  const policy = { token_id: token.accountId, max_per_payment: "50000000", daily_limit: "100000000", recipients: [alice.accountId] };
  await owner.call(guard, "set_policy", policy);

  const restricted = KeyPair.fromRandom("ed25519");
  const allowance = 10n ** 24n; // Finite 1 NEAR gas budget, local fake funds only.
  const added = await agent.batch(agent).addKey(restricted.getPublicKey(),
    transactions.functionCallAccessKey(guard.accountId, ["pay"], allowance)).transact();
  assert.equal(added.failed, false);
  const access = await agent.viewAccessKey(agent.accountId, restricted.getPublicKey());
  assert.equal(access.permission.FunctionCall.receiver_id, guard.accountId);
  assert.deepEqual(access.permission.FunctionCall.method_names, ["pay"]);
  assert.equal(access.permission.FunctionCall.allowance, allowance.toString());
  const payment = { token_id: token.accountId, recipient_id: alice.accountId, amount: "40000000" };
  const options = { gas: 80_000_000_000_000n, attachedDeposit: 0n, signWithKey: restricted };
  let sequence = 0;
  return { worker, owner, agent, alice, stranger, guard, token, policy, payment, options,
    pay: (input = payment) => agent.call(guard, "pay", { request_id: "sandbox-" + ++sequence, ...input }, options),
    spending: (args = {}) => guard.view("get_spending", { token_id: token.accountId, ...args }),
    balance: (account) => token.view("ft_balance_of", { account_id: account.accountId }),
  };
}

test("Sandbox: three separate signed 40 USDC transactions reject third and actually move guard funds", { timeout: 180000 }, async (t) => {
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

test("Sandbox: predecessor authorization, owner policy, input validation, and no reset methods", { timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  for (const caller of [f.owner, f.stranger]) {
    await assert.rejects(caller.call(f.guard, "pay", f.payment, { gas: f.options.gas }), /agent_only/);
  }
  // Full-access test signer deliberately bypasses the method key boundary to test contract authentication.
  await assert.rejects(f.agent.call(f.guard, "set_policy", f.policy), /owner_only/);
  await assert.rejects(f.stranger.call(f.guard, "set_policy", f.policy), /owner_only/);
  await assert.rejects(f.owner.call(f.guard, "init", { owner_id: f.owner.accountId, agent_id: f.agent.accountId }));
  for (const method of ["reset_spending", "withdraw", "ft_transfer"]) {
    await assert.rejects(f.agent.call(f.guard, method, {}));
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
    { gas: f.options.gas, attachedDeposit: 1n }), /not payable/i);
  await f.pay();
  await f.owner.call(f.guard, "set_policy", { ...f.policy, token_id: token_id.toUpperCase() });
  assert.equal((await f.spending()).spent, "40000000");
});

test("Sandbox: failed ft_transfer leaves reservation and funds; UTC day rollover preserves old bucket", { timeout: 600000 }, async (t) => {
  const f = await fixture(t);
  // Stranger is deliberately unregistered on the FT, but approved in guard policy.
  await f.owner.call(f.guard, "set_policy", { ...f.policy, recipients: [f.stranger.accountId] });
  const original = await f.spending();
  const fail = { ...f.payment, recipient_id: f.stranger.accountId };
  await assert.rejects(f.pay(fail), /recipient_not_registered/);
  // The failing downstream receipt must not reopen the same request ID.
  await assert.rejects(f.pay({ ...fail, request_id: "sandbox-1" }), /duplicate_request/);
  await assert.rejects(f.pay(fail), /recipient_not_registered/);
  assert.equal((await f.spending()).spent, "80000000");
  assert.equal(await f.balance(f.guard), "500000000");
  await assert.rejects(f.pay(fail), /daily_limit/);
  // Sandbox time jumps can be slow across many epochs. Observe the actual
  // contract clock between small jumps and stop as soon as UTC day changes.
  let next = await f.spending();
  for (let jumps = 0; next.day === original.day && jumps < 40; jumps++) {
    await f.worker.provider.fastForward(5000);
    next = await f.spending();
  }
  assert.ok(BigInt(next.day) > BigInt(original.day));
  assert.equal(next.spent, "0");
  assert.equal((await f.spending({ day: original.day })).spent, "80000000");
  await assert.rejects(f.pay({ ...fail, request_id: "sandbox-1" }), /duplicate_request/);
  await f.owner.call(f.guard, "set_policy", f.policy);
  await f.pay();
  assert.equal(await f.balance(f.alice), "40000000");
});

test("Sandbox: duplicate requests cannot pay twice or change payload to reuse an ID", { timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  const payment = { ...f.payment, request_id: "invoice-1" };
  await assert.rejects(f.agent.call(f.token, "forward_pay", {
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
