#!/usr/bin/env node
// Read-only preflight by default. Usage: node scripts/deploy-testnet.mjs [--execute]
// Credentials: ~/.near-credentials/testnet/myvirusmy.testnet.json (never printed).
import { constants } from 'node:fs';
import { open, realpath, mkdtemp, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { connect, KeyPair, keyStores, providers, transactions } from 'near-api-js';

export const NETWORK = 'testnet';
export const RPC = 'https://rpc.testnet.near.org';
export const ROLES = Object.freeze({ owner_id: 'myvirusmy.testnet', agent_id: 'agent.myvirusmy.testnet', guardian_id: 'guardian.myvirusmy.testnet', exit_id: 'exit.myvirusmy.testnet' });
export const GUARD = 'guard.myvirusmy.testnet';
export const FUNDING = 7n * 10n ** 24n; // 7 NEAR for testnet deployment.
export const GAS = 30_000_000_000_000n;
const ROOT = fileURLToPath(new URL('../', import.meta.url));

export function parseArgs(args) {
  if (args.some(a => a !== '--execute') || args.length > 1) throw new Error('Usage: node scripts/deploy-testnet.mjs [--execute]');
  return { execute: args.includes('--execute') };
}

export async function loadOwnerKey(path = join(homedir(), '.near-credentials', NETWORK, `${ROLES.owner_id}.json`)) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Owner credentials must be an owned regular file with mode 0600 or stricter');
    const data = JSON.parse(await handle.readFile('utf8'));
    if (data.account_id != null && data.account_id !== ROLES.owner_id) throw new Error('Owner credential account mismatch');
    const key = KeyPair.fromString(data.private_key ?? data.secret_key);
    if (data.public_key !== key.getPublicKey().toString()) throw new Error('Owner credential public key mismatch');
    return key;
  } finally { await handle.close(); }
}

export function buildDeployment(publicKey, wasm) {
  if (!Buffer.from(wasm).subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error('Invalid WASM artifact');
  return { receiverId: GUARD, actions: [
    transactions.createAccount(), transactions.transfer(FUNDING),
    transactions.addKey(publicKey, transactions.fullAccessKey()),
    transactions.deployContract(wasm), transactions.functionCall('init', ROLES, GAS, 0n),
  ] };
}

export async function preflight(provider, ownerKey) {
  const status = await provider.status();
  if (status.chain_id !== NETWORK || status.sync_info?.syncing !== false) throw new Error('RPC must be synced testnet');
  // Use one finalized snapshot for every existence and authority check.
  const block = await provider.block({ finality: 'final' });
  const query = args => provider.query({ ...args, block_id: block.header.hash });
  const accounts = await Promise.all(Object.values(ROLES).map(account_id => query({ request_type: 'view_account', account_id })));
  const key = await query({ request_type: 'view_access_key', account_id: ROLES.owner_id, public_key: ownerKey.getPublicKey().toString() });
  if (key.permission !== 'FullAccess') throw new Error('Owner signing key must have on-chain FullAccess authority');
  try {
    await query({ request_type: 'view_account', account_id: GUARD });
  } catch (error) {
    // Fail closed for transport, permissions, malformed RPC responses, etc.
    if (error.type !== 'AccountDoesNotExist' && error.type !== 'UNKNOWN_ACCOUNT') throw error;
    const available = BigInt(accounts[0].amount) - BigInt(accounts[0].storage_usage) * 10n ** 19n;
    if (available < FUNDING + 10n ** 24n) throw new Error('Owner needs 7 NEAR funding plus 1 NEAR available fee reserve');
    return { blockHash: block.header.hash };
  }
  throw new Error('Guard already exists; refusing deployment');
}

export async function saveGuardKey(key, base = join(homedir(), '.near-credentials', NETWORK)) {
  const canonical = await realpath(base);
  const repo = await realpath(ROOT);
  if (canonical === repo || canonical.startsWith(repo + sep)) throw new Error('Guard key directory must be outside repository');
  const directory = await mkdtemp(join(canonical, 'payguard-deploy-'));
  await chmod(directory, 0o700);
  const path = join(directory, `${GUARD}.json`);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ account_id: GUARD, public_key: key.getPublicKey().toString(), private_key: key.toString() }) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  return path;
}

export async function verifyConfig(provider, minHeight) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const block = await provider.block({ finality: 'final' });
    if (block.header.height < minHeight) { await setTimeout(1000); continue; }
    const response = await provider.query({ request_type: 'call_function', account_id: GUARD, method_name: 'get_config', args_base64: 'e30=', finality: 'final' });
    if (response.block_height >= minHeight) {
      const config = JSON.parse(Buffer.from(response.result).toString());
      if (JSON.stringify(Object.keys(config).sort()) !== JSON.stringify(Object.keys(ROLES).sort()) || Object.entries(ROLES).some(([k, v]) => config[k] !== v)) throw new Error('Deployed get_config mismatch; investigate before further actions');
      return config;
    }
    await setTimeout(1000);
  }
  throw new Error('Config finality timeout; investigate before retrying');
}

export async function main(args = process.argv.slice(2)) {
  const { execute } = parseArgs(args);
  const key = await loadOwnerKey();
  const provider = new providers.JsonRpcProvider({ url: RPC });
  const artifact = await open(join(ROOT, 'build/guard.wasm'), 'r');
  let wasm;
  try { wasm = await artifact.readFile(); } finally { await artifact.close(); }
  const guardKey = KeyPair.fromRandom('ed25519');
  const deployment = buildDeployment(guardKey.getPublicKey(), wasm);
  await preflight(provider, key);
  console.log(JSON.stringify({ mode: execute ? 'EXECUTE' : 'DRY RUN', network: NETWORK, rpc: RPC, signer: ROLES.owner_id, receiver: GUARD, fundingNEAR: '7', feeReserveNEAR: '1 (not transferred)', wasmSHA256: createHash('sha256').update(wasm).digest('hex'), actions: ['CreateAccount', 'Transfer 7 NEAR', `AddKey FullAccess ${guardKey.getPublicKey()}`, `DeployContract (${wasm.length} bytes)`, { FunctionCall: 'init', args: ROLES, deposit: '0', gas: GAS.toString() }] }, null, 2));
  if (!execute) { console.log('Dry run complete. No transaction signed or broadcast; no key saved. Pass --execute to deploy.'); return; }
  const path = await saveGuardKey(guardKey);
  console.log(`Temporary guard FullAccess key saved: ${path}`);
  const store = new keyStores.InMemoryKeyStore();
  await store.setKey(NETWORK, ROLES.owner_id, key);
  const near = await connect({ networkId: NETWORK, nodeUrl: RPC, keyStore: store });
  // Repeat checks immediately before signing; never automatically retry this CLI.
  await preflight(provider, key);
  const owner = await near.account(ROLES.owner_id);
  const result = await owner.signAndSendTransaction(deployment);
  console.log(`Transaction: ${result.transaction.hash}`);
  if (!result.status || typeof result.status !== 'object' || !('SuccessValue' in result.status) || result.receipts_outcome.some(r => r.outcome.status?.Failure)) throw new Error('Deployment failed; inspect transaction and retain saved key');
  const blocks = await Promise.all(result.receipts_outcome.map(r => provider.block({ blockId: r.block_hash })));
  await verifyConfig(provider, Math.max(...blocks.map(b => b.header.height)));
  console.log('Verified get_config. Guard FullAccess key retained; guard remains unlocked.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Actual deployment error:', error?.message ?? String(error));
    // RPC/SDK errors can contain signed payloads or credential material. Do not dump them.
    console.error('Deployment stopped. Check preflight inputs and RPC state. If broadcast was attempted, inspect the owner transaction history before retrying. Retain any saved guard key.');
    process.exitCode = 1;
  });
}
