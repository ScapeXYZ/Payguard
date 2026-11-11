// Payment evidence v2, as produced by the runner's offline or RPC exporter
// (scripts/export-payment-evidence.mjs, contract in docs/EVIDENCE_FORMAT.md).
// The UI never shows a record as verified on its word alone: each tx_hash is re-read from
// RPC and the status re-derived from the chain with the exporter's own receipt rules.
// A record with no tx_hash can't be re-checked and is always "not verified".
import { NETWORK, type TxReceipt, type TxStatus } from "./near-rpc";
import { contractErrorCode, describeFailure } from "./errors";
import { describeDownstreamFailure } from "./tx-outcome";
import { bindPayCall, rootOutcome } from "./pay-binding";
import { loadEvidenceTransaction, onlySystemRefundChildren, validateEvidenceReceipts } from "./evidence-receipts";
import { isDecimal, isTimestampNs } from "./evidence-view";

export const EVIDENCE_SCHEMA = "payguard.evidence.v2";
export const EVIDENCE_URL = process.env.NEXT_PUBLIC_EVIDENCE_URL ?? "/evidence/payment-evidence-testnet.json";
export const EMPTY_EVIDENCE_TEXT = "No persisted payment evidence available";
// Generic exporter class: the guard receipt failed; the specific contract code isn't exported.
export const GENERIC_GUARD_FAILURE = "guard_execution_failed";

export type Scenario = "A" | "B" | "C" | "D" | "E";
export type PaymentStatus = "rejected" | "pending" | "reserved" | "settlement_failed" | "settled";
export type EvidenceSource = "runner_journal" | "runner_journal_rpc";

// Every key is REQUIRED to exist; the nullable ones may be null ("Unknown" in the UI).
export type EvidenceRecord = {
  request_id: string;
  scenario: Scenario | null;
  agent_id: string;
  recipient_id: string;
  token_id: string;
  token_symbol: string | null;
  token_decimals: number | null;          // null = show raw base units
  amount: string;                         // canonical positive u128, base units
  status: PaymentStatus;
  reason: string | null;                  // rejected: contract code or guard_execution_failed; settlement_failed: ft_transfer_failed
  tx_hash: string | null;
  block_height: number | null;
  block_timestamp_ns: string | null;
  explorer_url: string | null;            // informational only; links are derived from tx_hash
  settlement_receipt_id: string | null;   // required for settled
  policy_id: string | null;
  proposal_id: string | null;
  source: EvidenceSource;                 // provenance, not a verification badge
  verified_at: string | null;             // ISO, persisted receipt observation time
  recipient_balance_before: string | null;
  recipient_balance_after: string | null;
  note: string;
};

export type EvidenceFile = {
  schema: typeof EVIDENCE_SCHEMA;
  network: "testnet" | "mainnet";
  guard_id: string;
  generated_at: string;                   // export time, NOT evidence time
  source: EvidenceSource;
  records: EvidenceRecord[];
};

export const RECORD_KEYS = ["request_id", "scenario", "agent_id", "recipient_id", "token_id", "token_symbol", "token_decimals",
  "amount", "status", "reason", "tx_hash", "block_height", "block_timestamp_ns", "explorer_url", "settlement_receipt_id",
  "policy_id", "proposal_id", "source", "verified_at", "recipient_balance_before", "recipient_balance_after", "note"] as const;

const STATUSES: PaymentStatus[] = ["rejected", "pending", "reserved", "settlement_failed", "settled"];
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const matches = (v: unknown, re: RegExp): v is string => typeof v === "string" && re.exec(v)?.[0] === v;
const iso = (v: unknown) => matches(v, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const SOURCES = ["runner_journal", "runner_journal_rpc"];
const digits = (v: unknown) => matches(v, /^[0-9]+$/);
const b58 = (v: unknown) => matches(v, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const nullOr = (v: unknown, ok: (x: unknown) => boolean) => v === null || ok(v);
const acct = (v: unknown) => matches(v, /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/) && v.length >= 2 && v.length <= 64;
const u128 = (v: unknown) => matches(v, /^[1-9][0-9]{0,38}$/) && BigInt(v) < 2n ** 128n;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// Request ids are unique only within one journal export, so a row's identity is the
// composite (network, guard, request_id) of the file it came from.
export const evidenceKey = (f: Pick<EvidenceFile, "network" | "guard_id">, r: Pick<EvidenceRecord, "request_id">) =>
  `${f.network}/${f.guard_id}/${r.request_id}`;

export const explorerUrlFor = (network: string, hash: string) => `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${hash}`;
const ALWAYS_NULL_FROM_JOURNAL = ["scenario", "token_symbol", "token_decimals", "block_height", "block_timestamp_ns",
  "recipient_balance_before", "recipient_balance_after", "policy_id", "proposal_id"] as const;

// Typed nulls and provenance follow the exporter at main 8e078b8. A known
// transaction hash is valid for pending payments; it does not prove an outcome.
export function typedNullRule(r: EvidenceRecord, network: string): string | null {
  if (r.tx_hash === null && r.status !== "pending") return `${r.status} requires tx_hash`;
  if (r.tx_hash === null ? r.explorer_url !== null : r.explorer_url !== explorerUrlFor(network, r.tx_hash)) return "explorer_url must match tx_hash and network, or be null when the hash is null";
  if (r.status === "settled" ? r.settlement_receipt_id === null : r.settlement_receipt_id !== null) return "settlement_receipt_id is required only for settled";
  if (r.status === "pending" && r.verified_at !== null) return "pending records must have verified_at null";
  if (["pending", "reserved", "settled"].includes(r.status) && r.reason !== null) return `${r.status} must have reason null`;
  if (r.status === "settlement_failed" && r.reason !== "ft_transfer_failed") return "settlement_failed requires reason ft_transfer_failed";
  if (!SOURCES.includes(r.source)) return "unsupported evidence provenance";
  const set = ALWAYS_NULL_FROM_JOURNAL.filter(k => r[k] !== null);
  if (set.length) return `${r.source} has no authoritative ${set.join(", ")}; these fields must be null`;
  if (r.status === "rejected" && r.reason !== GENERIC_GUARD_FAILURE) return `${r.source} rejected reason must be guard_execution_failed`;
  return null;
}

// Strict check. One bad record rejects the file: partial evidence is worse than none.
export function parseEvidence(raw: unknown, guardId: string, network: string = NETWORK): { ok: true; file: EvidenceFile } | { ok: false; error: string } {
  const f = raw as EvidenceFile;
  if (!f || typeof f !== "object" || Array.isArray(f)) return { ok: false, error: "evidence is not a JSON object" };
  if (f.schema !== EVIDENCE_SCHEMA) return { ok: false, error: `unsupported schema (need "${EVIDENCE_SCHEMA}")` };
  if (f.network !== network) return { ok: false, error: `evidence is for ${String(f.network)}, this UI reads ${network}` };
  if (f.guard_id !== guardId) return { ok: false, error: `evidence is for ${String(f.guard_id)}, this UI reads ${guardId}` };
  if (!iso(f.generated_at)) return { ok: false, error: "generated_at must be ISO 8601" };
  if (!SOURCES.includes(f.source)) return { ok: false, error: "unsupported evidence provenance" };
  if (!Array.isArray(f.records)) return { ok: false, error: "records must be an array" };
  const seen = new Set<string>();
  for (const [i, r] of f.records.entries()) {
    const bad = (why: string) => ({ ok: false as const, error: `record ${i} (${typeof r?.request_id === "string" ? r.request_id : "?"}): ${why}` });
    if (!r || typeof r !== "object" || Array.isArray(r)) return bad("not an object");
    const missing = RECORD_KEYS.filter((k) => !has(r, k));
    if (missing.length) return bad(`missing required keys: ${missing.join(", ")} (null is allowed, absence is not)`);
    if (!matches(r.request_id, /^[A-Za-z0-9_-]{1,64}$/)) return bad("request_id invalid");
    if (seen.has(r.request_id)) return bad("duplicate request_id in this export");
    seen.add(r.request_id);
    if (!acct(r.agent_id) || !acct(r.recipient_id) || !acct(r.token_id)) return bad("agent_id, recipient_id and token_id must be NEAR account ids");
    if (!u128(r.amount)) return bad("amount must be a canonical positive u128 base-unit string");
    if (!STATUSES.includes(r.status)) return bad(`status must be one of ${STATUSES.join(", ")}`);
    if (r.source !== f.source) return bad("record provenance must match the export envelope");
    if (!nullOr(r.scenario, (x) => ["A", "B", "C", "D", "E"].includes(x as string))) return bad("scenario must be A-E or null");
    if (!nullOr(r.token_symbol, (x) => typeof x === "string" && x.length <= 32)) return bad("token_symbol must be a string (max 32) or null");
    if (!nullOr(r.token_decimals, (x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 38)) return bad("token_decimals must be an integer 0-38 or null");
    if (!nullOr(r.reason, str)) return bad("reason must be a string or null");
    if (!nullOr(r.tx_hash, b58)) return bad("tx_hash must be a base58 hash or null");
    if (!nullOr(r.block_height, (x) => Number.isInteger(x) && (x as number) >= 0)) return bad("block_height must be an integer or null");
    if (!nullOr(r.block_timestamp_ns, isTimestampNs)) return bad("block_timestamp_ns must be a bounded decimal string or null");
    if (!nullOr(r.explorer_url, (x) => typeof x === "string")) return bad("explorer_url must be a string or null");
    if (!nullOr(r.settlement_receipt_id, b58)) return bad("settlement_receipt_id must be a base58 id or null");
    if (!nullOr(r.policy_id, (x) => typeof x === "string")) return bad("policy_id must be a string or null");
    if (!nullOr(r.proposal_id, digits)) return bad("proposal_id must be a decimal string or null");
    if (!nullOr(r.verified_at, iso)) return bad("verified_at must be ISO 8601 or null");
    if (!nullOr(r.recipient_balance_before, isDecimal) || !nullOr(r.recipient_balance_after, isDecimal)) return bad("balances must be canonical decimal strings or null");
    if (typeof r.note !== "string") return bad("note must be a string");
    const why = typedNullRule(r, f.network);
    if (why) return bad(why);
  }
  // The exporter permits repeated hashes. Each row is independently bound to
  // its exact request_id and pay arguments; one lookup cannot certify two IDs.
  return { ok: true, file: f };
}

// chainCode: a contract code parsed from the actual guard receipt Failure, else null (never a message).
// chainFailureText: raw failure text from the failing receipt (guard or token), shown labelled, never as a code.
export type ChainResult = { onchain: PaymentStatus; reason: string | null; chainCode: string | null; chainFailureText: string | null; settlementReceiptId: string | null };
export type Verification =
  | ({ state: "verified" } & ChainResult)
  | ({ state: "mismatch"; detail: string } & ChainResult)
  // Evidence itself is incomplete (null tx_hash or null verified_at): NEVER verified, whatever the chain says.
  // `chain` is secondary info only ("chain shows X"), null when there was nothing to look up.
  | { state: "unavailable"; why: string; chain: (ChainResult & { agrees: boolean; detail: string | null }) | null }
  | { state: "unverifiable"; why: string };

const NO_HASH = "the evidence has no transaction hash, so it is not verified evidence";
const NO_VERIFIED_AT = "the evidence has no verified_at (no persisted classified observation), so it is not verified evidence";

type Settlement = { receiptId: string; result: "settled" | "failed" | "reserved"; message: string | null };

const decodeArgs = (b64: string): Record<string, unknown> | null => {
  try { return JSON.parse(typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("utf8")); } catch { return null; }
};
const isObj = (s: unknown): s is Record<string, unknown> => typeof s === "object" && s !== null;

// The exporter's settlement rule, applied to live RPC: the guard receipt's child receipt,
// guard -> token_id, exactly ONE action = ft_transfer(receiver_id, amount) matching the record.
// settled = SuccessValue with no children except proven terminal system refunds.
// Contract continuations stay reserved; a matching FT Failure is settlement_failed.
export function findSettlement(tx: TxStatus, r: Pick<EvidenceRecord, "token_id" | "recipient_id" | "amount" | "agent_id">, guardId: string): Settlement | null {
  const roots = tx.transaction_outcome.outcome.receipt_ids;
  const guardOut = tx.receipts_outcome.find((o) => roots.includes(o.id) && o.outcome.executor_id === guardId);
  // Only a successful guard receipt can carry the transfer.
  const gs = guardOut?.outcome.status;
  if (!guardOut || !(isObj(gs) && ("SuccessValue" in gs || "SuccessReceiptId" in gs))) return null;
  const matches = (tx.receipts ?? []).filter((x: TxReceipt) => {
    if (!guardOut.outcome.receipt_ids.includes(x.receipt_id) || x.predecessor_id !== guardId || x.receiver_id !== r.token_id) return false;
    const acts = (x.receipt as { Action?: { actions: unknown[] } }).Action?.actions;
    if (!Array.isArray(acts) || acts.length !== 1) return false;
    const fc = (acts[0] as { FunctionCall?: { method_name: string; args: string } }).FunctionCall;
    if (!fc || fc.method_name !== "ft_transfer") return false;
    const args = decodeArgs(fc.args);
    return !!args && args.receiver_id === r.recipient_id && args.amount === r.amount;
  });
  if (matches.length !== 1) return null;
  const match = matches[0];
  const out = tx.receipts_outcome.find((o) => o.id === match.receipt_id && o.outcome.executor_id === r.token_id);
  const s = out?.outcome.status;
  if (isObj(s) && "Failure" in s) return { receiptId: match.receipt_id, result: "failed", message: describeDownstreamFailure(s.Failure) };
  if (isObj(s) && "SuccessValue" in s && onlySystemRefundChildren(tx, match.receipt_id, r.agent_id)) return { receiptId: match.receipt_id, result: "settled", message: null };
  // A matching ft_transfer with unproven completion stays reserved.
  return { receiptId: match.receipt_id, result: "reserved", message: null };
}

// Pure: re-derive the payment status from an RPC result and compare with the record.
// A null tx_hash or a null verified_at is never verified evidence, even if the chain matches.
// agentId = the guard's configured agent (get_config), never taken from the record.
export function verifyAgainstTx(r: EvidenceRecord, tx: TxStatus, guardId: string, agentId: string | null | undefined): Verification {
  if (!r.tx_hash) return { state: "unavailable", why: NO_HASH, chain: null };
  const parsed = parseEvidence({ schema: EVIDENCE_SCHEMA, network: NETWORK, guard_id: guardId,
    generated_at: "2000-01-01T00:00:00.000Z", source: r.source, records: [r] }, guardId);
  if (!parsed.ok) return { state: "unverifiable", why: parsed.error };
  let v: Verification;
  try { v = checkChain(r, tx, guardId, agentId); }
  catch { v = { state: "unverifiable", why: "Incomplete or contradictory finalized receipt evidence" }; }
  if (r.verified_at !== null) return v;
  if (v.state === "verified") { const { state: _s, ...c } = v; return { state: "unavailable", why: NO_VERIFIED_AT, chain: { ...c, agrees: true, detail: null } }; }
  if (v.state === "mismatch") { const { state: _s, detail, ...c } = v; return { state: "unavailable", why: NO_VERIFIED_AT, chain: { ...c, agrees: false, detail } }; }
  return v.state === "unverifiable" ? { state: "unavailable", why: `${NO_VERIFIED_AT}; chain lookup also failed: ${v.why}`, chain: null } : v;
}

function checkChain(r: EvidenceRecord, tx: TxStatus, guardId: string, agentId: string | null | undefined): Verification {
  // Review F3: the tx must be exactly the configured agent's pay call for THIS request/token/recipient/amount.
  const bind = bindPayCall(tx, { ...r, tx_hash: r.tx_hash ?? "" }, guardId, agentId);
  if (!bind.ok) return { state: "unverifiable", why: bind.why };
  validateEvidenceReceipts(tx, { hash: r.tx_hash!, signerId: r.agent_id, guardId });
  if (r.status === "settled" && !r.settlement_receipt_id) return { state: "unverifiable", why: "claims settled but names no settlement receipt; a guard success alone is never settlement" };

  // Review N2: the outcome is the BOUND root pay receipt's own. Rejection, generic or specific,
  // and any code come only from THAT receipt's Failure; a later failed guard receipt never counts.
  const root = rootOutcome(tx, bind.guardReceiptId);
  let onchain: PaymentStatus; let chainCode: string | null = null; let chainFailureText: string | null = null; let st: Settlement | null = null; let guardFailed = false;
  if (root.kind === "failure") {
    chainCode = contractErrorCode(root.failure);
    onchain = "rejected"; guardFailed = true; chainFailureText = chainCode ? null : describeFailure(root.failure);
  } else if (root.kind === "pending") onchain = "pending";
  else {
    // Reserved needs the exact matching ft_transfer;
    // no matching transfer evidence = pending, never reserved.
    st = findSettlement(tx, r, guardId);
    if (!st) onchain = "pending";
    else if (st.result === "failed") { onchain = "settlement_failed"; chainFailureText = st.message; }
    else if (st.result === "settled") onchain = "settled";
    else onchain = "reserved";                  // matching transfer issued, completion unverified
  }
  const sid = st?.receiptId ?? null;
  const base: ChainResult = { onchain, reason: r.reason, chainCode, chainFailureText, settlementReceiptId: sid };
  const disagree = (detail: string): Verification => ({ state: "mismatch", ...base, detail });

  if (onchain !== r.status) return disagree(r.status === "pending" ? `record is pending (evidence incomplete); chain now shows ${onchain}` : `record says ${r.status}, chain says ${onchain}`);
  if (onchain === "rejected") {
    // Generic class: verified when the chain shows the GUARD receipt failed, whatever the code.
    if (r.reason === GENERIC_GUARD_FAILURE) { if (!guardFailed) return disagree(`record says the guard failed, but the failure was in ${tx.transaction.receiver_id === guardId ? "the transaction itself" : "another account"}`); }
    else if (r.reason !== chainCode) return disagree(`rejection code: record ${r.reason}, chain ${chainCode ?? "no code in the guard receipt"}`);
  }
  if (onchain === "settled" && r.settlement_receipt_id !== sid) return disagree(`settlement receipt: record ${r.settlement_receipt_id}, chain ${sid}`);
  if (onchain === "settlement_failed" && r.settlement_receipt_id && r.settlement_receipt_id !== sid) return disagree(`settlement receipt: record ${r.settlement_receipt_id}, chain ${sid}`);
  return { state: "verified", ...base };
}

export async function verifyRecord(r: EvidenceRecord, guardId: string, agentId: string | null | undefined): Promise<Verification> {
  if (!r.tx_hash) return { state: "unavailable", why: NO_HASH, chain: null };
  if (!agentId) {
    const why = "the guard's configured agent is unknown, so the signer can't be checked";
    return r.verified_at === null ? { state: "unavailable", why: `${NO_VERIFIED_AT}; ${why}`, chain: null } : { state: "unverifiable", why };
  }
  let tx;
  try { tx = await loadEvidenceTransaction({ hash: r.tx_hash, signerId: r.agent_id, guardId }); }
  catch (e) {
    const why = `RPC couldn't load the tx (${String((e as Error)?.message ?? e)}); older txs need an archival RPC`;
    return r.verified_at === null ? { state: "unavailable", why: `${NO_VERIFIED_AT}; ${why}`, chain: null } : { state: "unverifiable", why };
  }
  return verifyAgainstTx(r, tx, guardId, agentId);
}

// Fetch failure, invalid JSON, wrong schema/network/guard = a data error, never an empty history.
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
