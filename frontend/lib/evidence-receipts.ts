// Read-only evidence verification. No wallet, runner, keys or journal access.
import { ARCHIVAL_RPC_URL, NETWORK, RPC_URL, RpcError, type TxReceipt, type TxStatus } from "./near-rpc";

export type EvidenceIdentity = { hash: string; signerId: string; guardId: string };
export type EvidenceRead = (method: "status" | "tx_status" | "EXPERIMENTAL_receipt", params: Record<string, unknown>) => Promise<unknown>;
const hash = (v: unknown): v is string => typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.exec(v)?.[0] === v;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const terminal = (s: unknown) => object(s) && Object.keys(s).length === 1 &&
  ((typeof s.SuccessValue === "string") || hash(s.SuccessReceiptId) || ("Failure" in s && object(s.Failure)));
const fail = (): never => { throw new Error("Incomplete or contradictory finalized receipt evidence"); };

// Keep evidence transport as strict as main's evidenceRpc, without changing the
// general wallet/view RPC client. Malformed envelopes never trigger a success or
// a silent fallback; only explicit transport/RPC failures may try archival RPC.
export function evidenceRead(endpoint: string): EvidenceRead {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) fail();
  return async (method, params) => {
    if (!["status", "tx_status", "EXPERIMENTAL_receipt"].includes(method)) fail();
    let response: Response;
    try {
      response = await fetch(url.href, { method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ jsonrpc: "2.0", id: "payguard-evidence", method, params }) });
    } catch { throw new RpcError("Evidence RPC unavailable", "network"); }
    if (!response.ok) throw new RpcError("Evidence RPC returned an HTTP error", "network");
    let body: unknown;
    try { body = await response.json(); } catch { return fail(); }
    if (!object(body) || body.jsonrpc !== "2.0" || body.id !== "payguard-evidence" ||
        ("error" in body && "result" in body)) return fail();
    if (body.error) throw new RpcError("Evidence RPC rejected the lookup", "rpc");
    if (!body.result) return fail();
    return body.result;
  };
}

// Validate before projecting a status or fetching bodies. FINAL without all linked
// terminal outcomes is insufficient. Duplicate IDs, cycles and unrelated outcomes
// are ambiguous and never certify a payment.
export function validateEvidenceReceipts(tx: TxStatus, id: EvidenceIdentity, requireBodies = true): void {
  const t = tx?.transaction;
  if (tx?.final_execution_status !== "FINAL" || !t || t.hash !== id.hash || t.signer_id !== id.signerId || t.receiver_id !== id.guardId) fail();
  const top = tx.transaction_outcome;
  const rootIds = top?.outcome?.receipt_ids;
  if (!top || top.id !== id.hash || top.outcome?.executor_id !== id.signerId ||
      !terminal(top.outcome.status) || !object(top.outcome.status) || !("SuccessReceiptId" in top.outcome.status) ||
      !Array.isArray(rootIds) || rootIds.length !== 1 || top.outcome.status.SuccessReceiptId !== rootIds[0]) fail();
  if (!terminal(tx.status) || !Array.isArray(tx.receipts_outcome) || !tx.receipts_outcome.length) fail();
  const outcomes = tx.receipts_outcome;
  if (outcomes.some(o => !hash(o?.id) || !o.outcome || !terminal(o.outcome.status) ||
      !Array.isArray(o.outcome.receipt_ids) || o.outcome.receipt_ids.some(child => !hash(child)))) fail();
  const byId = new Map(outcomes.map(o => [o.id, o]));
  if (byId.size !== outcomes.length || byId.get(rootIds[0])?.outcome.executor_id !== id.guardId) fail();
  const seen = new Set<string>();
  const predecessors = new Map<string, string>();
  const visit = (receiptId: string, predecessor: string): void => {
    if (seen.has(receiptId)) fail();
    seen.add(receiptId);
    predecessors.set(receiptId, predecessor);
    const o = byId.get(receiptId)?.outcome;
    if (!o) return fail();
    if (object(o.status) && "SuccessReceiptId" in o.status && !o.receipt_ids.includes(o.status.SuccessReceiptId as string)) fail();
    o.receipt_ids.forEach(child => visit(child, o.executor_id));
  };
  rootIds.forEach(receiptId => visit(receiptId, id.signerId));
  if (seen.size !== outcomes.length) fail();
  const failures = outcomes.some(o => object(o.outcome.status) && "Failure" in o.outcome.status);
  if (object(tx.status) && (("Failure" in tx.status) !== failures)) fail();
  if (object(tx.status) && "SuccessReceiptId" in tx.status && !seen.has(tx.status.SuccessReceiptId as string)) fail();
  if (tx.receipts !== undefined && !Array.isArray(tx.receipts)) fail();
  const bodies = tx.receipts ?? [];
  if (new Set(bodies.map(r => r?.receipt_id)).size !== bodies.length) fail();
  for (const body of bodies) {
    const outcome = byId.get(body?.receipt_id)?.outcome;
    const action = body?.receipt?.Action;
    if (!outcome || body.receiver_id !== outcome.executor_id || !object(action) || !Array.isArray(action.actions) || !action.actions.length) return fail();
    if (body.predecessor_id !== "system" && body.predecessor_id !== predecessors.get(body.receipt_id)) fail();
    if (body.receipt_id === rootIds[0]) {
      // If RPC includes the root body, it must describe the signed transaction,
      // rather than an unrelated action with the same receipt ID.
      const actions = action.actions;
      if (body.predecessor_id !== id.signerId || actions.length !== 1 || t.actions.length !== 1) fail();
      const actual = object(actions[0]) ? actions[0].FunctionCall : null;
      const expected = object(t.actions[0]) ? t.actions[0].FunctionCall : null;
      if (!object(actual) || !object(expected) || ["method_name", "args", "deposit", "gas"].some(k => actual[k] !== expected[k])) fail();
    }
  }
  if (requireBodies) {
    for (const receiptId of new Set(outcomes.flatMap(o => o.outcome.receipt_ids))) {
      if (!bodies.some(body => body.receipt_id === receiptId)) fail();
    }
  }
}

// Same supported read-only methods as main's verify-payment-evidence.mjs. Always
// start with a fresh FINAL lookup; never stitch outcomes from separate snapshots.
export async function enrichEvidenceTransaction(id: EvidenceIdentity, read: EvidenceRead, network = NETWORK): Promise<TxStatus> {
  const status = await read("status", {});
  if (!object(status) || status.chain_id !== network) fail();
  const tx = structuredClone(await read("tx_status", {
    tx_hash: id.hash, sender_account_id: id.signerId, wait_until: "FINAL",
  })) as TxStatus;
  validateEvidenceReceipts(tx, id, false);
  tx.receipts ??= [];
  for (const receiptId of new Set(tx.receipts_outcome.flatMap(o => o.outcome.receipt_ids))) {
    if (!tx.receipts.some(r => r.receipt_id === receiptId)) {
      const body = await read("EXPERIMENTAL_receipt", { receipt_id: receiptId }) as TxReceipt;
      if (body?.receipt_id !== receiptId) fail();
      tx.receipts.push(body);
    }
  }
  validateEvidenceReceipts(tx, id);
  return tx;
}

export async function loadEvidenceTransaction(id: EvidenceIdentity): Promise<TxStatus> {
  const from = (url: string) => enrichEvidenceTransaction(id, evidenceRead(url));
  try { return await from(RPC_URL); }
  catch (error) {
    // Repeat the ENTIRE lookup/enrichment against archival RPC; do not mix providers.
    if (ARCHIVAL_RPC_URL && error instanceof RpcError && error.kind !== "contract") return from(ARCHIVAL_RPC_URL);
    throw error;
  }
}

// Main's onlyRefundChildren rule: a system native transfer, zero gas price, to
// the agent, with a successful leaf outcome. No contract callbacks are refunds.
export function onlySystemRefundChildren(tx: TxStatus, receiptId: string, agentId: string): boolean {
  const ft = tx.receipts_outcome.find(o => o.id === receiptId);
  return Array.isArray(ft?.outcome.receipt_ids) && ft.outcome.receipt_ids.every(child => {
    const bodies = (tx.receipts ?? []).filter(r => r.receipt_id === child);
    const outcome = tx.receipts_outcome.find(o => o.id === child)?.outcome;
    if (bodies.length !== 1) return false;
    const body = bodies[0], action = body.receipt.Action;
    if (!object(action) || !Array.isArray(action.actions) || action.actions.length !== 1) return false;
    const first: unknown = action.actions[0];
    const transfer = object(first) ? first.Transfer : null;
    return body.predecessor_id === "system" && body.receiver_id === agentId && action.gas_price === "0" &&
      object(transfer) && typeof transfer.deposit === "string" && /^[1-9][0-9]*$/.exec(transfer.deposit)?.[0] === transfer.deposit &&
      outcome?.executor_id === agentId && object(outcome.status) && "SuccessValue" in outcome.status &&
      Array.isArray(outcome.receipt_ids) && outcome.receipt_ids.length === 0;
  });
}
