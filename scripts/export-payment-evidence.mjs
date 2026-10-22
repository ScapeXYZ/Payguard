#!/usr/bin/env node
// Offline projection only: no SDK, credentials, signing, or network access.
import { constants } from 'node:fs';
import { open, lstat, realpath, readdir, rename, unlink } from 'node:fs/promises';
import { resolve, dirname, basename, join, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const fail = () => { throw new Error('Invalid evidence input or unsafe output path'); };
const matches = (v, re) => typeof v === 'string' && re.test(v);
const id = v => matches(v, /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/) && v.length >= 2 && v.length <= 64;
const hash = v => matches(v, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/) ? v : null;
const success = s => s && (Object.hasOwn(s, 'SuccessValue') || Object.hasOwn(s, 'SuccessReceiptId'));

export function project(entry) {
  const i = entry?.intent, p = i?.payment;
  if (entry?.version !== 1 || !p || !matches(p.request_id, /^[A-Za-z0-9_-]{1,64}$/) ||
      !['testnet', 'mainnet'].includes(i.network) || ![i.guard, i.agent, p.token_id, p.recipient_id].every(id) ||
      !matches(p.amount, /^[1-9][0-9]{0,38}$/) || BigInt(p.amount) >= 2n ** 128n ||
      !['prepared', 'signed', 'uncertain', 'succeeded', 'failed'].includes(entry.state) || !Array.isArray(entry.events)) fail();
  const r = Object.fromEntries(['scenario', 'token_symbol', 'token_decimals', 'reason', 'block_height', 'block_timestamp_ns',
    'settlement_receipt_id', 'recipient_balance_before', 'recipient_balance_after', 'verified_at', 'policy_id', 'proposal_id'].map(k => [k, null]));
  Object.assign(r, { request_id: p.request_id, network: i.network, guard_id: i.guard, agent_id: i.agent,
    recipient_id: p.recipient_id, token_id: p.token_id, amount: p.amount, tx_hash: hash(entry.transaction_hash),
    status: 'pending', source: 'runner_journal', note: 'Outcome unresolved; runner state alone does not verify settlement.' });
  // Use only the latest persisted lookup/submission outcome. Never export arbitrary logs/errors.
  const event = entry.events.filter(e => ['reconciliation', 'broadcast_outcome'].includes(e?.type)).at(-1);
  const d = event?.data;
  if (r.tx_hash && d?.transaction?.hash === r.tx_hash && d.transaction.signer_id === i.agent &&
      d.transaction.receiver_id === i.guard && d.final_execution_status === 'FINAL' && Array.isArray(d.receipts_outcome) &&
      d.receipts_outcome.every(o => typeof o?.id === 'string') &&
      new Set(d.receipts_outcome.map(o => o.id)).size === d.receipts_outcome.length) {
    const outcomes = d.receipts_outcome;
    const roots = d.transaction_outcome?.outcome?.receipt_ids ?? [];
    const guard = outcomes.find(o => roots.includes(o.id) && o.outcome?.executor_id === i.guard);
    if (guard && Object.hasOwn(guard.outcome.status ?? {}, 'Failure')) {
      r.status = 'rejected'; r.reason = 'guard_execution_failed';
    } else if (guard && success(guard.outcome.status)) {
      const transfer = (d.receipts ?? []).find(receipt => {
        if (!guard.outcome.receipt_ids?.includes(receipt.receipt_id) || receipt.predecessor_id !== i.guard || receipt.receiver_id !== p.token_id) return false;
        const actions = receipt.receipt?.Action?.actions;
        if (!Array.isArray(actions) || actions.length !== 1) return false;
        const call = actions[0]?.FunctionCall;
        if (call?.method_name !== 'ft_transfer') return false;
        try {
          const args = JSON.parse(Buffer.from(call.args, 'base64').toString('utf8'));
          return args.receiver_id === p.recipient_id && args.amount === p.amount;
        } catch { return false; }
      });
      if (transfer) {
        r.status = 'reserved';
        const ft = outcomes.find(o => o.id === transfer.receipt_id && o.outcome?.executor_id === p.token_id);
        if (Object.hasOwn(ft?.outcome?.status ?? {}, 'Failure')) {
          r.status = 'settlement_failed'; r.reason = 'ft_transfer_failed';
        } else if (Object.hasOwn(ft?.outcome?.status ?? {}, 'SuccessValue') && ft.outcome.receipt_ids?.length === 0) {
          r.status = 'settled'; r.settlement_receipt_id = hash(ft.id);
          // A receipt ID must be well formed before it can certify settlement.
          if (!r.settlement_receipt_id) r.status = 'pending';
        }
      }
    }
    if (r.status !== 'pending') {
      r.note = 'Classified from persisted FINAL RPC receipt evidence; RPC and token semantics are trusted. Balances are not reconciled.';
      if (matches(event.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) && Number.isFinite(Date.parse(event.at))) r.verified_at = event.at;
    }
  }
  r.explorer_url = r.tx_hash ? `https://${i.network === 'testnet' ? 'testnet.' : ''}nearblocks.io/txns/${r.tx_hash}` : null;
  return r;
}

export async function exportEvidence({ journal, output }) {
  if (!isAbsolute(journal ?? '') || !isAbsolute(output ?? '') || basename(output) === '.' || !output.endsWith('.json')) fail();
  if ((await lstat(journal)).isSymbolicLink() || !(await lstat(journal)).isDirectory()) fail();
  const directory = await realpath(journal);
  const parent = await realpath(dirname(output));
  const target = join(parent, basename(output));
  if (parent === directory || parent.startsWith(directory + sep) || directory.startsWith(target + sep) || target === directory) fail();
  try { const s = await lstat(target); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) fail(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const records = [], seen = new Set();
  for (const name of (await readdir(directory)).sort()) {
    if (name.startsWith('.')) continue; // Runner locks and incomplete atomic snapshots are not entries.
    if (!name.endsWith('.json')) fail();
    const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    let entry;
    try { const s = await handle.stat(); if (!s.isFile() || s.nlink !== 1 || s.size > 16 * 1024 * 1024) fail(); entry = JSON.parse(await handle.readFile('utf8')); }
    finally { await handle.close(); }
    const record = project(entry);
    if (seen.has(record.request_id)) fail();
    seen.add(record.request_id); records.push(record);
  }
  records.sort((a, b) => a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0);
  const payload = JSON.stringify({ schema_version: 1, records }, null, 2) + '\n';
  const temp = join(parent, `.evidence-${randomUUID()}`);
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(payload); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, target);
    const dir = await open(parent, constants.O_RDONLY);
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  return records.length;
}

export function parseArgs(args) {
  const result = {};
  for (let n = 0; n < args.length; n += 2) {
    const key = { '--journal': 'journal', '--output': 'output' }[args[n]];
    if (!key || result[key] || !args[n + 1]) fail();
    result[key] = args[n + 1];
  }
  if (!result.journal || !result.output) fail();
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`Exported ${await exportEvidence(parseArgs(process.argv.slice(2)))} payment evidence records.`); }
  catch { console.error('Evidence export failed. Check arguments, journal format and output path. Details withheld.'); process.exitCode = 1; }
}
