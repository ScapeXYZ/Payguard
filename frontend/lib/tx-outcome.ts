// Pure classification of an RPC EXPERIMENTAL_tx_status result. No network.
// Review 6adab957b718 R1/R2: nothing is classified until the RESPONSE says FINAL; a failure
// carries a contract/policy code ONLY when it comes from the tx's failed ROOT guard receipt.
// A transaction counts as failed when the transaction or its ROOT guard receipt failed. Downstream token receipts are reported separately,
// because a guard call can succeed while a later ft_transfer fails.
import type { ExecStatus, ReceiptOutcome, TxStatus } from "./near-rpc";
import { contractErrorCode, describeFailure } from "./errors";

export type GuardEvent = { event: string; data: Record<string, unknown>; receiptId: string };

export type Outcome = {
  status: "confirmed" | "failed" | "pending";
  failure?: { code: string | null; message: string; receiptId: string; executor: string };
  returnValue?: unknown;            // decoded final SuccessValue of the whole tx
  events: GuardEvent[];             // EVENT_JSON logs (standard "payguard") in receipt order
  downstreamFailures: { receiptId: string; executor: string; message: string }[];
  finality?: string;
};

const isFailure = (s: ExecStatus): s is { Failure: unknown } => typeof s === "object" && s !== null && "Failure" in s;
const isSuccess = (s: ExecStatus) => typeof s === "object" && s !== null && ("SuccessValue" in s || "SuccessReceiptId" in s);

export const TX_LEVEL_FAILURE = "The network refused the transaction before the guard contract ran, so no policy decision was made. Check the explorer link.";

function decodeValue(v: string): unknown {
  if (!v) return undefined;
  try {
    const text = typeof atob === "function" ? atob(v) : Buffer.from(v, "base64").toString("utf8");
    try { return JSON.parse(text); } catch { return text; }
  } catch { return undefined; }
}

export function parseEvents(receipts: ReceiptOutcome[], guardId: string): GuardEvent[] {
  const out: GuardEvent[] = [];
  for (const r of receipts) {
    if (r.outcome.executor_id !== guardId) continue;
    for (const log of r.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const j = JSON.parse(log.slice("EVENT_JSON:".length));
        if (j.standard !== "payguard") continue;
        for (const d of j.data ?? [{}]) out.push({ event: String(j.event), data: d, receiptId: r.id });
      } catch { /* not ours */ }
    }
  }
  return out;
}

export function classifyTx(tx: TxStatus, guardId: string): Outcome {
  const events = parseEvents(tx.receipts_outcome ?? [], guardId);
  const downstreamFailures: Outcome["downstreamFailures"] = [];
  // R1: requesting FINAL is not enough; an EXECUTED/absent response stays pending (useTx keeps polling).
  if (tx.final_execution_status !== "FINAL") return { status: "pending", events, downstreamFailures, finality: tx.final_execution_status };

  // R2: the tx was refused before any guard receipt ran (admission/validation). Failed, but no
  // policy code and no contract-specific text: its failure text never speaks for the guard.
  if (isFailure(tx.transaction_outcome.outcome.status))
    return { status: "failed", events, downstreamFailures, finality: tx.final_execution_status,
      failure: { code: null, message: TX_LEVEL_FAILURE, receiptId: tx.transaction_outcome.id, executor: tx.transaction_outcome.outcome.executor_id } };
  // Review N2: only the tx's ROOT receipt executed by the guard speaks for the guard call. Any
  // other failed receipt (incl. a later guard-executed callback) is a downstream failure.
  const roots = tx.transaction_outcome.outcome.receipt_ids ?? [];
  for (const r of tx.receipts_outcome ?? []) {
    const s = r.outcome.status;
    if (!isFailure(s)) continue;
    if (r.outcome.executor_id === guardId && roots.includes(r.id)) {
      return { status: "failed", events, downstreamFailures, finality: tx.final_execution_status,
        failure: { code: contractErrorCode(s.Failure), message: describeFailure(s.Failure), receiptId: r.id, executor: r.outcome.executor_id } };
    }
    downstreamFailures.push({ receiptId: r.id, executor: r.outcome.executor_id, message: describeFailure(s.Failure) });
  }
  // Guard receipts all succeeded but a downstream receipt (e.g. the token's ft_transfer)
  // failed: the guard's state change IS committed (budget reserved, sweep lock cleared),
  // so this is "confirmed" with downstreamFailures, never a guard rejection.
  // R2: from here the root guard receipt did not fail. Without a successful root, nothing is decided.
  const root = (tx.receipts_outcome ?? []).find((r) => roots.includes(r.id) && r.outcome.executor_id === guardId);
  if (!root || !isSuccess(root.outcome.status)) return { status: "pending", events, downstreamFailures, finality: tx.final_execution_status };
  if (isFailure(tx.status) && downstreamFailures.length > 0)
    return { status: "confirmed", events, downstreamFailures, finality: tx.final_execution_status };
  // R2: an aggregate Failure with a successful root and no failed receipt is inconsistent evidence:
  // pending, never failed, and its text is never parsed into a policy code.
  if (isFailure(tx.status)) return { status: "pending", events, downstreamFailures, finality: tx.final_execution_status };
  if (!isSuccess(tx.status)) return { status: "pending", events, downstreamFailures, finality: tx.final_execution_status };
  const pendingReceipt = (tx.receipts_outcome ?? []).some((r) => !isSuccess(r.outcome.status) && !isFailure(r.outcome.status));
  if (pendingReceipt) return { status: "pending", events, downstreamFailures, finality: tx.final_execution_status };
  const returnValue = "SuccessValue" in (tx.status as object) ? decodeValue((tx.status as { SuccessValue: string }).SuccessValue) : undefined;
  return { status: "confirmed", events, downstreamFailures, returnValue, finality: tx.final_execution_status };
}
