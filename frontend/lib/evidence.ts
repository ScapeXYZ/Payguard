// Payment evidence v2 (docs/EVIDENCE_FORMAT.md), agreed with the runner owner as the base.
// The UI never shows a record as verified on its word alone: each tx_hash is re-read from
// RPC, the status is re-derived from the chain, and "settled" additionally requires the
// token's ft_transfer receipt named in the record to exist and to have succeeded.
import { NETWORK, txStatus, type TxReceipt, type TxStatus } from "./near-rpc";
import { classifyTx } from "./tx-outcome";
import { describeFailure } from "./errors";

export const EVIDENCE_SCHEMA = "payguard.evidence.v2";
export const EVIDENCE_URL = process.env.NEXT_PUBLIC_EVIDENCE_URL ?? "";

export type Scenario = "A" | "B" | "C" | "D" | "E";
export type PaymentStatus = "rejected" | "pending" | "reserved" | "settlement_failed" | "settled";

export type EvidenceRecord = {
  request_id: string;
  scenario: Scenario | null;
  agent_id: string;
  recipient_id: string;
  token_id: string;
  token_symbol: string;
  token_decimals: number;
  amount: string;                         // base units, decimal string
  status: PaymentStatus;
  reason: string | null;                  // rejected: contract code; settlement_failed: token failure text
  tx_hash: string;
  block_height: number | null;
  block_timestamp_ns: string | null;
  explorer_url: string;
  settlement_receipt_id: string | null;   // REQUIRED for settled: the token's ft_transfer receipt
  policy_id: string | null;               // reserved: the contract has no policy id today
  proposal_id: string | null;             // policy proposal that made the active policy, if known
  source: string;                         // who verified THIS record (runner id + commit)
  verified_at: string;                    // ISO 8601, when that runner verified it
  recipient_balance_before: string | null;
  recipient_balance_after: string | null;
  note: string | null;
};

export type EvidenceFile = {
  schema: typeof EVIDENCE_SCHEMA;
  network: "testnet" | "mainnet";
  guard_id: string;
  generated_at: string;                   // ISO 8601, when the file was written
  source: string;                         // who produced the file
  records: EvidenceRecord[];
};

const STATUSES: PaymentStatus[] = ["rejected", "pending", "reserved", "settlement_failed", "settled"];
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const iso = (v: unknown) => str(v) && !Number.isNaN(Date.parse(v));
const nullOr = (v: unknown, ok: (x: unknown) => boolean) => v === null || ok(v);

// Strict shape check. One bad record rejects the file: partial evidence is worse than none.
export function parseEvidence(raw: unknown, guardId: string, network: string = NETWORK): { ok: true; file: EvidenceFile } | { ok: false; error: string } {
  const f = raw as EvidenceFile;
  if (!f || typeof f !== "object") return { ok: false, error: "evidence is not a JSON object" };
  if (f.schema !== EVIDENCE_SCHEMA) return { ok: false, error: `schema must be "${EVIDENCE_SCHEMA}"` };
  if (f.network !== network) return { ok: false, error: `evidence is for ${f.network}, this UI reads ${network}` };
  if (f.guard_id !== guardId) return { ok: false, error: `evidence is for ${f.guard_id}, this UI reads ${guardId}` };
  if (!iso(f.generated_at)) return { ok: false, error: "generated_at must be ISO 8601" };
  if (!str(f.source)) return { ok: false, error: "source (file producer) is required" };
  if (!Array.isArray(f.records)) return { ok: false, error: "records must be an array" };
  for (const [i, r] of f.records.entries()) {
    const bad = (why: string) => ({ ok: false as const, error: `record ${i} (${r?.request_id ?? "?"}): ${why}` });
    if (!r || typeof r !== "object") return bad("not an object");
    if (!str(r.request_id) || !/^[A-Za-z0-9_-]{1,64}$/.test(r.request_id)) return bad("request_id invalid");
    if (!str(r.agent_id) || !str(r.recipient_id) || !str(r.token_id)) return bad("agent_id, recipient_id and token_id are required");
    if (!/^[0-9]+$/.test(String(r.amount))) return bad("amount must be base units as a decimal string");
    if (!Number.isInteger(r.token_decimals)) return bad("token_decimals must be an integer");
    if (!STATUSES.includes(r.status)) return bad(`status must be one of ${STATUSES.join(", ")}`);
    if (!str(r.tx_hash)) return bad("tx_hash is required (rejections are real transactions too)");
    if (r.scenario !== null && r.scenario !== undefined && !["A", "B", "C", "D", "E"].includes(r.scenario)) return bad("scenario must be A-E or null");
    if (!str(r.source)) return bad("source (who verified this record) is required");
    if (!iso(r.verified_at)) return bad("verified_at must be ISO 8601");
    if (!nullOr(r.policy_id, str)) return bad("policy_id must be a string or null");
    if (!nullOr(r.proposal_id, (x) => str(x) && /^[0-9]+$/.test(x))) return bad("proposal_id must be a decimal string or null");
    if (!nullOr(r.settlement_receipt_id, str)) return bad("settlement_receipt_id must be a string or null");
    if (r.status === "settled" && !str(r.settlement_receipt_id)) return bad("settled requires settlement_receipt_id (a guard success alone is never settlement)");
    if (r.status === "rejected" && !str(r.reason)) return bad("rejected requires reason (the contract error code)");
  }
  return { ok: true, file: f };
}

export type Verification =
  | { state: "verified"; onchain: PaymentStatus; reason: string | null; settlementReceiptId: string | null }
  | { state: "mismatch"; onchain: PaymentStatus; reason: string | null; settlementReceiptId: string | null; detail: string }
  | { state: "unverifiable"; why: string };

type Settlement = { receiptId: string; result: "success" | "failure" | "pending"; message: string | null };

const decodeArgs = (b64: string): Record<string, unknown> | null => {
  try { return JSON.parse(typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("utf8")); } catch { return null; }
};

// The token's ft_transfer for THIS payment: a receipt sent by the guard to token_id,
// calling ft_transfer with exactly this receiver_id and amount.
export function findSettlement(tx: TxStatus, r: Pick<EvidenceRecord, "token_id" | "recipient_id" | "amount">, guardId: string): Settlement | null {
  const match = (tx.receipts ?? []).find((x: TxReceipt) => {
    if (x.predecessor_id !== guardId || x.receiver_id !== r.token_id) return false;
    const acts = (x.receipt as { Action?: { actions: unknown[] } }).Action?.actions ?? [];
    return acts.some((a) => {
      const fc = (a as { FunctionCall?: { method_name: string; args: string } }).FunctionCall;
      if (!fc || fc.method_name !== "ft_transfer") return false;
      const args = decodeArgs(fc.args);
      return !!args && args.receiver_id === r.recipient_id && String(args.amount) === r.amount;
    });
  });
  if (!match) return null;
  const out = tx.receipts_outcome.find((o) => o.id === match.receipt_id);
  const s = out?.outcome.status;
  if (s && typeof s === "object" && "Failure" in s) return { receiptId: match.receipt_id, result: "failure", message: describeFailure(s.Failure) };
  if (s && typeof s === "object" && ("SuccessValue" in s || "SuccessReceiptId" in s)) return { receiptId: match.receipt_id, result: "success", message: null };
  return { receiptId: match.receipt_id, result: "pending", message: null };
}

// Pure: re-derive the payment status from an RPC result and compare with the record.
export function verifyAgainstTx(r: EvidenceRecord, tx: TxStatus, guardId: string): Verification {
  if (tx.transaction.receiver_id !== guardId) return { state: "unverifiable", why: `tx was sent to ${tx.transaction.receiver_id}, not the guard` };
  if (tx.transaction.signer_id !== r.agent_id) return { state: "unverifiable", why: `tx was signed by ${tx.transaction.signer_id}, not ${r.agent_id}` };
  if (r.status === "settled" && !str(r.settlement_receipt_id)) return { state: "unverifiable", why: "claims settled but names no settlement receipt; a guard success alone is never settlement" };

  const o = classifyTx(tx, guardId);
  let onchain: PaymentStatus; let reason: string | null = null; let st: Settlement | null = null;
  if (o.status === "failed") { onchain = "rejected"; reason = o.failure?.code ?? o.failure?.message ?? null; }
  else if (o.status === "pending" && !(st = findSettlement(tx, r, guardId))) onchain = "pending";
  else {
    st = st ?? findSettlement(tx, r, guardId);
    // Guard committed the reservation. Only the token's own receipt decides settlement.
    if (!st) onchain = o.status === "pending" ? "pending" : "reserved";
    else if (st.result === "failure") { onchain = "settlement_failed"; reason = st.message; }
    else if (st.result === "success") onchain = "settled";
    else onchain = "pending";
  }
  const sid = st?.receiptId ?? null;
  const base = { onchain, reason, settlementReceiptId: sid };
  const disagree = (detail: string): Verification => ({ state: "mismatch", ...base, detail });

  if (onchain !== r.status) return disagree(`record says ${r.status}, chain says ${onchain}`);
  if (onchain === "rejected" && reason !== r.reason) return disagree(`rejection code: record ${r.reason}, chain ${reason}`);
  if ((onchain === "settled" || onchain === "settlement_failed") && r.settlement_receipt_id && r.settlement_receipt_id !== sid)
    return disagree(`settlement receipt: record ${r.settlement_receipt_id}, chain ${sid}`);
  return { state: "verified", ...base };
}

export async function verifyRecord(r: EvidenceRecord, guardId: string): Promise<Verification> {
  let tx;
  try { tx = await txStatus(r.tx_hash, r.agent_id, "FINAL"); }
  catch (e) { return { state: "unverifiable", why: `RPC couldn't load the tx (${String((e as Error)?.message ?? e)}); older txs need an archival RPC` }; }
  return verifyAgainstTx(r, tx, guardId);
}

export async function loadEvidence(guardId: string): Promise<EvidenceFile | null> {
  if (!EVIDENCE_URL) return null;
  const res = await fetch(EVIDENCE_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`evidence feed returned HTTP ${res.status}`);
  const p = parseEvidence(await res.json(), guardId);
  if (p.ok === false) throw new Error(`evidence feed rejected: ${p.error}`);
  return p.file;
}
