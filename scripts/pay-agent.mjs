#!/usr/bin/env node
// Restricted-agent payments only. No account/key/policy administration.
import { constants } from 'node:fs';
import { open, realpath, mkdir, rename, unlink, lstat } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { KeyPair, InMemorySigner, transactions, utils } from 'near-api-js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GAS = 80_000_000_000_000n;
const U128_MAX = (1n << 128n) - 1n;
const fail = message => { const error = new Error(message); error.safeMessage = message; throw error; };
const exact = (s, re) => typeof s === 'string' && re.exec(s)?.[0] === s;
function account(s) {
  if (!exact(s, /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/) || s.length < 2 || s.length > 64) fail('Invalid canonical account ID');
  return s;
}
export function validate(input) {
  const { network, rpc, guard, agent, requestId, token, recipient, amount, credentials, journal } = input;
  if (!['testnet', 'mainnet'].includes(network)) fail('Explicit --network testnet or mainnet required');
  const url = new URL(rpc);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('RPC must be HTTPS without credentials, query, or fragment');
  [guard, agent, token, recipient].forEach(account);
  if (guard === agent || guard === token || guard === recipient) fail('Guard, agent, token and recipient configuration invalid');
  if (!exact(requestId, /^[A-Za-z0-9_-]{1,64}$/)) fail('Explicit stable --request-id required (1-64 letters/digits/_/-)');
  if (!exact(amount, /^[1-9][0-9]{0,38}$/) || BigInt(amount) > U128_MAX) fail('Amount must be a positive canonical u128 integer string in smallest units');
  if (!credentials || !journal) fail('Explicit external --credentials and --journal paths required');
  return { network, rpc: url.href, guard, agent, requestId, token, recipient, amount, credentials, journal };
}
export function parseArgs(args) {
  const names = { '--network': 'network', '--rpc': 'rpc', '--guard': 'guard', '--agent': 'agent', '--request-id': 'requestId', '--token': 'token', '--recipient': 'recipient', '--amount': 'amount', '--credentials': 'credentials', '--journal': 'journal' };
  const out = { mode: 'dry-run' };
  let modeSeen = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (['--execute', '--reconcile', '--dry-run'].includes(flag)) {
      if (modeSeen) fail('Choose exactly one mode');
      modeSeen = true; out.mode = flag.slice(2); continue;
    }
    const key = names[flag];
    if (!key || out[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) fail('Unknown, duplicate or incomplete CLI argument');
    out[key] = args[++i];
  }
  return { ...validate(out), mode: out.mode };
}
async function external(path) {
  const canonical = await realpath(path);
  const root = await realpath(ROOT);
  if (canonical === root || canonical.startsWith(root + sep)) fail('Credentials and journal must be outside repository');
  return canonical;
}
async function secureFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1) fail('File must be owned, regular, single-link and mode 0600 or stricter');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
export async function loadAgentKey(path, agent) {
  await external(path);
  if ((await lstat(path)).isSymbolicLink()) fail('Credential symlinks forbidden');
  const data = JSON.parse(await secureFile(path));
  if (data.account_id !== agent) fail('Credential agent account mismatch');
  const key = KeyPair.fromString(data.private_key ?? data.secret_key);
  if (!data.public_key?.startsWith('ed25519:')) fail('Only ed25519 agent keys supported');
  if (key.getPublicKey().toString() !== data.public_key) fail('Credential public key mismatch');
  return key;
}
export function makeRpc(url) {
  return async (method, params = {}) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000), body: JSON.stringify({ jsonrpc: '2.0', id: 'payguard-agent', method, params }) });
    if (!response.ok) fail(`RPC HTTP ${response.status}`);
    const json = await response.json();
    if (json.error) {
      const error = new Error(JSON.stringify(json.error));
      error.rpcError = json.error;
      throw error;
    }
    if (!Object.hasOwn(json, 'result')) fail('Malformed RPC response');
    return json.result;
  };
}
export async function preflight(c, key, rpc) {
  const status = await rpc('status');
  if (status.chain_id !== c.network || status.sync_info?.syncing !== false) fail('RPC network mismatch or syncing');
  const block = await rpc('block', { finality: 'final' });
  const query = args => rpc('query', { ...args, block_id: block.header.hash });
  const configResult = await query({ request_type: 'call_function', account_id: c.guard, method_name: 'get_config', args_base64: 'e30=' });
  const config = JSON.parse(Buffer.from(configResult.result).toString());
  if (config.agent_id !== c.agent) fail('Guard agent identity mismatch');
  const access = await query({ request_type: 'view_access_key', account_id: c.agent, public_key: key.getPublicKey().toString() });
  const permission = access.permission?.FunctionCall;
  if (!permission || permission.receiver_id !== c.guard || !Array.isArray(permission.method_names) ||
      permission.method_names.length !== 1 || permission.method_names[0] !== 'pay' ||
      !exact(permission.allowance, /^[1-9][0-9]*$/)) fail('Key must be restricted to this guard, exactly [pay], with positive finite allowance');
  if (!Number.isSafeInteger(access.nonce) || access.nonce < 0) fail('Unsafe RPC access-key nonce');
  return { blockHash: block.header.hash, nonce: BigInt(access.nonce) + 1n, publicKey: key.getPublicKey().toString(), allowance: permission.allowance };
}
const intentOf = c => ({ network: c.network, guard: c.guard, agent: c.agent,
  payment: { request_id: c.requestId, token_id: c.token, recipient_id: c.recipient, amount: c.amount } });
const stamp = () => new Date().toISOString();
function sanitizer(key, signed) {
  const secret = key.toString();
  return value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'string'
    ? v.split(secret).join('[REDACTED]').split(signed || '\u0000').join('[SIGNED_TRANSACTION]').replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/g, '[REDACTED]') : v));
}
async function journalStore(path, fn) {
  // Parent must exist: canonicalize before mkdir so repository aliases cannot bypass checks.
  const parent = await external(resolve(path, '..'));
  const directoryPath = join(parent, resolve(path).split(sep).pop());
  await mkdir(directoryPath, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
  const directory = await external(directoryPath);
  const stat = await lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('Journal directory must be owned mode 0700 and not a symlink');
  const parentHandle = await open(parent, constants.O_RDONLY);
  try { await parentHandle.sync(); } finally { await parentHandle.close(); }
  const lockPath = join(directory, '.runner.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') fail('Journal locked; do not remove lock until previous runner is confirmed stopped'); throw e; }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, created_at: stamp() })); await lock.sync();
    return await fn({
      read: async id => {
        try {
          const value = JSON.parse(await secureFile(join(directory, `${id}.json`)));
          if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Malformed journal entry');
          return value;
        }
        catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      },
      save: async entry => {
        const temp = join(directory, `.pending-${randomUUID()}`);
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(entry, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
        await rename(temp, join(directory, `${entry.intent.payment.request_id}.json`));
        const dir = await open(directory, constants.O_RDONLY);
        try { await dir.sync(); } finally { await dir.close(); }
      },
    });
  } finally { await lock.close(); await unlink(lockPath); }
}
export function classify(outcome, entry) {
  if (outcome?.transaction?.hash !== entry.transaction_hash || outcome.transaction.signer_id !== entry.intent.agent ||
      outcome.transaction.receiver_id !== entry.intent.guard) fail('RPC transaction identity mismatch');
  if (outcome.final_execution_status !== 'FINAL') return 'uncertain';
  if (!outcome.transaction_outcome?.outcome || !Array.isArray(outcome.receipts_outcome) || outcome.receipts_outcome.length === 0) return 'uncertain';
  const statuses = [outcome.status, outcome.transaction_outcome.outcome.status, ...outcome.receipts_outcome.map(r => r.outcome?.status)];
  if (statuses.some(s => !s || typeof s !== 'object' || !['SuccessValue', 'SuccessReceiptId', 'Failure'].some(k => Object.hasOwn(s, k)))) return 'uncertain';
  if (statuses.some(s => Object.hasOwn(s, 'Failure'))) return 'failed';
  return Object.hasOwn(outcome.status, 'SuccessValue') ? 'succeeded' : 'uncertain';
}
function unknownTransaction(error) {
  // Only an explicit structured RPC classification permits rebroadcast. Never infer from message text.
  return error.rpcError?.cause?.name === 'UNKNOWN_TRANSACTION' || error.rpcError?.data?.name === 'UNKNOWN_TRANSACTION';
}
export async function runPayment(input, { rpc, key } = {}) {
  const c = validate(input);
  const mode = input.mode ?? 'dry-run';
  if (!['dry-run', 'execute', 'reconcile'].includes(mode)) fail('Invalid mode');
  key ??= await loadAgentKey(c.credentials, c.agent);
  rpc ??= makeRpc(c.rpc);
  const intent = intentOf(c);
  if (mode === 'dry-run') return { mode, intent, ...await preflight(c, key, rpc), gas: GAS.toString(), deposit: '0', note: 'Read-only preflight; no journal entry, signing or broadcast. Policy/transfer success is not guaranteed.' };
  return journalStore(c.journal, async store => {
    const check = await preflight(c, key, rpc);
    let entry = await store.read(c.requestId);
    if (entry && (entry.version !== 1 || JSON.stringify(entry.intent) !== JSON.stringify(intent) || entry.public_key !== check.publicKey)) fail('Request ID already bound to different intent/key or unsupported journal');
    if (!entry) {
      if (mode === 'reconcile') fail('No journal entry for request ID');
      entry = { version: 1, intent, public_key: check.publicKey, created_at: stamp(), state: 'prepared', events: [] };
      await store.save(entry); // Business intent durable BEFORE signing or broadcast.
    }
    if (!Array.isArray(entry.events) || !['prepared', 'signed', 'uncertain', 'succeeded', 'failed'].includes(entry.state) ||
        (entry.state === 'prepared' ? entry.signed_transaction || entry.transaction_hash : !entry.signed_transaction || !entry.transaction_hash)) fail('Inconsistent journal state; refusing fresh signature');
    if (['succeeded', 'failed'].includes(entry.state)) { verifySignedEntry(entry, key); return summary(entry); }
    if (!entry.signed_transaction && mode === 'execute') {
      const signer = await InMemorySigner.fromKeyPair(c.network, c.agent, key);
      const [hash, signed] = await transactions.signTransaction(c.guard, check.nonce,
        [transactions.functionCall('pay', intent.payment, GAS, 0n)], utils.serialize.base_decode(check.blockHash), signer, c.agent, c.network);
      entry.transaction_hash = utils.serialize.base_encode(hash);
      entry.signed_transaction = Buffer.from(signed.encode()).toString('base64');
      entry.state = 'signed';
      await store.save(entry); // Hash and exact retry bytes durable BEFORE network mutation.
    }
    if (!entry.signed_transaction) return summary(entry);
    verifySignedEntry(entry, key);
    const clean = sanitizer(key, entry.signed_transaction);
    const record = async (type, data) => {
      entry.events.push({ at: stamp(), rpc: c.rpc, type, data: clean(data) });
      await store.save(entry);
    };
    let mayBroadcast = false;
    try {
      const outcome = await rpc('tx_status', { tx_hash: entry.transaction_hash, sender_account_id: c.agent, wait_until: 'FINAL' });
      entry.state = classify(outcome, entry);
      await record('reconciliation', outcome);
      return summary(entry);
    } catch (error) {
      entry.state = 'uncertain';
      mayBroadcast = unknownTransaction(error);
      await record('reconciliation_error', { message: String(error.message), rpc: error.rpcError ?? null });
    }
    if (mode === 'reconcile' || !mayBroadcast) return summary(entry);
    await record('broadcast_attempt', { transaction_hash: entry.transaction_hash });
    try {
      const outcome = await rpc('send_tx', { signed_tx_base64: entry.signed_transaction, wait_until: 'FINAL' });
      entry.state = classify(outcome, entry);
      await record('broadcast_outcome', outcome);
    } catch (error) {
      entry.state = 'uncertain';
      await record('broadcast_error', { message: String(error.message), rpc: error.rpcError ?? null });
    }
    return summary(entry);
  });
}
function verifySignedEntry(entry, key) {
  const signed = transactions.SignedTransaction.decode(Buffer.from(entry.signed_transaction, 'base64'));
  const tx = signed.transaction;
  const hash = new Uint8Array(createHash('sha256').update(transactions.encodeTransaction(tx)).digest());
  const action = tx.actions[0]?.functionCall;
  if (utils.serialize.base_encode(hash) !== entry.transaction_hash ||
      tx.signerId !== entry.intent.agent || tx.receiverId !== entry.intent.guard ||
      ('ed25519:' + utils.serialize.base_encode(Uint8Array.from(tx.publicKey.ed25519Key?.data ?? []))) !== key.getPublicKey().toString() || tx.actions.length !== 1 ||
      !action || action.methodName !== 'pay' || action.deposit !== 0n || action.gas !== GAS ||
      JSON.stringify(JSON.parse(Buffer.from(action.args).toString())) !== JSON.stringify(entry.intent.payment) ||
      !key.verify(hash, Uint8Array.from(signed.signature.ed25519Signature?.data ?? []))) fail('Journal signed transaction integrity mismatch');
}
function summary(entry) {
  return { request_id: entry.intent.payment.request_id, state: entry.state, transaction_hash: entry.transaction_hash ?? null,
    note: entry.state === 'failed' ? 'Final transaction/receipt failure; reservation may remain. Do not create a new business ID to bypass replay protection.' :
      entry.state === 'uncertain' ? 'Unresolved. Reconcile this ID; no fresh transaction will be signed.' : undefined };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runPayment(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    if (['failed', 'uncertain', 'prepared'].includes(result.state)) process.exitCode = result.state === 'failed' ? 1 : 2;
  } catch (error) {
    if (error.safeMessage) console.error(error.safeMessage);
    // Do not print raw SDK/filesystem errors: they can contain credential or signed payload contents.
    console.error('Payment runner stopped. Check arguments, external file permissions, journal lock, RPC network, guard identity and restricted key. No automatic fresh-transaction retry. See docs/payment-runner.md.');
    process.exitCode = 1;
  }
}
