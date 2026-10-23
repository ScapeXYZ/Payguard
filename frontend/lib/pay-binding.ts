// Binds an evidence record to the transaction it claims to describe (review F3).
// Without this, any successful guard transaction signed by the named account (a policy
// write, a sweep to the same recipient) could be re-labelled as a payment and "verify".
// Contract: contract/guard.ts `pay(input: Payment)`, Payment = { request_id, token_id,
// recipient_id, amount } (contract/policy.ts). The runner calls functionCall('pay', payment).
import type { TxStatus } from "./near-rpc";

export type PayClaim = { request_id: string; token_id: string; recipient_id: string; amount: string; agent_id: string; tx_hash: string };
export type PayBinding = { ok: true; guardReceiptId: string } | { ok: false; why: string };

const PAY_ARG_KEYS = ["amount", "recipient_id", "request_id", "token_id"];

const decodeB64Json = (b64: unknown): unknown => {
  if (typeof b64 !== "string") return null;
  try { return JSON.parse(typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("utf8")); } catch { return null; }
};

// agentId = the guard's CONFIGURED agent (get_config().agent_id), never the record's word.
export function bindPayCall(tx: TxStatus, r: PayClaim, guardId: string, agentId: string | null | undefined): PayBinding {
  const no = (why: string): PayBinding => ({ ok: false, why });
  if (!agentId) return no("the guard's configured agent is unknown, so the signer can't be checked");
  if (r.agent_id !== agentId) return no(`record names agent ${r.agent_id}, the guard's configured agent is ${agentId}`);
  const t = tx?.transaction;
  if (!t || t.hash !== r.tx_hash) return no("RPC returned a different transaction");
  if (t.signer_id !== agentId) return no(`tx was signed by ${t.signer_id}, not the configured agent ${agentId}`);
  if (t.receiver_id !== guardId) return no(`tx was sent to ${t.receiver_id}, not the guard`);
  const acts = Array.isArray(t.actions) ? t.actions : [];
  if (acts.length !== 1) return no(`tx has ${acts.length} actions; a payment is exactly one pay call`);
  const fc = (acts[0] as { FunctionCall?: { method_name?: unknown; args?: unknown; deposit?: unknown } })?.FunctionCall;
  if (!fc) return no("tx action is not a function call");
  if (fc.method_name !== "pay") return no(`tx called ${String(fc.method_name)}, not pay`);
  if (fc.deposit !== undefined && String(fc.deposit) !== "0") return no("pay call attached a deposit");
  const args = decodeB64Json(fc.args) as Record<string, unknown> | null;
  if (!args || typeof args !== "object" || Array.isArray(args)) return no("pay arguments could not be decoded");
  if (Object.keys(args).sort().join(",") !== PAY_ARG_KEYS.join(",")) return no("pay arguments are not exactly request_id, token_id, recipient_id, amount");
  for (const k of ["request_id", "token_id", "recipient_id", "amount"] as const)
    if (args[k] !== r[k]) return no(`pay ${k} on chain is ${JSON.stringify(args[k])}, record says ${r[k]}`);
  // Receipt relationship: the tx's root receipt must be executed by the guard.
  const roots = tx.transaction_outcome?.outcome?.receipt_ids ?? [];
  const g = (tx.receipts_outcome ?? []).find((o) => roots.includes(o.id) && o.outcome?.executor_id === guardId);
  if (!g) return no("no guard receipt is linked to the transaction");
  return { ok: true, guardReceiptId: g.id };
}
