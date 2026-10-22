// Payment evidence: PROPOSED schema for the agent payment runner's output
// (docs/EVIDENCE_FORMAT.md). Not final until agreed with the runner owner.
// The UI never shows a record as verified on its word alone: each tx_hash is re-read
// from RPC and the on-chain result is compared with what the record claims.
import { txStatus } from "./near-rpc";
import { classifyTx } from "./tx-outcome";

export const EVIDENCE_SCHEMA = "payguard.evidence.v1";
export const EVIDENCE_URL = process.env.NEXT_PUBLIC_EVIDENCE_URL ?? "";

export type Scenario = "A" | "B" | "C" | "D" | "E";
export type PaymentStatus = "rejected" | "reserved" | "settled" | "settlement_failed" | "pending";

export type EvidenceRecord = {
  request_id: string;
  scenario: Scenario | null;
  agent_id: string;
  recipient_id: string;
  token_id: string;
  token_symbol: string;
  token_decimals: number;
  amount: string;                 // base units, decimal string
  status: PaymentStatus;
  reason: string | null;          // contract error code when rejected; failure text when settlement_failed
  tx_hash: string;
  block_height: number | null;
  block_timestamp_ns: string | null;
  explorer_url: string;
  settlement_receipt_id: string | null;
  recipient_balance_before: string | null;  // base units, read by the runner, optional
  recipient_balance_after: string | null;
  note: string | null;
};

export type EvidenceFile = {
  schema: typeof EVIDENCE_SCHEMA;
  network: "testnet" | "mainnet";
  guard_id: string;
  generated_at: string;           // ISO 8601
  runner: string | null;          // runner name + version/commit
  records: EvidenceRecord[];
};

const STATUSES: PaymentStatus[] = ["rejected", "reserved", "settled", "settlement_failed", "pending"];
const str = (v: unknown) => typeof v === "string" && v.length > 0;

// Strict shape check. One bad record rejects the file: partial evidence is worse than none.
export function parseEvidence(raw: unknown, guardId: string): { ok: true; file: EvidenceFile } | { ok: false; error: string } {
  const f = raw as EvidenceFile;
  if (!f || typeof f !== "object") return { ok: false, error: "evidence is not a JSON object" };
  if (f.schema !== EVIDENCE_SCHEMA) return { ok: false, error: `schema must be "${EVIDENCE_SCHEMA}"` };
  if (f.guard_id !== guardId) return { ok: false, error: `evidence is for ${f.guard_id}, this UI reads ${guardId}` };
  if (!Array.isArray(f.records)) return { ok: false, error: "records must be an array" };
  for (const [i, r] of f.records.entries()) {
    const bad = (why: string) => ({ ok: false as const, error: `record ${i} (${r?.request_id ?? "?"}): ${why}` });
    if (!str(r.request_id) || !/^[A-Za-z0-9_-]{1,64}$/.test(r.request_id)) return bad("request_id invalid");
    if (!str(r.agent_id) || !str(r.recipient_id) || !str(r.token_id)) return bad("agent_id, recipient_id and token_id are required");
    if (!/^[0-9]+$/.test(String(r.amount))) return bad("amount must be base units as a decimal string");
    if (!Number.isInteger(r.token_decimals)) return bad("token_decimals must be an integer");
    if (!STATUSES.includes(r.status)) return bad(`status must be one of ${STATUSES.join(", ")}`);
    if (!str(r.tx_hash)) return bad("tx_hash is required (rejections are real transactions too)");
    if (r.scenario !== null && r.scenario !== undefined && !["A", "B", "C", "D", "E"].includes(r.scenario)) return bad("scenario must be A-E or null");
  }
  return { ok: true, file: f };
}

export type Verification =
  | { state: "verified"; onchain: PaymentStatus; reason: string | null }
  | { state: "mismatch"; onchain: PaymentStatus; reason: string | null }
  | { state: "unverifiable"; why: string };

// Re-derive the payment status from the chain and compare.
export async function verifyRecord(r: EvidenceRecord, guardId: string): Promise<Verification> {
  let tx;
  try { tx = await txStatus(r.tx_hash, r.agent_id, "FINAL"); }
  catch (e) { return { state: "unverifiable", why: `RPC couldn't load the tx (${String((e as Error)?.message ?? e)}); older txs need an archival RPC` }; }
  if (tx.transaction.receiver_id !== guardId) return { state: "unverifiable", why: `tx was sent to ${tx.transaction.receiver_id}, not the guard` };
  const o = classifyTx(tx, guardId);
  let onchain: PaymentStatus; let reason: string | null = null;
  if (o.status === "pending") onchain = "pending";
  else if (o.status === "failed") { onchain = "rejected"; reason = o.failure?.code ?? o.failure?.message ?? null; }
  else if (o.downstreamFailures.length) { onchain = "settlement_failed"; reason = o.downstreamFailures[0].message; }
  else {
    const transferred = tx.receipts_outcome.some((x) => x.outcome.executor_id === r.token_id);
    onchain = transferred ? "settled" : "reserved";
  }
  const same = onchain === r.status && (onchain !== "rejected" || reason === r.reason);
  return same ? { state: "verified", onchain, reason } : { state: "mismatch", onchain, reason };
}

export async function loadEvidence(guardId: string): Promise<EvidenceFile | null> {
  if (!EVIDENCE_URL) return null;
  const res = await fetch(EVIDENCE_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`evidence feed returned HTTP ${res.status}`);
  const p = parseEvidence(await res.json(), guardId);
  if (p.ok === false) throw new Error(`evidence feed rejected: ${p.error}`);
  return p.file;
}
