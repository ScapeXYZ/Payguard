import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';
import { project } from '../../scripts/export-payment-evidence.mjs';
import { enrichEvidence } from '../../scripts/verify-payment-evidence.mjs';
import { ids, guard, agent, token, payment, transaction, entry, envelope } from './fixtures/one-usdc.mjs';

// All production transport tests install a fetch mock; these URLs cannot be live deployments.
process.env.NEXT_PUBLIC_NEAR_NETWORK = 'testnet';
process.env.NEXT_PUBLIC_NEAR_RPC = 'https://primary.invalid';
process.env.NEXT_PUBLIC_NEAR_ARCHIVAL_RPC = 'https://archive.invalid';
process.env.NEXT_PUBLIC_EVIDENCE_URL = 'https://evidence.invalid/payments.json';
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
const { parseEvidence, verifyAgainstTx, verifyRecord, loadEvidence } = load('evidence');
const { enrichEvidenceTransaction, onlySystemRefundChildren } = load('evidence-receipts');
const { fmtEvidenceAmount, recordFingerprint, resultFor } = load('evidence-view');
const identity = { hash: ids.hash, signerId: agent, guardId: guard };
function record(e = entry(), source = 'runner_journal') {
  const { network, guard_id, ...r } = project(e);
  return { ...r, source };
}
const verified = (r, tx = transaction(), configuredAgent = agent) => verifyAgainstTx(r, tx, guard, configuredAgent);
const green = v => v.state === 'verified' && v.onchain === 'settled';
function readRpc(tx, calls = [], mutate = () => {}) {
  return async (method, params) => {
    calls.push({ method, params });
    let result;
    if (method === 'status') result = { chain_id: 'testnet' };
    else if (method === 'tx_status') result = structuredClone(tx);
    else if (method === 'EXPERIMENTAL_receipt') result = transaction().receipts.find(r => r.receipt_id === params.receipt_id);
    else throw Error('Unexpected method: ' + method);
    result = structuredClone(result); mutate(method, result); return result;
  };
}
for (const source of ['runner_journal', 'runner_journal_rpc']) {
  test(`${source}: main exporter refund fixture parses and verifies the exact one-USDC pay call`, () => {
    const r = record(entry(), source);
    assert.equal(r.amount, '1000000'); assert.equal(r.status, 'settled');
    assert.equal(parseEvidence(envelope([r], source), guard).ok, true);
    assert.ok(green(verified(r)));
    for (const key of ['token_symbol', 'token_decimals', 'block_height', 'block_timestamp_ns', 'scenario', 'policy_id', 'proposal_id']) assert.equal(r[key], null);
    assert.equal(fmtEvidenceAmount(r.amount, r.token_decimals, r.token_symbol), '1000000 base units');
  });
  test(`${source}: known-hash pending remains visible and never becomes verified`, () => {
    const e = entry(); e.events = [];
    const r = record(e, source);
    assert.equal(r.tx_hash, ids.hash); assert.equal(r.verified_at, null); assert.equal(r.status, 'pending');
    assert.equal(parseEvidence(envelope([r], source), guard).ok, true);
    const v = verified(r); assert.equal(v.state, 'unavailable'); assert.equal(v.chain.onchain, 'settled');
    assert.equal(v.chain.agrees, false); assert.equal(green(v), false);
  });
  test(`${source}: null hash and null observation are accepted but never verified`, () => {
    const e = entry(); e.events = []; delete e.transaction_hash;
    const r = record(e, source);
    assert.equal(parseEvidence(envelope([r], source), guard).ok, true);
    assert.equal(verified(r).state, 'unavailable');
    const settled = { ...record(entry(), source), verified_at: null };
    assert.equal(parseEvidence(envelope([settled], source), guard).ok, true);
    assert.equal(verified(settled).state, 'unavailable'); assert.equal(green(verified(settled)), false);
  });
  for (const field of ['scenario', 'token_symbol', 'token_decimals', 'block_height', 'block_timestamp_ns', 'recipient_balance_before', 'recipient_balance_after', 'policy_id', 'proposal_id']) {
    test(`${source}: cannot assert authoritative ${field}`, () => {
      const value = { scenario: 'A', token_symbol: 'USDC', token_decimals: 6, block_height: 123, block_timestamp_ns: '123', recipient_balance_before: '0', recipient_balance_after: '1000000', policy_id: '1', proposal_id: '2' };
      const r = { ...record(entry(), source), [field]: value[field] };
      assert.equal(parseEvidence(envelope([r], source), guard).ok, false); assert.equal(green(verified(r)), false);
    });
  }
}
test('duplicate hashes do not poison the feed or certify a second request', () => {
  const e = entry(); e.intent.payment.request_id = 'other-request'; e.events = [];
  const first = record(), pending = record(e);
  const payload = envelope([first, pending]);
  assert.equal(parseEvidence(payload, guard).ok, true); assert.equal(payload.records[1].tx_hash, ids.hash);
  assert.ok(green(verified(first))); assert.equal(green(verified(pending)), false);
  const falselySettled = { ...first, request_id: 'other-request' };
  assert.equal(parseEvidence(envelope([first, falselySettled]), guard).ok, true);
  assert.equal(green(verified(falselySettled)), false);
  assert.equal(verified(falselySettled).state, 'unverifiable');
});
test('duplicate request IDs, wrong deployment and inconsistent provenance remain file errors', () => {
  assert.equal(parseEvidence(envelope([record(), record()]), guard).ok, false);
  assert.equal(parseEvidence(envelope([record()]), 'other.testnet').ok, false);
  assert.equal(parseEvidence({ ...envelope([record()]), network: 'mainnet' }, guard).ok, false);
  assert.equal(parseEvidence(envelope([record(entry(), 'runner_journal_rpc')]), guard).ok, false);
  assert.equal(parseEvidence(envelope([record(entry(), 'unreviewed-source')], 'unreviewed-source'), guard).ok, false);
});
for (const field of ['tx_hash', 'verified_at', 'token_decimals', 'source', 'settlement_receipt_id']) test(`required nullable key ${field} cannot be omitted`, () => {
  const r = record(); delete r[field]; assert.equal(parseEvidence(envelope([r]), guard).ok, false);
});
test('invalid ISO timestamps and invalid status-dependent nulls are rejected', () => {
  for (const patch of [{ verified_at: 'yesterday' }, { verified_at: '2026-02-30T10:00:00.000Z' }, { tx_hash: null }, { settlement_receipt_id: null }, { reason: 'unknown' }])
    assert.equal(parseEvidence(envelope([{ ...record(), ...patch }]), guard).ok, false);
});
test('complete terminal system refunds match main, while arbitrary continuations remain reserved', () => {
  const tx = transaction(); assert.ok(onlySystemRefundChildren(tx, ids.ftReceipt, agent));
  tx.receipts[1].predecessor_id = token;
  const e = entry(tx), r = record(e);
  assert.equal(r.status, 'reserved'); assert.equal(verified(r, tx).onchain, 'reserved');
  assert.equal(green(verified(record(), tx)), false);
});
for (const [name, mutate] of [
  ['non-system sender', t => { t.receipts[1].predecessor_id = token; }],
  ['wrong refund recipient', t => { t.receipts[1].receiver_id = 'other.testnet'; }],
  ['nonzero gas price', t => { t.receipts[1].receipt.Action.gas_price = '1'; }],
  ['absent gas price', t => { delete t.receipts[1].receipt.Action.gas_price; }],
  ['zero refund', t => { t.receipts[1].receipt.Action.actions[0].Transfer.deposit = '0'; }],
  ['refund function call', t => { t.receipts[1].receipt.Action.actions = [{ FunctionCall: { method_name: 'callback' } }]; }],
  ['multiple refund actions', t => { t.receipts[1].receipt.Action.actions.push({ Transfer: { deposit: '1' } }); }],
  ['failed refund', t => { t.receipts_outcome[2].outcome.status = { Failure: {} }; t.status = { Failure: {} }; }],
]) test(`${name} cannot prove settlement`, () => {
  const tx = transaction(); mutate(tx);
  assert.equal(project(entry(tx)).status, 'reserved'); assert.equal(green(verified(record(), tx)), false);
});
for (const [name, mutate] of [
  ['missing FT body', t => { t.receipts.shift(); }],
  ['missing refund body', t => { t.receipts.splice(1, 1); }],
  ['missing FT outcome', t => { t.receipts_outcome.splice(1, 1); }],
  ['missing refund outcome', t => { t.receipts_outcome.splice(2, 1); }],
  ['duplicate body', t => { t.receipts.push(t.receipts[0]); }],
  ['contradictory duplicate body', t => { t.receipts.push({ ...t.receipts[0], receiver_id: 'other.testnet' }); }],
  ['duplicate outcome', t => { t.receipts_outcome.push(t.receipts_outcome[0]); }],
  ['nonfinal', t => { t.final_execution_status = 'EXECUTED'; }],
  ['absent finality', t => { delete t.final_execution_status; }],
  ['unknown FT status', t => { t.receipts_outcome[1].outcome.status = { Unknown: true }; }],
  ['contradictory terminal status', t => { t.receipts_outcome[1].outcome.status = { SuccessValue: '', Failure: {} }; }],
  ['contradictory aggregate', t => { t.status = { Failure: {} }; }],
  ['missing root link', t => { t.transaction_outcome.outcome.receipt_ids = []; }],
  ['wrong root executor', t => { t.receipts_outcome[0].outcome.executor_id = 'other.testnet'; }],
  ['cycle', t => { t.receipts_outcome[2].outcome.receipt_ids = [ids.guardReceipt]; }],
  ['unlinked body', t => { t.receipts.push({ ...t.receipts[0], receipt_id: ids.continuation }); }],
  ['invalid receipt ID', t => { t.receipts_outcome[1].id = 'invalid'; }],
]) test(`${name} never produces verified settlement`, () => {
  const tx = transaction(); mutate(tx);
  assert.equal(green(verified(record(), tx)), false);
});
for (const [name, mutate] of [
  ['different hash', t => { t.transaction.hash = '9'.repeat(44); }],
  ['different signer', t => { t.transaction.signer_id = 'other.testnet'; }],
  ['different receiver', t => { t.transaction.receiver_id = 'other.testnet'; }],
  ['different method', t => { t.transaction.actions[0].FunctionCall.method_name = 'emergency_sweep'; }],
  ['nonzero deposit', t => { t.transaction.actions[0].FunctionCall.deposit = '1'; }],
  ['absent deposit', t => { delete t.transaction.actions[0].FunctionCall.deposit; }],
  ['different request', t => { t.transaction.actions[0].FunctionCall.args = Buffer.from(JSON.stringify({ ...payment, request_id: 'other' })).toString('base64'); }],
  ['different amount', t => { t.transaction.actions[0].FunctionCall.args = Buffer.from(JSON.stringify({ ...payment, amount: '2000000' })).toString('base64'); }],
  ['wrong transfer amount', t => { t.receipts[0].receipt.Action.actions[0].FunctionCall.args = Buffer.from(JSON.stringify({ receiver_id: payment.recipient_id, amount: '2' })).toString('base64'); }],
]) test(`${name} cannot certify a claimed payment`, () => {
  const tx = transaction(); mutate(tx); assert.equal(green(verified(record(), tx)), false);
});
test('configured agent must be known and match the transaction', () => {
  assert.equal(green(verified(record(), transaction(), null)), false);
  assert.equal(green(verified(record(), transaction(), 'other.testnet')), false);
});
test('FT failure is settlement_failed; policy codes come only from the guard root', () => {
  const tx = transaction(); tx.receipts_outcome[1].outcome.status = { Failure: { error: 'daily_limit' } }; tx.status = { Failure: {} };
  const r = record(entry(tx)); assert.equal(r.status, 'settlement_failed');
  const v = verified(r, tx); assert.equal(v.state, 'verified'); assert.equal(v.onchain, 'settlement_failed'); assert.equal(v.chainCode, null); assert.equal(v.chainFailureText, 'receipt failed'); assert.equal(green(v), false);
  const rejected = transaction(); rejected.receipts_outcome = [rejected.receipts_outcome[0]];
  rejected.receipts_outcome[0].outcome.status = { Failure: { error: 'daily_limit' } };
  rejected.receipts_outcome[0].outcome.receipt_ids = []; rejected.receipts = []; rejected.status = { Failure: {} };
  const rejectRecord = record(entry(rejected)); assert.equal(rejectRecord.reason, 'guard_execution_failed');
  const vr = verified(rejectRecord, rejected); assert.equal(vr.state, 'verified'); assert.equal(vr.chainCode, 'daily_limit');
});
test('enrichment fetches every missing linked body, validates FINAL, and leaves snapshots unchanged', async () => {
  const tx = transaction(), calls = []; delete tx.receipts;
  const original = structuredClone(tx);
  const enriched = await enrichEvidenceTransaction(identity, readRpc(tx, calls));
  assert.deepEqual(tx, original); assert.ok(green(verified(record(), enriched)));
  assert.deepEqual(calls.map(c => c.method), ['status', 'tx_status', 'EXPERIMENTAL_receipt', 'EXPERIMENTAL_receipt', 'EXPERIMENTAL_receipt']);
  assert.deepEqual(calls[1].params, { tx_hash: ids.hash, sender_account_id: agent, wait_until: 'FINAL' });
  assert.deepEqual(new Set(calls.slice(2).map(c => c.params.receipt_id)), new Set([ids.ftReceipt, ids.ftRefund, ids.guardRefund]));
  const backend = await enrichEvidence(entry(tx), readRpc(tx));
  assert.equal(project(backend).status, 'settled');
});
test('existing bodies need no extra RPC and cannot be replaced to repair contradictions', async () => {
  const calls = []; await enrichEvidenceTransaction(identity, readRpc(transaction(), calls));
  assert.deepEqual(calls.map(c => c.method), ['status', 'tx_status']);
  const tx = transaction(); tx.receipts[0].receiver_id = 'other.testnet'; const badCalls = [];
  await assert.rejects(enrichEvidenceTransaction(identity, readRpc(tx, badCalls)));
  assert.equal(badCalls.some(c => c.method === 'EXPERIMENTAL_receipt'), false);
});
for (const fault of ['wrong network', 'nonfinal', 'missing outcome', 'wrong fetched body', 'wrong fetched receiver', 'RPC unavailable']) test(`enrichment rejects ${fault}`, async () => {
  const tx = transaction(); delete tx.receipts;
  if (fault === 'nonfinal') tx.final_execution_status = 'EXECUTED';
  if (fault === 'missing outcome') tx.receipts_outcome.pop();
  const base = readRpc(tx, [], (method, result) => {
    if (fault === 'wrong network' && method === 'status') result.chain_id = 'mainnet';
    if (fault === 'wrong fetched body' && method === 'EXPERIMENTAL_receipt') result.receipt_id = ids.continuation;
    if (fault === 'wrong fetched receiver' && method === 'EXPERIMENTAL_receipt') result.receiver_id = 'other.testnet';
  });
  await assert.rejects(enrichEvidenceTransaction(identity, fault === 'RPC unavailable' ? async () => { throw Error('offline'); } : base));
});
test('changed record fingerprints cannot display cached green results', () => {
  const r = record(), fp = recordFingerprint(r, 'testnet/guard.testnet|agent=' + agent);
  const cache = { row: { fp, v: verified(r) } };
  assert.ok(green(resultFor(cache, 'row', fp)));
  const changed = recordFingerprint({ ...r, verified_at: null }, 'testnet/guard.testnet|agent=' + agent);
  assert.equal(resultFor(cache, 'row', changed), undefined);
});
test('production verifyRecord only uses supported read-only RPC methods and never verifies a null observation', async () => {
  const previous = globalThis.fetch, calls = [], tx = transaction(); delete tx.receipts;
  const mock = readRpc(tx, calls);
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result: await mock(request.method, request.params) }) };
  };
  try {
    assert.ok(green(await verifyRecord(record(), guard, agent)));
    assert.equal((await verifyRecord({ ...record(), verified_at: null }, guard, agent)).state, 'unavailable');
    assert.ok(calls.every(c => ['status', 'tx_status', 'EXPERIMENTAL_receipt'].includes(c.method)));
  } finally { globalThis.fetch = previous; }
});

test('a successful FT with no children matches main without needing a refund body', () => {
  const tx = transaction(); tx.receipts_outcome[1].outcome.receipt_ids = [];
  tx.receipts_outcome.splice(2, 1); tx.receipts.splice(1, 1);
  const r = record(entry(tx)); assert.equal(r.status, 'settled'); assert.ok(green(verified(r, tx)));
});
test('empty exports are valid for both supported provenance types', () => {
  for (const source of ['runner_journal', 'runner_journal_rpc']) assert.equal(parseEvidence(envelope([], source), guard).ok, true);
});
test('a supplied root receipt body must agree with the signed pay action', () => {
  const tx = transaction();
  tx.receipts.push({ receipt_id: ids.guardReceipt, predecessor_id: agent, receiver_id: guard,
    receipt: { Action: { actions: structuredClone(tx.transaction.actions) } } });
  assert.ok(green(verified(record(), tx)));
  tx.receipts.at(-1).receipt.Action.actions[0].FunctionCall.method_name = 'emergency_sweep';
  assert.equal(green(verified(record(), tx)), false);
});
test('a linked body cannot name an unrelated predecessor', () => {
  const tx = transaction(); tx.receipts[2].predecessor_id = 'unrelated.testnet';
  assert.equal(green(verified(record(), tx)), false);
});
test('amounts, request IDs and hashes must be canonical, without trailing newlines', () => {
  for (const field of ['amount', 'request_id', 'tx_hash', 'agent_id']) {
    const r = record(); r[field] += '\n';
    assert.equal(parseEvidence(envelope([r]), guard).ok, false);
  }
});
test('archival fallback repeats the complete read-only verification on one provider', async () => {
  const previous = globalThis.fetch, calls = [], tx = transaction(); delete tx.receipts;
  const mock = readRpc(tx);
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(init.body); calls.push({ url, method: request.method });
    if (new URL(url).hostname === 'archive.invalid' && request.method === 'EXPERIMENTAL_receipt') return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result: await mock(request.method, request.params) }) };
  };
  try {
    assert.ok(green(await verifyRecord(record(), guard, agent)));
    assert.deepEqual(calls.map(c => c.method), ['status', 'tx_status', 'EXPERIMENTAL_receipt', 'status', 'tx_status', 'EXPERIMENTAL_receipt', 'EXPERIMENTAL_receipt', 'EXPERIMENTAL_receipt']);
    assert.ok(calls.slice(0, 3).every(c => new URL(c.url).hostname === 'archive.invalid'));
    assert.ok(calls.slice(3).every(c => new URL(c.url).hostname === 'primary.invalid'));
  } finally { globalThis.fetch = previous; }
});
test('contradictory archival evidence is never silently replaced by primary evidence', async () => {
  const previous = globalThis.fetch, calls = [], tx = transaction(); tx.receipts.push(tx.receipts[0]);
  const mock = readRpc(tx);
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(init.body); calls.push(url);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result: await mock(request.method, request.params) }) };
  };
  try {
    assert.equal(green(await verifyRecord(record(), guard, agent)), false);
    assert.ok(calls.every(url => new URL(url).hostname === 'archive.invalid'));
  } finally { globalThis.fetch = previous; }
});
test('feed fetch failure and malformed JSON are data errors, not empty exports', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 503 }); await assert.rejects(loadEvidence(guard));
    globalThis.fetch = async () => ({ ok: true, json: async () => { throw Error('invalid JSON'); } }); await assert.rejects(loadEvidence(guard));
    globalThis.fetch = async () => ({ ok: true, json: async () => envelope([record()]) });
    assert.equal((await loadEvidence(guard)).records.length, 1);
  } finally { globalThis.fetch = previous; }
});

for (const fault of ['wrong response ID', 'wrong JSON-RPC version', 'missing result', 'error and result', 'invalid JSON']) test(`production evidence transport refuses ${fault} without green or silent fallback`, async () => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(url); const request = JSON.parse(init.body);
    const body = { jsonrpc: '2.0', id: request.id, result: { chain_id: 'testnet' } };
    if (fault === 'wrong response ID') body.id = 'unrelated';
    if (fault === 'wrong JSON-RPC version') body.jsonrpc = '1.0';
    if (fault === 'missing result') delete body.result;
    if (fault === 'error and result') body.error = { code: -32000 };
    return { ok: true, json: async () => { if (fault === 'invalid JSON') throw Error('invalid JSON'); return body; } };
  };
  try {
    assert.equal(green(await verifyRecord(record(), guard, agent)), false);
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = previous; }
});
