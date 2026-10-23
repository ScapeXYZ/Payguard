import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';

// Execute the production pure modules in memory; no generated source or React mocks.
const cache = new Map(), nativeRequire = createRequire(import.meta.url);
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const file = new URL(`../lib/${name}.ts`, import.meta.url);
  const result = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} }; cache.set(name, module.exports);
  runInThisContext(`(function(require, module, exports) {${result.outputText}\n})`, { filename: file.pathname })(
    spec => spec.startsWith('./') ? load(spec.slice(2)) : nativeRequire(spec), module, module.exports);
  return module.exports;
}
const { classifySubmittedTx } = load('tx-binding');
const { createTxController, isUnresolved } = load('tx-controller');
const { isUserRejection } = load('errors');
const expected = { hash: '1'.repeat(44), signerId: 'owner.testnet', receiverId: 'guard.testnet',
  method: 'set_policy', args: { token_id: 'token.testnet', max_per_payment: '5', daily_limit: '20', recipients: ['merchant.testnet'] }, deposit: '0' };
const call = () => structuredClone({ method: expected.method, args: expected.args });
function fixture() {
  return { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: expected.hash, signer_id: expected.signerId, receiver_id: expected.receiverId,
      actions: [{ FunctionCall: { method_name: expected.method, args: Buffer.from(JSON.stringify(expected.args)).toString('base64'), deposit: '0' } }] },
    transaction_outcome: { id: expected.hash, outcome: { executor_id: expected.signerId, status: { SuccessReceiptId: 'root' }, receipt_ids: ['root'], logs: [] } },
    receipts_outcome: [{ id: 'root', outcome: { executor_id: expected.receiverId, status: { SuccessValue: '' }, receipt_ids: [], logs: [] } }] };
}
test('exact submitted call confirms; JSON key ordering is immaterial', () => {
  const tx = fixture();
  tx.transaction.actions[0].FunctionCall.args = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(expected.args).reverse()))).toString('base64');
  assert.equal(classifySubmittedTx(tx, expected).outcome.status, 'confirmed');
});
for (const [name, mutate] of [
  ['hash', t => { t.transaction.hash = 'other'; }],
  ['signer', t => { t.transaction.signer_id = 'attacker.testnet'; }],
  ['receiver', t => { t.transaction.receiver_id = 'other.testnet'; }],
  ['method', t => { t.transaction.actions[0].FunctionCall.method_name = 'disable_policy'; }],
  ['deposit', t => { t.transaction.actions[0].FunctionCall.deposit = '1'; }],
  ['missing deposit', t => { delete t.transaction.actions[0].FunctionCall.deposit; }],
  ['numeric deposit', t => { t.transaction.actions[0].FunctionCall.deposit = 0; }],
  ['args', t => { t.transaction.actions[0].FunctionCall.args = Buffer.from(JSON.stringify({ ...expected.args, daily_limit: '999' })).toString('base64'); }],
  ['extra args', t => { t.transaction.actions[0].FunctionCall.args = Buffer.from(JSON.stringify({ ...expected.args, extra: true })).toString('base64'); }],
  ['malformed args', t => { t.transaction.actions[0].FunctionCall.args = '%%%'; }],
  ['extra action', t => { t.transaction.actions.push(t.transaction.actions[0]); }],
  ['missing root', t => { t.receipts_outcome = []; }],
  ['missing transaction outcome', t => { delete t.transaction_outcome; }],
  ['wrong outcome identity', t => { t.transaction_outcome.id = 'other'; }],
  ['nonterminal transaction outcome', t => { t.transaction_outcome.outcome.status = { Unknown: true }; }],
  ['wrong transaction receipt link', t => { t.transaction_outcome.outcome.status = { SuccessReceiptId: 'other' }; }],
  ['wrong root executor', t => { t.receipts_outcome[0].outcome.executor_id = 'other.testnet'; }],
  ['missing child', t => { t.receipts_outcome[0].outcome.receipt_ids = ['missing']; }],
  ['missing success target', t => { t.receipts_outcome[0].outcome.status = { SuccessReceiptId: 'missing' }; }],
  ['duplicate receipt', t => { t.receipts_outcome.push(t.receipts_outcome[0]); }],
  ['receipt cycle', t => { t.receipts_outcome[0].outcome.receipt_ids = ['root']; }],
  ['nonterminal child', t => { t.receipts_outcome[0].outcome.status = { Unknown: true }; }],
  ['EXECUTED', t => { t.final_execution_status = 'EXECUTED'; }],
  ['absent finality', t => { delete t.final_execution_status; }],
]) test(`${name} cannot confirm or release a submission`, () => {
  const tx = fixture(); mutate(tx);
  assert.equal(classifySubmittedTx(tx, expected).outcome.status, 'pending');
});
test('bound guard failure fails; downstream failures remain separate', () => {
  const tx = fixture(); tx.status = { Failure: {} };
  tx.receipts_outcome[0].outcome.status = { Failure: { error: 'policy_disabled' } };
  assert.equal(classifySubmittedTx(tx, expected).outcome.status, 'failed');
  tx.receipts_outcome[0].outcome.status = { SuccessReceiptId: 'child' };
  tx.receipts_outcome[0].outcome.receipt_ids = ['child'];
  tx.receipts_outcome.push({ id: 'child', outcome: { executor_id: 'token.testnet', status: { Failure: {} }, receipt_ids: [], logs: [] } });
  const { outcome } = classifySubmittedTx(tx, expected);
  assert.equal(outcome.status, 'confirmed'); assert.equal(outcome.downstreamFailures.length, 1);
});
function harness(storage = { value: null }) {
  let time = 0, signed = 0, lookups = 0, refreshed = 0, response = fixture(), signError, noHash = false;
  const options = {
    storage: { read: () => storage.value, write: value => { storage.value = value; }, clear: () => { storage.value = null; } },
    lookup: async () => { lookups++; if (response instanceof Error) throw response; return structuredClone(response); },
    rejected: isUserRejection, refresh: () => { refreshed++; }, now: () => time,
    sleep: async () => { time += 5; }, deadlineMs: 10,
  };
  const controller = createTxController(options);
  const sign = async () => { signed++; if (signError) throw signError; return { hash: noHash ? null : expected.hash, signerId: expected.signerId }; };
  return { controller, options, storage, sign, run: () => controller.run(call(), expected.signerId, expected.receiverId, sign),
    response: value => { response = value; }, signError: value => { signError = value; }, noHash: () => { noHash = true; },
    counts: () => ({ signed, lookups, refreshed }) };
}
for (const kind of ['nonfinal', 'missing receipts', 'RPC error', 'wrong identity']) test(`timeout with ${kind} stays locked; verification retry never signs again`, async () => {
  const h = harness(), tx = fixture();
  if (kind === 'nonfinal') tx.final_execution_status = 'EXECUTED';
  if (kind === 'missing receipts') tx.receipts_outcome = [];
  if (kind === 'wrong identity') tx.transaction.hash = 'other';
  h.response(kind === 'RPC error' ? new Error('offline') : tx);
  assert.equal((await h.run()).phase, 'pending'); assert.ok(isUnresolved(h.controller.getSnapshot()));
  h.controller.reset(); await h.run(); await h.controller.retry();
  assert.equal(h.counts().signed, 1); assert.equal(h.counts().refreshed, 0);
  h.response(fixture()); assert.equal((await h.controller.retry()).phase, 'confirmed');
  assert.equal(h.counts().signed, 1); assert.equal(h.counts().refreshed, 1);
  assert.equal(h.storage.value, null);
});
test('navigation/reload restores the lock and retries the saved transaction only', async () => {
  const h = harness(); h.response(new Error('offline')); await h.run();
  const restored = createTxController(h.options); restored.restore();
  assert.equal(restored.getSnapshot().phase, 'pending');
  await restored.run(call(), expected.signerId, expected.receiverId, h.sign);
  assert.equal(h.counts().signed, 1);
  h.response(fixture()); assert.equal((await restored.retry()).phase, 'confirmed');
  assert.equal(h.counts().signed, 1);
});
test('double clicks and other buttons cannot sign during wallet approval', async () => {
  const h = harness(); let release;
  const signing = h.controller.run(call(), expected.signerId, expected.receiverId, () => new Promise(resolve => { release = resolve; }));
  await h.run(); h.controller.reset();
  assert.equal(h.counts().signed, 0);
  release({ hash: expected.hash, signerId: expected.signerId });
  assert.equal((await signing).phase, 'confirmed');
});
for (const kind of ['no hash', 'wallet timeout', 'window closed', 'transport rejection']) test(`${kind} cannot authorize another signing attempt`, async () => {
  const h = harness();
  if (kind === 'no hash') h.noHash();
  else h.signError(new Error(kind === 'transport rejection' ? 'RPC rejected connection after broadcast' : kind));
  assert.equal((await h.run()).phase, 'pending'); h.controller.reset(); await h.run(); await h.controller.retry();
  assert.equal(h.counts().signed, 1);
});
test('explicit user rejection permits a fresh submission', async () => {
  const h = harness(); h.signError({ code: 4001 }); assert.equal((await h.run()).phase, 'rejected');
  h.signError(undefined); assert.equal((await h.run()).phase, 'confirmed'); assert.equal(h.counts().signed, 2);
});
test('unavailable submission storage fails closed before signing', async () => {
  const h = harness(); const c = createTxController({ ...h.options, storage: { read: () => null, write: () => { throw Error('quota'); }, clear: () => {} } });
  assert.equal((await c.run(call(), expected.signerId, expected.receiverId, h.sign)).phase, 'pending');
  assert.equal(h.counts().signed, 0);
});
test('reloading during signing, before any hash is available, remains locked', async () => {
  const h = harness();
  void h.controller.run(call(), expected.signerId, expected.receiverId, () => new Promise(() => {}));
  const restored = createTxController(h.options); restored.restore(); await restored.run(call(), expected.signerId, expected.receiverId, h.sign);
  await restored.retry(); assert.equal(restored.getSnapshot().phase, 'pending'); assert.equal(h.counts().signed, 0);
});
test('caller and wallet mutations cannot change expected arguments', async () => {
  const h = harness(), input = call(); let release;
  const running = h.controller.run(input, expected.signerId, expected.receiverId, async walletCall => {
    walletCall.args.daily_limit = '999'; await new Promise(resolve => { release = resolve; });
    return { hash: expected.hash, signerId: expected.signerId };
  });
  input.args.daily_limit = '777'; release(); assert.equal((await running).phase, 'confirmed');
});
test('a bound terminal failure releases the lock, but never a mismatched failure', async () => {
  const h = harness(), tx = fixture();
  tx.transaction_outcome.outcome.status = { Failure: {} };
  tx.status = { Failure: {} }; tx.receipts_outcome = [];
  const wrong = structuredClone(tx); wrong.transaction.signer_id = 'other.testnet';
  h.response(wrong); assert.equal((await h.run()).phase, 'pending');
  h.response(tx); assert.equal((await h.controller.retry()).phase, 'failed');
  h.response(fixture()); assert.equal((await h.run()).phase, 'confirmed');
  assert.equal(h.counts().signed, 2);
});
test('failure to persist terminal completion cannot release the submission lock', async () => {
  const h = harness();
  const c = createTxController({ ...h.options, storage: { ...h.options.storage, clear: () => { throw Error('storage unavailable'); } } });
  assert.equal((await c.run(call(), expected.signerId, expected.receiverId, h.sign)).phase, 'pending');
  await c.run(call(), expected.signerId, expected.receiverId, h.sign); c.reset();
  assert.equal(h.counts().signed, 1); assert.ok(isUnresolved(c.getSnapshot()));
});
