// Payment evidence v2 (docs/EVIDENCE_FORMAT.md), agreed with the runner owner as the base.
// The UI never shows a record as verified on its word alone: each tx_hash is re-read from
// RPC, the status is re-derived from the chain, and "settled" additionally requires the
// token's ft_transfer receipt named in the record to exist and to have succeeded.
import { NETWORK, txStatus, type TxReceipt, type TxStatus } from "./near-rpc";
import { contractErrorCode, describeFailure } from "./errors";
import { bindPayCall, rootOutcome } from "./pay-binding";
import { duplicateTxHash, isDecimal, isDecimals, isTimestampNs, isU128 } from "./evidence-view";

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
  explorer_url: string | null;
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
const b58 = (v: unknown) => typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
const acct = (v: unknown) => typeof v === "string" && v.length >= 2 && v.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(v);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// Request ids are unique only within one export: a row's identity is network/guard/request_id.
export const evidenceKey = (f: Pick<EvidenceFile, "network" | "guard_id">, r: Pick<EvidenceRecord, "request_id">) =>
  `${f.network}/${f.guard_id}/${r.request_id}`;

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
  const seen = new Set<string>();
  for (const [i, r] of f.records.entries()) {
    const bad = (why: string) => ({ ok: false as const, error: `record ${i} (${typeof r?.request_id === "string" ? r.request_id : "?"}): ${why}` });
    if (!r || typeof r !== "object" || Array.isArray(r)) return bad("not an object");
    // Every displayed field is type-checked here; a TS type is not runtime validation.
    if (!str(r.request_id) || !/^[A-Za-z0-9_-]{1,64}$/.test(r.request_id)) return bad("request_id invalid");
    if (seen.has(r.request_id)) return bad("duplicate request_id in this export");
    seen.add(r.request_id);
    if (!acct(r.agent_id) || !acct(r.recipient_id) || !acct(r.token_id)) return bad("agent_id, recipient_id and token_id must be NEAR account ids");
    if (!isU128(r.amount)) return bad("amount must be a canonical positive u128 base-unit string");
    if (!isDecimals(r.token_decimals)) return bad("token_decimals must be an integer 0-38");
    if (typeof r.token_symbol !== "string" || r.token_symbol.length > 32) return bad("token_symbol must be a string (max 32)");
    if (!STATUSES.includes(r.status)) return bad(`status must be one of ${STATUSES.join(", ")}`);
    if (!b58(r.tx_hash)) return bad("tx_hash must be a base58 hash (rejections are real transactions too)");
    if (!nullOr(r.reason, (x) => typeof x === "string" && x.length <= 200)) return bad("reason must be a string or null");
    if (r.scenario !== null && !["A", "B", "C", "D", "E"].includes(r.scenario as string)) return bad("scenario must be A-E or null");
    if (!str(r.source)) return bad("source (who verified this record) is required");
    if (!iso(r.verified_at)) return bad("verified_at must be ISO 8601");
    if (!nullOr(r.block_height, (x) => Number.isSafeInteger(x) && (x as number) >= 0)) return bad("block_height must be a non-negative integer or null");
    if (!nullOr(r.block_timestamp_ns, isTimestampNs)) return bad("block_timestamp_ns must be a bounded decimal string or null");
    if (!nullOr(r.recipient_balance_before, isDecimal) || !nullOr(r.recipient_balance_after, isDecimal)) return bad("balances must be decimal strings or null");
    if (!has(r, "explorer_url") || !nullOr(r.explorer_url, (x) => typeof x === "string")) return bad("explorer_url must be a string or null");
    if (!nullOr(r.note, (x) => typeof x === "string")) return bad("note must be a string or null");
    if (!nullOr(r.policy_id, str)) return bad("policy_id must be a string or null");
    if (!nullOr(r.proposal_id, (x) => str(x) && /^[0-9]+$/.test(x))) return bad("proposal_id must be a decimal string or null");
    if (!nullOr(r.settlement_receipt_id, b58)) return bad("settlement_receipt_id must be a base58 id or null");
    if (r.status === "settled" && !str(r.settlement_receipt_id)) return bad("settled requires settlement_receipt_id (a guard success alone is never settlement)");
    if (r.status === "rejected" && !str(r.reason)) return bad("rejected requires reason (the contract error code)");
  }
  const dup = duplicateTxHash(f.records);
  if (dup) return { ok: false, error: `tx_hash ${dup} appears in more than one record; one chain result can't vouch for two rows` };
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

const isObj = (s: unknown): s is Record<string, unknown> => typeof s === "object" && s !== null;

// The token's ft_transfer for THIS payment: a child receipt of the (successful) guard receipt,
// guard -> token_id, exactly ONE action = ft_transfer(receiver_id, amount) matching the record.
// success = SuccessValue with no child receipts; Failure = failure; anything else = pending.
export function findSettlement(tx: TxStatus, r: Pick<EvidenceRecord, "token_id" | "recipient_id" | "amount">, guardId: string): Settlement | null {
  const roots = tx.transaction_outcome.outcome.receipt_ids;
  const guardOut = tx.receipts_outcome.find((o) => roots.includes(o.id) && o.outcome.executor_id === guardId);
  const gs = guardOut?.outcome.status;
  if (!guardOut || !(isObj(gs) && ("SuccessValue" in gs || "SuccessReceiptId" in gs))) return null;
  const match = (tx.receipts ?? []).find((x: TxReceipt) => {
    if (!guardOut.outcome.receipt_ids.includes(x.receipt_id) || x.predecessor_id !== guardId || x.receiver_id !== r.token_id) return false;
    const acts = (x.receipt as { Action?: { actions: unknown[] } }).Action?.actions;
    if (!Array.isArray(acts) || acts.length !== 1) return false;
    const fc = (acts[0] as { FunctionCall?: { method_name: string; args: string } }).FunctionCall;
    if (!fc || fc.method_name !== "ft_transfer") return false;
    const args = decodeArgs(fc.args);
    return !!args && args.receiver_id === r.recipient_id && args.amount === r.amount;
  });
  if (!match) return null;
  const out = tx.receipts_outcome.find((o) => o.id === match.receipt_id && o.outcome.executor_id === r.token_id);
  const s = out?.outcome.status;
  if (isObj(s) && "Failure" in s) return { receiptId: match.receipt_id, result: "failure", message: describeFailure(s.Failure) };
  if (isObj(s) && "SuccessValue" in s && out!.outcome.receipt_ids.length === 0) return { receiptId: match.receipt_id, result: "success", message: null };
  return { receiptId: match.receipt_id, result: "pending", message: null };
}

// Pure: re-derive the payment status from an RPC result and compare with the record.
// agentId = the guard's configured agent (get_config), never taken from the record.
export function verifyAgainstTx(r: EvidenceRecord, tx: TxStatus, guardId: string, agentId: string | null | undefined): Verification {
  // F3: the tx must be exactly the configured agent's pay call for THIS request/token/recipient/amount.
  const bind = bindPayCall(tx, r, guardId, agentId);
  if (!bind.ok) return { state: "unverifiable", why: bind.why };
  if (r.status === "settled" && !str(r.settlement_receipt_id)) return { state: "unverifiable", why: "claims settled but names no settlement receipt; a guard success alone is never settlement" };

  // Review N2: the outcome is the BOUND root pay receipt's own; the code only from its Failure.
  const root = rootOutcome(tx, bind.guardReceiptId);
  let onchain: PaymentStatus; let reason: string | null = null; let st: Settlement | null = null;
  if (root.kind === "failure") { onchain = "rejected"; reason = contractErrorCode(root.failure); }  // never a message as a code
  else if (root.kind === "pending") onchain = "pending";
  else {
    // Review N4 (docs/EVIDENCE_FORMAT.md l112-113): reserved needs the exact matching ft_transfer
    // receipt; no matching transfer evidence = pending, never reserved. Only the token's own
    // receipt decides settlement; a transfer whose completion is unverified stays reserved.
    st = findSettlement(tx, r, guardId);
    if (!st) onchain = "pending";
    else if (st.result === "failure") { onchain = "settlement_failed"; reason = st.message; }
    else if (st.result === "success") onchain = "settled";
    else onchain = "reserved";
  }
  const sid = st?.receiptId ?? null;
  const base = { onchain, reason, settlementReceiptId: sid };
  const disagree = (detail: string): Verification => ({ state: "mismatch", ...base, detail });

  if (onchain !== r.status) return disagree(`record says ${r.status}, chain says ${onchain}`);
  if (onchain === "rejected" && reason !== r.reason) return disagree(`rejection code: record ${r.reason}, chain ${reason ?? "no code in the guard receipt"}`);
  if ((onchain === "settled" || onchain === "settlement_failed") && r.settlement_receipt_id && r.settlement_receipt_id !== sid)
    return disagree(`settlement receipt: record ${r.settlement_receipt_id}, chain ${sid}`);
  return { state: "verified", ...base };
}

export async function verifyRecord(r: EvidenceRecord, guardId: string, agentId: string | null | undefined): Promise<Verification> {
  if (!agentId) return { state: "unverifiable", why: "the guard's configured agent is unknown, so the signer can't be checked" };
  let tx;
  try { tx = await txStatus(r.tx_hash, r.agent_id, "FINAL"); }
  catch (e) { return { state: "unverifiable", why: `RPC couldn't load the tx (${String((e as Error)?.message ?? e)}); older txs need an archival RPC` }; }
  return verifyAgainstTx(r, tx, guardId, agentId);
}

export async function loadEvidence(guardId: string): Promise<EvidenceFile | null> {
  if (!EVIDENCE_URL) return null;
  const res = await fetch(EVIDENCE_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`evidence feed returned HTTP ${res.status}`);
  let raw: unknown;
  try { raw = await res.json(); } catch { throw new Error("evidence feed is not valid JSON"); }
  const p = parseEvidence(raw, guardId);
  if (p.ok === false) throw new Error(`evidence feed rejected: ${p.error}`);
  return p.file;
}
