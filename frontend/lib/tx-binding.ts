import type { TxStatus } from "./near-rpc";
import { classifyTx, type Outcome } from "./tx-outcome";

export type SubmittedCall = {
  hash: string; signerId: string; receiverId: string;
  method: string; args: object; deposit: string;
};

// Object key order is irrelevant; array order, types and every argument are exact.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function submissionMismatch(tx: TxStatus, expected: SubmittedCall): string | null {
  if (tx?.final_execution_status !== "FINAL") return "RPC response is not FINAL";
  const t = tx.transaction;
  if (!t || t.hash !== expected.hash || t.signer_id !== expected.signerId || t.receiver_id !== expected.receiverId)
    return "RPC transaction identity does not match the submitted hash, signer and receiver";
  if (!Array.isArray(t.actions) || t.actions.length !== 1) return "Expected exactly one submitted function call";
  const fc = (t.actions[0] as { FunctionCall?: { method_name?: unknown; args?: unknown; deposit?: unknown } })?.FunctionCall;
  if (!fc || fc.method_name !== expected.method || fc.deposit !== expected.deposit)
    return "RPC method or deposit does not match the submitted call";
  try {
    if (typeof fc.args !== "string") return "RPC call arguments are missing";
    const bytes = Uint8Array.from(atob(fc.args), c => c.charCodeAt(0));
    const args: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (canonical(args) !== canonical(expected.args)) return "RPC arguments do not match the submitted call";
  } catch { return "RPC call arguments could not be decoded"; }
  const root = tx.transaction_outcome;
  if (!root?.outcome || root.id !== expected.hash || root.outcome.executor_id !== expected.signerId)
    return "Transaction outcome identity is missing or inconsistent";
  if (typeof root.outcome.status === "object" && root.outcome.status !== null && "Failure" in root.outcome.status) return null;
  const rootStatus = root.outcome.status;
  if (typeof rootStatus !== "object" || rootStatus === null || !("SuccessReceiptId" in rootStatus))
    return "Transaction outcome has not created a successful receipt link";
  const outcomes = tx.receipts_outcome;
  if (!Array.isArray(outcomes) || !Array.isArray(root.outcome.receipt_ids) || root.outcome.receipt_ids.length !== 1)
    return "Linked guard receipt is missing";
  if (rootStatus.SuccessReceiptId !== root.outcome.receipt_ids[0]) return "Transaction outcome receipt link is inconsistent";
  const byId = new Map(outcomes.map(r => [r.id, r]));
  if (byId.size !== outcomes.length) return "Duplicate receipt outcomes";
  if (byId.get(root.outcome.receipt_ids[0])?.outcome?.executor_id !== expected.receiverId)
    return "Linked root receipt did not execute the submitted receiver";
  // FINAL alone does not prove the response includes all linked terminal outcomes.
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const o = byId.get(id)?.outcome;
    if (!o || !Array.isArray(o.receipt_ids) || typeof o.status !== "object" || o.status === null) return false;
    if (!("SuccessValue" in o.status || "SuccessReceiptId" in o.status || "Failure" in o.status)) return false;
    if ("SuccessReceiptId" in o.status && !o.receipt_ids.includes(o.status.SuccessReceiptId)) return false;
    return o.receipt_ids.every(visit);
  };
  if (!root.outcome.receipt_ids.every(visit) || seen.size !== outcomes.length)
    return "Receipt outcomes are missing, nonterminal or inconsistent";
  return null;
}

export function classifySubmittedTx(tx: TxStatus, expected: SubmittedCall): { outcome: Outcome; why?: string } {
  const why = submissionMismatch(tx, expected);
  if (why) return { outcome: { status: "pending", events: [], downstreamFailures: [] }, why };
  return { outcome: classifyTx(tx, expected.receiverId) };
}
