// Read-only RPC enrichment. No runner imports, keys, signing, or journal writes.
const fail = () => { throw new Error('Incomplete or inconsistent RPC evidence'); };
export function evidenceRpc(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail();
  return async (method, params = {}) => {
    if (!['status', 'tx_status', 'EXPERIMENTAL_receipt'].includes(method)) fail();
    const response = await fetch(url, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 'payguard-evidence', method, params }) });
    if (!response.ok) fail();
    const body = await response.json();
    if (body?.jsonrpc !== '2.0' || body.id !== 'payguard-evidence' || body.error || !body.result) fail();
    return body.result;
  };
}

export async function enrichEvidence(entry, rpc) {
  const { intent: i, transaction_hash: tx } = entry;
  if (!tx) return entry;
  const status = await rpc('status');
  if (status?.chain_id !== i.network) fail();
  const data = structuredClone(await rpc('tx_status', {
    tx_hash: tx, sender_account_id: i.agent, wait_until: 'FINAL',
  }));
  if (data?.transaction?.hash !== tx || data.transaction.signer_id !== i.agent ||
      data.transaction.receiver_id !== i.guard || data.final_execution_status !== 'FINAL' ||
      !Array.isArray(data.receipts_outcome) || !data.receipts_outcome.length) fail();
  const outcomes = data.receipts_outcome;
  if (new Set(outcomes.map(o => o?.id)).size !== outcomes.length ||
      outcomes.some(o => typeof o?.id !== 'string' || !o.outcome)) fail();
  if (outcomes.some(o => !Array.isArray(o.outcome.receipt_ids) ||
      o.outcome.receipt_ids.some(child => !outcomes.some(candidate => candidate.id === child)) ||
      !['SuccessValue', 'SuccessReceiptId', 'Failure'].some(key => Object.hasOwn(o.outcome.status ?? {}, key)))) fail();
  const roots = data.transaction_outcome?.outcome?.receipt_ids;
  if (!Array.isArray(roots) || roots.length !== 1) fail();
  const guard = outcomes.find(o => roots.includes(o.id) && o.outcome.executor_id === i.guard);
  if (!guard || !Array.isArray(guard.outcome.receipt_ids)) fail();
  if (data.receipts !== undefined && !Array.isArray(data.receipts)) fail();
  data.receipts ??= [];
  if (new Set(data.receipts.map(r => r?.receipt_id)).size !== data.receipts.length) fail();
  // Fetch bodies linked by finalized outcomes, never infer actions
  // from executor names. Bodies have no execution status; use FINAL outcomes.
  for (const receiptId of new Set(outcomes.flatMap(o => o.outcome.receipt_ids))) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(receiptId)) fail();
    if (!data.receipts.some(r => r?.receipt_id === receiptId)) {
      const receipt = await rpc('EXPERIMENTAL_receipt', { receipt_id: receiptId });
      if (receipt?.receipt_id !== receiptId) fail();
      data.receipts.push(receipt);
    }
  }
  return { ...entry, events: [...entry.events, {
    type: 'receipt_verification', at: new Date().toISOString(), data,
  }] };
}
