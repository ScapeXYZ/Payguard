import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project, exportEvidence, parseArgs } from '../scripts/export-payment-evidence.mjs';

const tx = '1'.repeat(44), guardReceipt = '2'.repeat(44), ftReceipt = '3'.repeat(44);
function fixture() {
  return { version: 1, state: 'succeeded', transaction_hash: tx, intent: { network: 'testnet', guard: 'guard.testnet', agent: 'agent.testnet',
    payment: { request_id: 'invoice-1', recipient_id: 'merchant.testnet', token_id: 'token.testnet', amount: '40000000' } }, events: [{
    type: 'reconciliation', at: '2026-10-23T10:00:00.000Z', data: {
      transaction: { hash: tx, signer_id: 'agent.testnet', receiver_id: 'guard.testnet' }, final_execution_status: 'FINAL',
      transaction_outcome: { outcome: { receipt_ids: [guardReceipt] } },
      receipts_outcome: [
        { id: guardReceipt, outcome: { executor_id: 'guard.testnet', status: { SuccessReceiptId: ftReceipt }, receipt_ids: [ftReceipt] } },
        { id: ftReceipt, outcome: { executor_id: 'token.testnet', status: { SuccessValue: '' }, receipt_ids: [] } },
      ], receipts: [{ receipt_id: ftReceipt, predecessor_id: 'guard.testnet', receiver_id: 'token.testnet', receipt: { Action: { actions: [
        { FunctionCall: { method_name: 'ft_transfer', args: Buffer.from(JSON.stringify({ receiver_id: 'merchant.testnet', amount: '40000000' })).toString('base64') } },
      ] } } }],
    },
  }] };
}
test('explicit statuses require receipt evidence rather than runner labels', () => {
  const e = fixture(); assert.equal(project(e).status, 'settled');
  e.events[0].data.receipts_outcome[1].outcome.status = { Failure: { sensitive: 'withheld' } };
  assert.equal(project(e).status, 'settlement_failed');
  e.events[0].data.receipts_outcome.pop(); assert.equal(project(e).status, 'reserved');
  e.events[0].data.receipts_outcome[0].outcome.status = { Failure: {} };
  assert.equal(project(e).status, 'rejected');
  e.events = []; assert.equal(project(e).status, 'pending');
  for (const state of ['prepared', 'signed', 'uncertain', 'failed', 'succeeded']) { e.state = state; assert.equal(project(e).status, 'pending'); }
});
test('missing fields remain null and untrusted defaults and secrets never escape', () => {
  const e = fixture(); e.events = []; delete e.transaction_hash;
  Object.assign(e, { private_key: 'SECRET', signed_transaction: 'SIGNED', credentials: '/secret/key', token_symbol: 'USDC', token_decimals: 6, proposal_id: 2 });
  e.events.push({ type: 'reconciliation_error', rpc: 'https://secret:credential@rpc/', data: { message: 'seed words', signed_transaction: 'SIGNED' } });
  const r = project(e);
  for (const k of ['scenario', 'token_symbol', 'token_decimals', 'tx_hash', 'recipient_balance_before', 'recipient_balance_after', 'block_height', 'block_timestamp_ns', 'verified_at', 'proposal_id']) assert.equal(r[k], null);
  assert.equal(r.amount, '40000000');
  for (const secret of ['SECRET', 'SIGNED', '/secret/key', 'credential', 'seed words', 'USDC']) assert.equal(JSON.stringify(r).includes(secret), false);
});
test('uncertain, unlinked, mismatched and non-final evidence cannot certify settlement', () => {
  for (const mutate of [
    e => { e.events[0].data.final_execution_status = 'EXECUTED'; },
    e => { e.events[0].data.transaction.hash = 'wrong'; },
    e => { e.events[0].data.receipts_outcome.push(e.events[0].data.receipts_outcome[1]); },
    e => { delete e.events[0].data.receipts; },
    e => { e.events[0].data.transaction_outcome.outcome.receipt_ids = []; },
    e => { e.events[0].data.receipts[0].predecessor_id = 'other.testnet'; },
    e => { e.events[0].data.receipts[0].receipt.Action.actions[0].FunctionCall.args = 'invalid'; },
  ]) { const e = fixture(); mutate(e); assert.equal(project(e).status, 'pending'); }
  const e = fixture(); e.events[0].data.receipts_outcome[1].outcome.status = { Unknown: true };
  assert.equal(project(e).status, 'reserved');
});
async function disk(t) {
  const root = await mkdtemp(join(tmpdir(), 'payguard-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = join(root, 'journal'); await mkdir(journal);
  return { root, journal, output: join(root, 'evidence.json'), network: 'testnet', guard: 'guard.testnet' };
}
test('deterministic atomic exports preserve journal bytes and ignore incomplete snapshots', async t => {
  const f = await disk(t); const original = JSON.stringify(fixture());
  await writeFile(join(f.journal, 'invoice-1.json'), original);
  await writeFile(join(f.journal, '.pending-crash'), 'incomplete');
  await exportEvidence(f); const first = await readFile(f.output, 'utf8');
  await exportEvidence(f);
  const next = JSON.parse(await readFile(f.output, 'utf8'));
  const prior = JSON.parse(first);
  assert.ok(Number.isFinite(Date.parse(next.generated_at)));
  next.generated_at = prior.generated_at;
  assert.deepEqual(next, prior);
  assert.equal(await readFile(join(f.journal, 'invoice-1.json'), 'utf8'), original);
  assert.deepEqual((await readdir(f.root)).sort(), ['evidence.json', 'journal']);
});
test('duplicates and malformed journals fail without replacing previous output', async t => {
  const f = await disk(t); await writeFile(f.output, 'previous');
  await writeFile(join(f.journal, 'a.json'), JSON.stringify(fixture()));
  await writeFile(join(f.journal, 'b.json'), JSON.stringify(fixture()));
  await assert.rejects(exportEvidence(f)); assert.equal(await readFile(f.output, 'utf8'), 'previous');
  await writeFile(join(f.journal, 'b.json'), '{');
  await assert.rejects(exportEvidence(f)); assert.equal(await readFile(f.output, 'utf8'), 'previous');
  for (const e of [null, {}, { ...fixture(), version: 99 }, { ...fixture(), events: null }]) assert.throws(() => project(e));
});
test('safe paths reject journal writes, symlinks, hardlinks, relative and absent output parents', async t => {
  const f = await disk(t);
  await assert.rejects(exportEvidence({ ...f, output: join(f.journal, 'export.json') }));
  await assert.rejects(exportEvidence({ ...f, output: 'relative.json' }));
  await assert.rejects(exportEvidence({ ...f, output: join(f.root, 'missing', 'export.json') }));
  await writeFile(join(f.root, 'victim.json'), 'preserved');
  await symlink(join(f.root, 'victim.json'), f.output);
  await assert.rejects(exportEvidence(f)); assert.equal(await readFile(f.output, 'utf8'), 'preserved');
  await symlink(f.journal, join(f.root, 'alias'));
  await assert.rejects(exportEvidence({ ...f, journal: join(f.root, 'alias') }));
  await link(join(f.root, 'victim.json'), join(f.journal, 'a.json'));
  await assert.rejects(exportEvidence({ ...f, output: join(f.root, 'other.json') }));
});
test('empty journal exports a v2 deployment envelope; CLI arguments are explicit', async t => {
  const f = await disk(t); assert.equal(await exportEvidence(f), 0);
  const payload = JSON.parse(await readFile(f.output, 'utf8'));
  assert.ok(Number.isFinite(Date.parse(payload.generated_at)));
  assert.deepEqual(payload, { schema: 'payguard.evidence.v2', network: 'testnet', guard_id: 'guard.testnet',
    generated_at: payload.generated_at, source: 'runner_journal', records: [] });
  assert.deepEqual(parseArgs(['--journal', f.journal, '--output', f.output, '--network', 'testnet', '--guard', 'guard.testnet']),
    { journal: f.journal, output: f.output, network: 'testnet', guard: 'guard.testnet' });
  for (const args of [[], ['--journal', f.journal], ['--rpc', 'url'], ['--journal', f.journal, '--journal', f.journal]]) assert.throws(() => parseArgs(args));
});

test('v2 schema validation: complete envelope, required nullable fields and conservative types', async t => {
  const f = await disk(t);
  await writeFile(join(f.journal, 'a.json'), JSON.stringify(fixture()));
  const pending = fixture(); pending.intent.payment.request_id = 'invoice-0'; pending.events = [];
  await writeFile(join(f.journal, 'z.json'), JSON.stringify(pending));
  await exportEvidence(f);
  const value = JSON.parse(await readFile(f.output, 'utf8'));
  assert.deepEqual(Object.keys(value).sort(), ['schema', 'network', 'guard_id', 'generated_at', 'source', 'records'].sort());
  assert.equal(value.schema, 'payguard.evidence.v2');
  assert.equal(value.network, 'testnet'); assert.equal(value.guard_id, 'guard.testnet');
  assert.equal(value.source, 'runner_journal');
  assert.equal(new Date(value.generated_at).toISOString(), value.generated_at);
  assert.deepEqual(value.records.map(r => r.request_id), ['invoice-0', 'invoice-1']);
  const fields = 'request_id scenario agent_id recipient_id token_id token_symbol token_decimals amount status reason tx_hash block_height block_timestamp_ns explorer_url settlement_receipt_id policy_id proposal_id source verified_at recipient_balance_before recipient_balance_after note'.split(' ');
  for (const r of value.records) {
    assert.deepEqual(Object.keys(r).sort(), [...fields].sort());
    for (const key of ['request_id', 'agent_id', 'recipient_id', 'token_id', 'amount', 'source', 'note']) assert.equal(typeof r[key], 'string');
    assert.match(r.amount, /^[1-9][0-9]*$/);
    assert.ok(['rejected', 'pending', 'reserved', 'settlement_failed', 'settled'].includes(r.status));
    assert.ok(r.scenario === null || ['A', 'B', 'C', 'D', 'E'].includes(r.scenario));
    assert.equal(r.policy_id, null);
    assert.ok(r.proposal_id === null || (typeof r.proposal_id === 'string' && /^[0-9]+$/.test(r.proposal_id)));
    assert.ok(r.token_decimals === null || (Number.isInteger(r.token_decimals) && r.token_decimals >= 0));
    for (const key of ['token_symbol', 'reason', 'tx_hash', 'block_timestamp_ns', 'explorer_url', 'settlement_receipt_id', 'recipient_balance_before', 'recipient_balance_after']) assert.ok(r[key] === null || typeof r[key] === 'string');
    assert.equal(r.block_height, null);
    assert.equal(r.source, 'runner_journal');
    if (r.verified_at !== null) assert.equal(new Date(r.verified_at).toISOString(), r.verified_at);
  }
  assert.equal(value.records[0].verified_at, null);
  assert.equal(value.records[1].verified_at, fixture().events[0].at);
});

test('deployment mismatches and missing deployment configuration fail atomically', async t => {
  const f = await disk(t); await writeFile(f.output, 'previous');
  await writeFile(join(f.journal, 'a.json'), JSON.stringify(fixture()));
  for (const options of [{ network: 'mainnet' }, { guard: 'other.testnet' }, { network: undefined }, { guard: undefined }, { network: 'localnet' }, { guard: 'bad/id' }]) {
    await assert.rejects(exportEvidence({ ...f, ...options }));
    assert.equal(await readFile(f.output, 'utf8'), 'previous');
  }
  const other = fixture(); other.intent.payment.request_id = 'other'; other.intent.guard = 'other.testnet';
  await writeFile(join(f.journal, 'b.json'), JSON.stringify(other));
  await assert.rejects(exportEvidence(f));
  other.intent.guard = 'guard.testnet'; other.intent.network = 'mainnet';
  await writeFile(join(f.journal, 'b.json'), JSON.stringify(other));
  await assert.rejects(exportEvidence(f));
  assert.equal(await readFile(f.output, 'utf8'), 'previous');
});

test('untrusted enrichment and missing observation timestamps never fabricate verification', () => {
  const e = fixture();
  Object.assign(e.intent.payment, { scenario: 'A', token_decimals: 6, proposal_id: '2', policy_id: '2', recipient_balance_after: '40000000' });
  for (const at of [undefined, 'invalid', '2026-02-30T10:00:00.000Z']) {
    e.events[0].at = at;
    const r = project(e);
    assert.equal(r.status, 'settled'); assert.equal(r.verified_at, null);
    for (const k of ['scenario', 'token_decimals', 'proposal_id', 'policy_id', 'recipient_balance_after']) assert.equal(r[k], null);
  }
  e.events[0].data.receipts_outcome[1].outcome.receipt_ids = [guardReceipt];
  assert.equal(project(e).status, 'reserved');
});
