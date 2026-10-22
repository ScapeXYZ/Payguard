import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { buildDeployment, preflight, parseArgs, ROLES, GUARD, FUNDING, GAS, saveGuardKey, loadOwnerKey, verifyConfig } from '../scripts/deploy-testnet.mjs';
const key = KeyPair.fromRandom('ed25519');
const wasm = Buffer.from([0,97,115,109,1,0,0,0]);
function rpc(overrides = {}) {
  return { status: async () => ({ chain_id: 'testnet', sync_info: { syncing: false } }), block: async () => ({ header: { hash: 'final-block', height: 12 } }), query: async q => {
    assert.equal(q.block_id, 'final-block');
    if (q.request_type === 'view_access_key') { assert.equal(q.account_id, ROLES.owner_id); assert.equal(q.public_key, key.getPublicKey().toString()); return { permission: 'FullAccess' }; }
    if (q.account_id === GUARD) throw Object.assign(new Error('missing'), { type: 'AccountDoesNotExist' });
    assert.ok(Object.values(ROLES).includes(q.account_id));
    return { amount: (FUNDING * 2n).toString(), storage_usage: 100 };
  }, ...overrides };
}
test('constructs exactly the owner-to-guard sandbox action sequence', () => {
  const tx = buildDeployment(key.getPublicKey(), wasm);
  assert.equal(tx.receiverId, GUARD);
  assert.deepEqual(tx.actions.map(a => a.enum), ['createAccount','transfer','addKey','deployContract','functionCall']);
  assert.equal(tx.actions[1].transfer.deposit, FUNDING);
  assert.equal(tx.actions[2].addKey.publicKey.toString(), key.getPublicKey().toString());
  assert.equal(tx.actions[2].addKey.accessKey.permission.enum, 'fullAccess');
  assert.deepEqual(Buffer.from(tx.actions[3].deployContract.code), wasm);
  const call = tx.actions[4].functionCall;
  assert.equal(call.methodName, 'init'); assert.equal(call.gas, GAS); assert.equal(call.deposit, 0n);
  assert.deepEqual(JSON.parse(Buffer.from(call.args)), ROLES);
  assert.throws(() => buildDeployment(key.getPublicKey(), Buffer.from('bad')), /WASM/);
});
test('dry run is default and unknown flags fail closed', () => {
  assert.deepEqual(parseArgs([]), { execute: false });
  assert.deepEqual(parseArgs(['--execute']), { execute: true });
  for (const args of [['--network','mainnet'],['--execute','--execute'],['--yes']]) assert.throws(() => parseArgs(args));
});
test('preflight checks finalized testnet accounts and FullAccess owner authority', async () => {
  assert.deepEqual(await preflight(rpc(), key), { blockHash: 'final-block' });
  for (const chain_id of ['mainnet','sandbox']) await assert.rejects(preflight(rpc({ status: async () => ({ chain_id }) }), key), /testnet/);
  await assert.rejects(preflight(rpc({ status: async () => ({ chain_id: 'testnet', sync_info: { syncing: true } }) }), key));
});
test('preflight fails closed for existing guard, restricted signer, missing roles, RPC failure and low funds', async () => {
  const base = rpc();
  for (const change of [
    q => q.account_id === GUARD ? {} : base.query(q),
    q => q.request_type === 'view_access_key' ? { permission: { FunctionCall: {} } } : base.query(q),
    q => q.account_id === ROLES.guardian_id ? Promise.reject(new Error('missing role')) : base.query(q),
    q => q.account_id === GUARD ? Promise.reject(new Error('timeout')) : base.query(q),
    q => q.account_id === ROLES.owner_id && q.request_type === 'view_account' ? { amount: '1', storage_usage: 1 } : base.query(q),
  ]) await assert.rejects(preflight(rpc({ query: change }), key));
});
test('credentials and backup use restrictive files and never overwrite', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'payguard-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'owner.json');
  const credentials = { account_id: ROLES.owner_id, public_key: key.getPublicKey().toString(), private_key: key.toString() };
  await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
  assert.equal((await loadOwnerKey(path)).toString(), key.toString());
  const saved = await saveGuardKey(key, dir);
  assert.equal((await stat(saved)).mode & 0o777, 0o600);
  assert.equal((await stat(join(saved, '..'))).mode & 0o777, 0o700);
  assert.notEqual(await saveGuardKey(key, dir), saved);
  await assert.rejects(saveGuardKey(key, process.cwd()), /outside repository/);
  await writeFile(path, JSON.stringify({ ...credentials, account_id: 'wrong.testnet' }));
  await assert.rejects(loadOwnerKey(path), /mismatch/);
});
test('post-deployment config must match all four roles', async () => {
  const provider = { block: async () => ({ header: { height: 12 } }), query: async () => ({ block_height: 12, result: [...Buffer.from(JSON.stringify(ROLES))] }) };
  assert.deepEqual(await verifyConfig(provider, 12), ROLES);
  await assert.rejects(verifyConfig({ ...provider, query: async () => ({ block_height: 12, result: [...Buffer.from('{}')] }) }, 12), /mismatch/);
});
