import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, rm, mkdir, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair, transactions, utils } from 'near-api-js';
import { runPayment, validate, parseArgs, loadAgentKey, makeRpc } from '../scripts/pay-agent.mjs';

const blockHash = utils.serialize.base_encode(new Uint8Array(32).fill(7));
const unknown = () => Object.assign(new Error('unknown transaction'), { rpcError: { cause: { name: 'UNKNOWN_TRANSACTION' } } });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'payguard-runner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = KeyPair.fromRandom('ed25519');
  const c = { network: 'testnet', rpc: 'https://rpc.testnet.near.org', guard: 'guard.testnet', agent: 'agent.testnet', requestId: 'invoice-2026-001',
    token: 'token.testnet', recipient: 'merchant.testnet', amount: '40000000', credentials: join(dir, 'agent.json'), journal: join(dir, 'journal'), mode: 'execute' };
  await writeFile(c.credentials, JSON.stringify({ account_id: c.agent, public_key: key.getPublicKey().toString(), private_key: key.toString() }), { mode: 0o600 });
  const calls = [];
  const state = { permission: { FunctionCall: { receiver_id: c.guard, method_names: ['pay'], allowance: '1000000000000000000000000' } }, lookup: null, send: null };
  const outcome = (hash, overrides = {}) => ({ final_execution_status: 'FINAL', transaction: { hash, signer_id: c.agent, receiver_id: c.guard },
    status: { SuccessValue: '' }, transaction_outcome: { id: hash, outcome: { status: { SuccessReceiptId: 'receipt-1' } } },
    receipts_outcome: [{ id: 'receipt-1', block_hash: blockHash, outcome: { executor_id: c.guard, logs: [], status: { SuccessValue: '' } } }], receipts: [{ receipt_id: 'receipt-1' }], ...overrides });
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'status') return { chain_id: state.chain ?? 'testnet', sync_info: { syncing: false } };
    if (method === 'block') {
      if (state.blockError) throw new Error('block unavailable');
      return { header: { hash: blockHash, height: params.finality ? (state.height ?? 100) : 100 } };
    }
    if (method === 'EXPERIMENTAL_protocol_config') return { transaction_validity_period: state.period ?? 86400 };
    if (method === 'query') {
      assert.equal(params.block_id, blockHash);
      if (params.request_type === 'call_function') return { result: [...Buffer.from(JSON.stringify({ agent_id: state.agent ?? c.agent }))] };
      return { nonce: state.nonce ?? 1, permission: state.permission };
    }
    if (method === 'tx_status') { if (state.lookup) return state.lookup(params); throw unknown(); }
    if (method === 'send_tx') {
      const saved = JSON.parse(await readFile(join(c.journal, `${c.requestId}.json`), 'utf8'));
      assert.equal(saved.signed_transaction, params.signed_tx_base64); // persisted BEFORE broadcast
      assert.equal(saved.intent.payment.request_id, c.requestId);
      const signed = transactions.SignedTransaction.decode(Buffer.from(params.signed_tx_base64, 'base64'));
      assert.equal(signed.transaction.receiverId, c.guard);
      assert.equal(signed.transaction.signerId, c.agent);
      const [action] = signed.transaction.actions;
      assert.equal(signed.transaction.actions.length, 1);
      assert.equal(action.functionCall.methodName, 'pay');
      assert.equal(action.functionCall.gas, 80_000_000_000_000n);
      assert.equal(action.functionCall.deposit, 0n);
      assert.deepEqual(JSON.parse(Buffer.from(action.functionCall.args).toString()), saved.intent.payment);
      if (state.send) return state.send(params, saved);
      return outcome(saved.transaction_hash);
    }
    assert.fail(`Unexpected RPC ${method}`);
  };
  const journal = async () => JSON.parse(await readFile(join(c.journal, `${c.requestId}.json`), 'utf8'));
  return { c, key, calls, state, rpc, outcome, journal };
}
test('dry-run defaults to read-only preflight, no journal/signing/broadcast', async t => {
  const f = await fixture(t);
  const result = await runPayment({ ...f.c, mode: undefined }, { rpc: f.rpc });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.deposit, '0');
  assert.equal(f.calls.some(x => ['send_tx', 'tx_status'].includes(x.method)), false);
  await assert.rejects(access(f.c.journal), { code: 'ENOENT' });
});
test('signs only pay with exact large integer strings; saves full final evidence without private key', async t => {
  const f = await fixture(t); f.c.amount = '340282366920938463463374607431768211455';
  const result = await runPayment(f.c, { rpc: f.rpc });
  assert.equal(result.state, 'succeeded');
  const entry = await f.journal();
  assert.equal(entry.intent.payment.amount, f.c.amount);
  assert.equal(entry.events.at(-1).data.receipts_outcome.length, 1);
  assert.equal(JSON.stringify(entry).includes(f.key.toString()), false);
  assert.equal(JSON.stringify(result).includes(entry.signed_transaction), false);
  const before = f.calls.length;
  assert.equal((await runPayment(f.c, { rpc: f.rpc })).transaction_hash, result.transaction_hash);
  assert.equal(f.calls.slice(before).some(x => x.method === 'send_tx'), false);
});
test('timeout then restart reconciles original hash without rebroadcast', async t => {
  const f = await fixture(t);
  f.state.send = async () => { throw new Error('timeout'); };
  const first = await runPayment(f.c, { rpc: f.rpc });
  assert.equal(first.state, 'uncertain');
  f.state.lookup = async p => f.outcome(p.tx_hash);
  const next = await runPayment(f.c, { rpc: f.rpc });
  assert.equal(next.state, 'succeeded'); assert.equal(next.transaction_hash, first.transaction_hash);
  assert.equal(f.calls.filter(x => x.method === 'send_tx').length, 1);
});
test('explicit unknown on retry rebroadcasts identical signed bytes and nonce', async t => {
  const f = await fixture(t);
  f.state.send = async () => { throw new Error('connection lost'); };
  await runPayment(f.c, { rpc: f.rpc });
  const first = await f.journal(); f.state.nonce = 9;
  f.state.send = null;
  const result = await runPayment({ ...f.c, authorizeRebroadcast: first.transaction_hash }, { rpc: f.rpc });
  assert.equal(result.state, 'succeeded'); assert.equal(result.transaction_hash, first.transaction_hash);
  assert.equal((await f.journal()).signed_transaction, first.signed_transaction);
  assert.equal(f.calls.filter(x => x.method === 'send_tx').length, 2);
});
test('reconcile mode never broadcasts; RPC errors and nonfinal outcomes never trigger broadcast', async t => {
  const f = await fixture(t);
  f.state.send = async () => { throw new Error('timeout'); };
  await runPayment(f.c, { rpc: f.rpc });
  assert.equal((await runPayment({ ...f.c, mode: 'reconcile' }, { rpc: f.rpc })).state, 'uncertain');
  f.state.lookup = async () => { throw new Error('UNKNOWN_TRANSACTION in an unstructured message'); };
  assert.equal((await runPayment(f.c, { rpc: f.rpc })).state, 'uncertain');
  f.state.lookup = async p => f.outcome(p.tx_hash, { final_execution_status: 'EXECUTED_OPTIMISTIC' });
  assert.equal((await runPayment(f.c, { rpc: f.rpc })).state, 'uncertain');
  assert.equal(f.calls.filter(x => x.method === 'send_tx').length, 1);
});
test('final downstream failure is terminal; never releases reservation or retries', async t => {
  const f = await fixture(t);
  f.state.send = async (_, entry) => f.outcome(entry.transaction_hash, { status: { Failure: { ActionError: 'recipient_not_registered' } } });
  assert.equal((await runPayment(f.c, { rpc: f.rpc })).state, 'failed');
  assert.equal((await runPayment(f.c, { rpc: f.rpc })).state, 'failed');
  assert.equal(f.calls.filter(x => x.method === 'send_tx').length, 1);
});
test('rejects changed payload/network/guard/key for the same business ID', async t => {
  const f = await fixture(t); await runPayment(f.c, { rpc: f.rpc });
  for (const patch of [{ amount: '1' }, { recipient: 'other.testnet' }, { token: 'other.testnet' }]) {
    await assert.rejects(runPayment({ ...f.c, ...patch }, { rpc: f.rpc }), /bound/);
  }
  f.state.permission.FunctionCall.receiver_id = 'other.testnet';
  await assert.rejects(runPayment({ ...f.c, guard: 'other.testnet' }, { rpc: f.rpc }), /bound/);
  f.state.permission.FunctionCall.receiver_id = f.c.guard;
  await assert.rejects(runPayment(f.c, { rpc: f.rpc, key: KeyPair.fromRandom('ed25519') }), /bound/);
});
test('rejects FullAccess, broad methods, wrong receiver, unlimited/zero allowance, wrong network/agent and unsafe nonce', async t => {
  const f = await fixture(t);
  for (const permission of ['FullAccess', { FunctionCall: { receiver_id: f.c.guard, method_names: [], allowance: '1' } },
    { FunctionCall: { receiver_id: f.c.guard, method_names: ['pay', 'set_policy'], allowance: '1' } },
    { FunctionCall: { receiver_id: 'other.testnet', method_names: ['pay'], allowance: '1' } },
    ...[null, '0'].map(allowance => ({ FunctionCall: { receiver_id: f.c.guard, method_names: ['pay'], allowance } }))]) {
    f.state.permission = permission;
    await assert.rejects(runPayment({ ...f.c, mode: 'dry-run' }, { rpc: f.rpc }), /restricted/);
  }
  f.state.chain = 'mainnet'; await assert.rejects(runPayment(f.c, { rpc: f.rpc }), /network/);
  f.state.chain = 'testnet'; f.state.agent = 'other.testnet'; await assert.rejects(runPayment(f.c, { rpc: f.rpc }), /identity/);
  assert.equal(f.calls.some(x => x.method === 'send_tx'), false);
});
test('validates canonical amounts and IDs; CLI requires explicit configuration and unique options', async t => {
  const f = await fixture(t);
  for (const amount of [40, '0', '-1', '1.2', '01', '1e6', '1\n', '340282366920938463463374607431768211456']) assert.throws(() => validate({ ...f.c, amount }));
  for (const patch of [{ requestId: 'bad id' }, { requestId: 'id\n' }, { network: undefined }, { guard: 'GUARD.testnet' }, { rpc: 'https://user:password@rpc.testnet.near.org' }]) assert.throws(() => validate({ ...f.c, ...patch }));
  assert.throws(() => parseArgs(['--execute', '--dry-run']));
  assert.throws(() => parseArgs(['--amount', '1', '--amount', '2']));
  assert.throws(() => parseArgs([]));
});
test('secure credential loading rejects mismatch, loose permissions, symlinks and repository paths', async t => {
  const f = await fixture(t);
  assert.equal((await loadAgentKey(f.c.credentials, f.c.agent)).toString(), f.key.toString());
  await assert.rejects(loadAgentKey(f.c.credentials, 'other.testnet'), /mismatch/);
  await chmod(f.c.credentials, 0o644); await assert.rejects(loadAgentKey(f.c.credentials, f.c.agent), /0600/);
  await chmod(f.c.credentials, 0o600);
  const alias = join(f.c.credentials, '..', 'alias.json'); await symlink(f.c.credentials, alias);
  await assert.rejects(loadAgentKey(alias, f.c.agent), /symlink/);
  await assert.rejects(loadAgentKey('package.json', f.c.agent), /outside/);
});
test('journal lock, corruption, repository location and loose directory permissions fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(runPayment({ ...f.c, journal: process.cwd() }, { rpc: f.rpc }), /outside/);
  await mkdir(f.c.journal, { mode: 0o700 });
  await writeFile(join(f.c.journal, '.runner.lock'), 'active', { mode: 0o600 });
  await assert.rejects(runPayment(f.c, { rpc: f.rpc }), /locked/);
  await rm(join(f.c.journal, '.runner.lock'));
  await writeFile(join(f.c.journal, `${f.c.requestId}.json`), '{broken', { mode: 0o600 });
  await assert.rejects(runPayment(f.c, { rpc: f.rpc }));
  await chmod(f.c.journal, 0o755); await assert.rejects(runPayment(f.c, { rpc: f.rpc }), /0700/);
  assert.equal(f.calls.some(x => x.method === 'send_tx'), false);
});
test('signed journal integrity and RPC identity mismatch fail closed', async t => {
  const f = await fixture(t);
  f.state.send = async () => { throw new Error('timeout'); };
  await runPayment(f.c, { rpc: f.rpc });
  f.state.lookup = async p => f.outcome('wrong-hash');
  await runPayment(f.c, { rpc: f.rpc });
  assert.equal((await f.journal()).state, 'uncertain');
  const entry = await f.journal(); entry.transaction_hash = 'tampered';
  await writeFile(join(f.c.journal, `${f.c.requestId}.json`), JSON.stringify(entry));
  await assert.rejects(runPayment(f.c, { rpc: f.rpc }), /integrity/);
  assert.equal(f.calls.filter(x => x.method === 'send_tx').length, 1);
});
test('RPC errors cannot leak private keys or signed bytes into evidence', async t => {
  const f = await fixture(t);
  f.state.send = async params => { throw new Error(`error ${f.key.toString()} ${params.signed_tx_base64}`); };
  await runPayment(f.c, { rpc: f.rpc });
  const entry = await f.journal();
  const events = JSON.stringify(entry.events);
  assert.equal(events.includes(f.key.toString()), false);
  assert.equal(events.includes(entry.signed_transaction), false);
});
test('final receipt failure overrides outer success; missing evidence stays uncertain', async t => {
  const f = await fixture(t);
  f.state.send = async (_, entry) => f.outcome(entry.transaction_hash, { receipts_outcome: [{ id: 'ft', outcome: { status: { Failure: { ActionError: 'token panic' } } } }] });
  assert.equal((await runPayment(f.c, { rpc: f.rpc })).state, 'failed');
  f.c.requestId = 'another-business-request';
  f.state.send = async (_, entry) => f.outcome(entry.transaction_hash, { receipts_outcome: [] });
  assert.equal((await runPayment(f.c, { rpc: f.rpc })).state, 'uncertain');
});
test('prepared request resumes after crash before signing; reconcile cannot create an intent', async t => {
  const f = await fixture(t);
  await assert.rejects(runPayment({ ...f.c, mode: 'reconcile' }, { rpc: f.rpc }), /No journal/);
  await writeFile(join(f.c.journal, `${f.c.requestId}.json`), JSON.stringify({ version: 1,
    intent: { network: f.c.network, guard: f.c.guard, agent: f.c.agent, payment: { request_id: f.c.requestId, token_id: f.c.token, recipient_id: f.c.recipient, amount: f.c.amount } },
    public_key: f.key.getPublicKey().toString(), state: 'prepared', events: [] }), { mode: 0o600 });
  assert.equal((await runPayment(f.c, { rpc: f.rpc })).state, 'succeeded');
});
test('concurrent invocations serialize before nonce lookup and signing', async t => {
  const f = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.state.send = async (_, entry) => { entered(); await gate; return f.outcome(entry.transaction_hash); };
  const first = runPayment(f.c, { rpc: f.rpc });
  await ready;
  try { await assert.rejects(runPayment(f.c, { rpc: f.rpc }), /locked/); }
  finally { release(); }
  assert.equal((await first).state, 'succeeded');
  assert.equal(f.calls.filter(x => x.method === 'send_tx').length, 1);
});
test('unsafe nonce is rejected; journal cannot be redirected into repository by symlink', async t => {
  const f = await fixture(t);
  f.state.nonce = Number.MAX_SAFE_INTEGER + 1;
  await assert.rejects(runPayment(f.c, { rpc: f.rpc }), /nonce/);
  f.state.nonce = 1;
  const alias = join(f.c.journal, '..', 'repo-alias'); await symlink(process.cwd(), alias);
  await assert.rejects(runPayment({ ...f.c, journal: join(alias, 'should-not-create') }, { rpc: f.rpc }), /outside/);
});
test('HTTP RPC transport encodes JSON and exposes structured errors without retries', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++; assert.equal(url, 'https://rpc.testnet.near.org');
    assert.equal(JSON.parse(options.body).method, 'tx_status');
    return { ok: true, json: async () => ({ error: { cause: { name: 'UNKNOWN_TRANSACTION' }, message: 'missing' } }) };
  });
  await assert.rejects(makeRpc('https://rpc.testnet.near.org')('tx_status', {}), e => e.rpcError.cause.name === 'UNKNOWN_TRANSACTION');
  assert.equal(calls, 1);
});
test('valid JSON corruption cannot erase signed state or re-create a business request', async t => {
  const f = await fixture(t);
  f.state.send = async () => { throw new Error('timeout'); };
  await runPayment(f.c, { rpc: f.rpc });
  const entry = await f.journal();
  const path = join(f.c.journal, `${f.c.requestId}.json`);
  for (const value of [null, false, [], { ...entry, signed_transaction: undefined }, { ...entry, state: 'unknown-state' }]) {
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(runPayment(f.c, { rpc: f.rpc }));
  }
  assert.equal(f.calls.filter(x => x.method === 'send_tx').length, 1);
});
test('dry-run DNS failure identifies status transport without exposing raw errors or retrying', async t => {
  const f = await fixture(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new TypeError(`fetch failed ${f.key.toString()} sensitive payload`, { cause: Object.assign(new Error('sensitive DNS details'), { code: 'EAI_AGAIN' }) });
  });
  await assert.rejects(runPayment({ ...f.c, mode: 'dry-run' }), e => {
    assert.equal(e.safeMessage, 'Preflight status: RPC transport: EAI_AGAIN');
    assert.equal(e.message.includes(f.key.toString()), false);
    return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(access(f.c.journal), { code: 'ENOENT' });
});
test('dry-run ignores existing locked, malformed, loose-permission journal', async t => {
  const f = await fixture(t);
  await mkdir(f.c.journal, { mode: 0o755 });
  await writeFile(join(f.c.journal, '.runner.lock'), 'sensitive lock contents');
  const path = join(f.c.journal, `${f.c.requestId}.json`);
  await writeFile(path, 'sensitive malformed journal');
  assert.equal((await runPayment({ ...f.c, mode: 'dry-run' }, { rpc: f.rpc })).mode, 'dry-run');
  assert.equal(await readFile(path, 'utf8'), 'sensitive malformed journal');
  assert.deepEqual(f.calls.map(x => x.method), ['status', 'block', 'query', 'query']);
});
test('preflight RPC errors identify the exact operation and only disclose numeric codes', async t => {
  const f = await fixture(t);
  for (const target of ['block', 'get_config', 'view_access_key']) {
    t.mock.method(globalThis, 'fetch', async (_, options) => {
      const { method, params } = JSON.parse(options.body);
      const operation = params.method_name ?? params.request_type ?? method;
      if (operation === target) return { ok: true, json: async () => ({ error: { code: -32000, message: f.key.toString(), data: 'sensitive signed bytes' } }) };
      return { ok: true, json: async () => ({ result: await f.rpc(method, params) }) };
    });
    const label = { block: 'finalized block', get_config: 'guard get_config', view_access_key: 'agent view_access_key' }[target];
    await assert.rejects(runPayment({ ...f.c, mode: 'dry-run' }), e => e.safeMessage === `Preflight ${label}: RPC error code -32000`);
  }
});
test('missing or malformed credential and invalid RPC JSON produce safe diagnostics', async t => {
  const f = await fixture(t);
  await assert.rejects(runPayment({ ...f.c, credentials: join(f.c.journal, 'missing'), mode: 'dry-run' }), e => e.safeMessage === 'Credential loading: ENOENT');
  await writeFile(f.c.credentials, `{"private_key":"${f.key.toString()}" broken`);
  await assert.rejects(runPayment({ ...f.c, mode: 'dry-run' }), e => e.safeMessage === 'Credential loading: Credential is not valid JSON');
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => { throw new SyntaxError(f.key.toString()); } }));
  await assert.rejects(runPayment({ ...f.c, mode: 'dry-run' }, { key: f.key }), e => e.safeMessage === 'Preflight status: RPC response is not valid JSON');
});

// Preload fetch in a fresh process so the real entry point, argv and output run.
test('actual CLI and npm dry-run serialize nonce and keep diagnostics secret-free', async t => {
  const f = await fixture(t);
  const preload = join(f.c.credentials, '..', 'mock-rpc.mjs');
  await writeFile(preload, `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (_, options) => {
      const { method, params } = JSON.parse(options.body);
      appendFileSync(process.env.CLI_CALLS, method + '\\n');
      if (process.env.CLI_ERROR) throw new Error(process.env.CLI_SECRET);
      let result;
      if (method === 'status') result = { chain_id: 'testnet', sync_info: { syncing: false } };
      else if (method === 'block') result = { header: { hash: ${JSON.stringify(blockHash)} } };
      else if (method === 'query' && params.request_type === 'call_function')
        result = { result: [...Buffer.from(JSON.stringify({ agent_id: 'agent.testnet' }))] };
      else if (method === 'query' && params.request_type === 'view_access_key')
        result = { nonce: Number.MAX_SAFE_INTEGER, permission: { FunctionCall: {
          receiver_id: 'guard.testnet', method_names: ['pay'], allowance: '1'
        } } };
      else throw new Error('Unexpected RPC');
      return { ok: true, json: async () => ({ result }) };
    };
  `);
  const args = Object.entries({ network: f.c.network, rpc: f.c.rpc, guard: f.c.guard,
    agent: f.c.agent, 'request-id': f.c.requestId, token: f.c.token, recipient: f.c.recipient,
    amount: f.c.amount, credentials: f.c.credentials, journal: f.c.journal })
    .flatMap(([name, value]) => ['--' + name, value]).concat('--dry-run');
  const calls = join(f.c.credentials, '..', 'calls');
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const env = { ...process.env, NODE_OPTIONS: `--import=${preload}`, CLI_CALLS: calls,
    CLI_SECRET: f.key.toString(), CLI_ERROR: '' };
  const launch = promisify(execFile);
  for (const [command, prefix] of [[process.execPath, ['scripts/pay-agent.mjs']],
    ['npm', ['run', '--silent', 'pay:agent', '--']]]) {
    await writeFile(calls, '');
    const { stdout, stderr } = await launch(command, [...prefix, ...args], { cwd, env });
    assert.ok(stdout.trim(), `${command} returned empty output; stderr: ${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.nonce, '9007199254740992');
    assert.equal(result.intent.payment.request_id, f.c.requestId);
    assert.equal(stderr, '');
    assert.equal(stdout.includes(f.key.toString()), false);
    assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n'), ['status', 'block', 'query', 'query']);
  }
  await assert.rejects(launch(process.execPath, ['scripts/pay-agent.mjs', ...args], {
    cwd, env: { ...env, CLI_ERROR: '1' },
  }), error => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /Preflight status: RPC transport: operation failed \(details withheld\)/);
    assert.equal(error.stderr.includes(f.key.toString()), false);
    return true;
  });
  await assert.rejects(access(f.c.journal), { code: 'ENOENT' });
});

test('HTTP 408 before broadcast remains unresolved across restart; unknown needs authorization', async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 408 }));
  f.state.lookup = () => makeRpc(f.c.rpc)('tx_status');
  const first = await runPayment(f.c, { rpc: f.rpc });
  const original = await f.journal();
  assert.equal(first.recovery.lookup, 'rpc_error');
  assert.equal(first.state, 'uncertain');
  assert.equal(f.calls.filter(c => c.method === 'send_tx').length, 0);
  f.state.lookup = null;
  const next = await runPayment(f.c, { rpc: f.rpc });
  assert.equal(next.recovery.lookup, 'unknown_transaction');
  assert.equal(next.transaction_hash, first.transaction_hash);
  assert.equal((await f.journal()).signed_transaction, original.signed_transaction);
  assert.deepEqual((await f.journal()).events.slice(0, original.events.length), original.events);
  assert.equal(f.calls.filter(c => c.method === 'send_tx').length, 0);
  await assert.rejects(runPayment({ ...f.c, authorizeRebroadcast: blockHash }, { rpc: f.rpc }), /hash mismatch/);
  const result = await runPayment({ ...f.c, authorizeRebroadcast: first.transaction_hash }, { rpc: f.rpc });
  assert.equal(result.state, 'succeeded');
  assert.equal(f.calls.filter(c => c.method === 'send_tx').length, 1);
});

test('protocol expiry boundary blocks even authorized retry and retains signed evidence', async t => {
  const f = await fixture(t);
  f.state.lookup = async () => { throw new Error('timeout'); };
  const first = await runPayment(f.c, { rpc: f.rpc });
  const original = await f.journal();
  f.state.lookup = null;
  f.state.period = 3542;
  f.state.height = 3642;
  const boundary = await runPayment({ ...f.c, mode: 'reconcile' }, { rpc: f.rpc });
  assert.equal(boundary.recovery.validity.status, 'within_validity_window');
  f.state.height++;
  const expired = await runPayment({ ...f.c, authorizeRebroadcast: first.transaction_hash }, { rpc: f.rpc });
  assert.equal(expired.recovery.validity.status, 'expired');
  assert.equal(expired.state, 'uncertain');
  assert.equal(expired.transaction_hash, first.transaction_hash);
  assert.equal((await f.journal()).signed_transaction, original.signed_transaction);
  assert.equal(f.calls.some(c => c.method === 'send_tx'), false);
  f.state.lookup = async p => f.outcome(p.tx_hash);
  assert.equal((await runPayment({ ...f.c, mode: 'reconcile' }, { rpc: f.rpc })).state, 'succeeded');
});

test('unavailable validity evidence prevents authorized broadcast', async t => {
  const f = await fixture(t);
  f.state.lookup = async () => { throw new Error('timeout'); };
  const first = await runPayment(f.c, { rpc: f.rpc });
  f.state.lookup = null;
  const rpc = (method, params) => method === 'EXPERIMENTAL_protocol_config' ? Promise.reject(new Error('timeout')) : f.rpc(method, params);
  const result = await runPayment({ ...f.c, authorizeRebroadcast: first.transaction_hash }, { rpc });
  assert.equal(result.recovery.validity.status, 'unresolved');
  assert.equal(f.calls.some(c => c.method === 'send_tx'), false);
});

test('3542 blocks is not an arbitrary expiry threshold; canonical forks and malformed config fail closed', async t => {
  const f = await fixture(t);
  f.state.lookup = async () => { throw new Error('timeout'); };
  const first = await runPayment(f.c, { rpc: f.rpc });
  f.state.lookup = null;
  f.state.height = 3642;
  const result = await runPayment({ ...f.c, mode: 'reconcile' }, { rpc: f.rpc });
  assert.equal(result.recovery.validity.status, 'within_validity_window');
  assert.equal(result.recovery.validity.transaction_validity_period, 86400);
  for (const period of [undefined, null, -1, 0, '86400', Number.MAX_SAFE_INTEGER + 1]) {
    const rpc = (method, params) => method === 'EXPERIMENTAL_protocol_config'
      ? Promise.resolve({ transaction_validity_period: period }) : f.rpc(method, params);
    const invalid = await runPayment({ ...f.c, authorizeRebroadcast: first.transaction_hash }, { rpc });
    assert.equal(invalid.recovery.validity.status, 'unresolved');
  }
  const rpc = (method, params) => method === 'block' && typeof params.block_id === 'number'
    ? Promise.resolve({ header: { hash: 'fork', height: 100 } }) : f.rpc(method, params);
  const fork = await runPayment({ ...f.c, authorizeRebroadcast: first.transaction_hash }, { rpc });
  assert.equal(fork.recovery.validity.status, 'unresolved');
  assert.equal(f.calls.some(c => c.method === 'send_tx'), false);
});

test('rebroadcast authorization is invocation scoped and forbidden in read-only modes', async t => {
  const f = await fixture(t);
  f.state.send = async () => { throw new Error('timeout'); };
  const first = await runPayment(f.c, { rpc: f.rpc });
  await runPayment({ ...f.c, authorizeRebroadcast: first.transaction_hash }, { rpc: f.rpc });
  assert.equal((await f.journal()).events.filter(e => e.type === 'broadcast_attempt').at(-1).data.authorization, 'explicit_hash');
  await runPayment(f.c, { rpc: f.rpc });
  assert.equal(f.calls.filter(c => c.method === 'send_tx').length, 2);
  for (const mode of ['dry-run', 'reconcile']) {
    await assert.rejects(runPayment({ ...f.c, mode, authorizeRebroadcast: first.transaction_hash }, { rpc: f.rpc }), /authorization/);
  }
});

for (const scenario of ['unknown', 'nonfinal', 'success', 'failure', 'timeout-none', 'timeout-final', 'unknown-final', 'malformed-none', 'malformed-final', 'identity-none', 'identity-final']) {
  test(`two-stage reconciliation: ${scenario}`, async t => {
    const f = await fixture(t);
    // Persist an uncertain signed entry with zero broadcast attempts.
    f.state.lookup = async () => { throw new Error('HTTP 408'); };
    const first = await runPayment(f.c, { rpc: f.rpc });
    const original = await f.journal();
    const start = f.calls.length;
    f.state.lookup = async p => {
      const final = p.wait_until === 'FINAL';
      if (scenario === 'unknown' || (scenario === 'unknown-final' && final)) throw unknown();
      if (scenario === `timeout-${final ? 'final' : 'none'}`) throw new Error('HTTP 408');
      if (scenario === `malformed-${final ? 'final' : 'none'}`) return {};
      if (scenario === `identity-${final ? 'final' : 'none'}`) return f.outcome('wrong-hash');
      if (!final) return f.outcome(p.tx_hash); // Even final-looking NONE evidence needs FINAL.
      if (scenario === 'nonfinal') return f.outcome(p.tx_hash, { final_execution_status: 'EXECUTED_OPTIMISTIC' });
      if (scenario === 'failure') return f.outcome(p.tx_hash, {
        receipts_outcome: [{ outcome: { status: { Failure: { ActionError: 'failed transfer' } } } }],
      });
      return f.outcome(p.tx_hash);
    };
    // Authorization must not overcome transport, malformed, nonfinal or contradictory evidence.
    const result = await runPayment({ ...f.c, ...(scenario === 'unknown' ? { mode: 'reconcile' } : { authorizeRebroadcast: first.transaction_hash }) }, { rpc: f.rpc });
    const lookups = f.calls.slice(start).filter(c => c.method === 'tx_status');
    const onlyNone = ['unknown', 'timeout-none', 'malformed-none', 'identity-none'].includes(scenario);
    assert.deepEqual(lookups.map(c => c.params.wait_until), onlyNone ? ['NONE'] : ['NONE', 'FINAL']);
    assert.ok(lookups.every(c => c.params.tx_hash === first.transaction_hash && c.params.sender_account_id === f.c.agent));
    assert.equal(result.state, scenario === 'success' ? 'succeeded' : scenario === 'failure' ? 'failed' : 'uncertain');
    assert.equal(result.recovery.lookup, scenario === 'unknown' ? 'unknown_transaction' : scenario === 'nonfinal' ? 'nonfinal' : ['success', 'failure'].includes(scenario) ? 'confirmed' : 'rpc_error');
    const saved = await f.journal();
    assert.equal(saved.signed_transaction, original.signed_transaction);
    assert.equal(saved.intent.payment.request_id, original.intent.payment.request_id);
    assert.deepEqual(saved.events.slice(0, original.events.length), original.events);
    assert.equal(f.calls.some(c => c.method === 'send_tx'), false);
    assert.equal(saved.events.some(e => e.type === 'broadcast_attempt'), false);
  });
}

test('RPC rejects contradictory result and structured unknown error', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ result: {}, error: { cause: { name: 'UNKNOWN_TRANSACTION' } } }) }));
  await assert.rejects(makeRpc('https://rpc.testnet.near.org')('tx_status', { wait_until: 'NONE' }), /Inconsistent RPC response/);
});
