"use client";
import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, CircleHelp, ExternalLink, FileJson, ShieldAlert } from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Mono } from "./ui";
import { ViewBanner } from "./view-state";
import { guard, IS_MOCK } from "@/lib/guard";
import { useView } from "@/lib/use-guard";
import { EMPTY_EVIDENCE_TEXT, EVIDENCE_URL, GENERIC_GUARD_FAILURE, evidenceKey, loadEvidence, verifyRecord, type EvidenceFile, type EvidenceRecord, type Verification } from "@/lib/evidence";
import { fmtBlockTime, fmtEvidenceAmount as fmtAmount, recordFingerprint, resultFor, type Fingerprinted } from "@/lib/evidence-view";
import { txUrl } from "@/lib/near-rpc";
import { short } from "@/lib/utils";

// What the RUNNER claims (exporter status rules). Never shown as fact: the chain check sits
// next to it, and only a verified settled row ever gets a green badge.
export const STATUS_COPY: Record<EvidenceRecord["status"], { label: string; tone: "danger" | "warn" | "ok" | "outline" }> = {
  settled: { label: "runner reports: settled", tone: "ok" },
  reserved: { label: "runner reports: reserved, transfer not confirmed", tone: "warn" },
  settlement_failed: { label: "runner reports: reserved, ft_transfer failed", tone: "danger" },
  rejected: { label: "runner reports: rejected by the guard", tone: "danger" },
  pending: { label: "runner reports: pending, outcome unresolved", tone: "warn" },
};

export const UNKNOWN = "Unknown";
// Unknown decimals = raw base units, never a guessed USDC conversion.
// Never throws: bad decimals = raw base units (bounded 0-38 in lib/evidence-view).
export const fmtEvidenceAmount = (raw: string | null, r: Pick<EvidenceRecord, "token_decimals" | "token_symbol">) =>
  r.token_decimals !== null && r.token_symbol === null ? `${fmtAmount(raw, r.token_decimals, null)} (${UNKNOWN} token)` : fmtAmount(raw, r.token_decimals, r.token_symbol);
export const reasonText = (reason: string | null) =>
  reason === GENERIC_GUARD_FAILURE ? "guard execution failed (specific code not in the export)" : reason === "ft_transfer_failed" ? "token transfer failed" : reason;

export type VerifiedLookup = (r: EvidenceRecord) => Verification | undefined;

// Verify each record once per distinct content. The effect keys on a content signature, not
// on array identity (arrays are rebuilt every render/poll), so one record = one RPC check.
// The lookup only yields a result whose fingerprint equals the CURRENT record's (all fields +
// configured agent), so a refreshed record never shows the previous result (review F4).
export function useVerified(file: EvidenceFile | null | undefined, records: EvidenceRecord[] | undefined): VerifiedLookup {
  const cfg = useView(() => guard.get_config(), []);
  const agentId = cfg.data?.agent_id ?? null;
  const cfgFailed = !!cfg.error && !cfg.data;
  const [cache, setCache] = useState<Record<string, Fingerprinted<Verification>>>({});
  const fpOf = (r: EvidenceRecord) => (file ? recordFingerprint(r, `${evidenceKey(file, r)}|agent=${agentId ?? (cfgFailed ? "unknown" : "loading")}`) : "");
  const sig = useMemo(() => (file && records ? records.map(fpOf).join("\n") : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [file, records, agentId, cfgFailed]);
  useEffect(() => {
    if (!file || !records?.length) return;
    if (!agentId && !cfgFailed) return; // wait for the configured agent
    let alive = true;
    (async () => {
      for (const r of records) {
        if (!alive) return;
        const fp = fpOf(r);
        const res = await verifyRecord(r, guard.contractId, agentId);
        if (alive) setCache((p) => ({ ...p, [evidenceKey(file, r)]: { fp, v: res } }));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return (r) => (file ? resultFor(cache, evidenceKey(file, r), fpOf(r)) : undefined);
}

export function VerifyBadge({ v, status }: { v?: Verification; status?: EvidenceRecord["status"] }) {
  if (!v) return <Badge variant="outline">checking chain...</Badge>;
  if (v.state === "verified") return <Badge variant={v.onchain === "settled" ? "ok" : v.onchain === "rejected" || v.onchain === "settlement_failed" ? "danger" : "warn"} className="gap-1"><BadgeCheck className="size-3" /> verified on chain: {v.onchain}</Badge>;
  // Null tx_hash / verified_at: never green, never "verified", even when the chain matches.
  if (v.state === "unavailable") return <Badge variant={status === "pending" ? "outline" : "warn"} className="gap-1" title={v.why}><CircleHelp className="size-3" /> verification unavailable</Badge>;
  if (v.state === "mismatch") return <Badge variant="danger" className="gap-1" title={v.detail}><ShieldAlert className="size-3" /> chain disagrees: {v.onchain}</Badge>;
  return <Badge variant="outline" className="gap-1" title={v.why}><CircleHelp className="size-3" /> not verified</Badge>;
}

export function VerifyDetail({ v }: { v?: Verification }) {
  if (!v) return null;
  const failure = (c: { onchain: string; chainCode: string | null; chainFailureText: string | null }) =>
    c.chainCode ? `chain code: ${c.chainCode}` : c.chainFailureText ? `${c.onchain === "settlement_failed" ? "token receipt failure" : "guard receipt failure"}: ${c.chainFailureText}` : null;
  const text = v.state === "unverifiable" ? v.why
    : v.state === "unavailable" ? (v.chain ? `${v.why}. chain shows ${v.chain.onchain}${v.chain.agrees ? "" : ` (${v.chain.detail})`}${failure(v.chain) ? `; ${failure(v.chain)}` : ""}` : v.why)
    : v.state === "mismatch" ? v.detail
    : failure(v) ?? (v.settlementReceiptId ? `ft_transfer receipt ${v.settlementReceiptId.slice(0, 8)}...` : null);
  return text ? <div className="mt-1 break-words text-sm text-muted-foreground">{text}</div> : null;
}

// One row. Any unexpected value renders as an error row; it never takes the page down (review F5).
function Row({ r, v }: { r: EvidenceRecord; v?: Verification }) {
  let cells;
  try {
    cells = {
      amount: fmtEvidenceAmount(r.amount, r),
      status: STATUS_COPY[r.status] ?? { label: `runner reports: ${String(r.status)}`, tone: "outline" as const },
      when: fmtBlockTime(r.block_timestamp_ns) ?? UNKNOWN,
      observed: typeof r.verified_at === "string" ? r.verified_at.replace("T", " ").slice(0, 16) : UNKNOWN,
      reason: reasonText(r.reason),
    };
  } catch (e) {
    return <div className="rounded-lg border border-red-500/40 px-4 py-3 text-xs text-red-300">Record {String(r?.request_id ?? "?")} couldn&apos;t be displayed: {String((e as Error)?.message ?? e)}</div>;
  }
  const chain = v && v.state !== "unverifiable" ? (v.state === "unavailable" ? v.chain : v) : null;
  const receiptId = chain?.settlementReceiptId ?? r.settlement_receipt_id;
  return (
    <article className="overflow-hidden rounded-xl border border-border bg-muted/10 transition-colors hover:border-primary/40">
      <header className="flex flex-col gap-3 border-b border-border/70 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Request ID</div>
          <div className="break-all font-mono text-base font-semibold leading-relaxed" title={r.request_id}>{r.request_id}</div>
          {r.scenario && <Badge variant="outline" className="mt-2" title="scenario tag reported by the runner">scenario {r.scenario}</Badge>}
        </div>
        <Badge variant={cells.status.tone} className="self-start whitespace-normal text-center text-sm sm:max-w-[20rem] sm:shrink-0">{cells.status.label}</Badge>
      </header>

      <section aria-label="Payment summary" className="border-b border-border/70 p-5">
        <div className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Payment summary</div>
        <div className="grid gap-5 text-sm sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-background/30 p-4">
            <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Amount</div>
            <div className="mt-1 text-2xl font-semibold leading-tight" title="symbol and decimals as reported by the runner, not read from chain">{cells.amount}</div>
            <div className="mt-2 font-mono text-sm text-muted-foreground">{r.amount} base units</div>
          </div>
          <div className="rounded-lg border border-border bg-background/30 p-4">
            <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Chain verification</div>
            <div className="mt-2"><VerifyBadge v={v} status={r.status} /></div>
          </div>
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Agent</div>
            <div className="mt-1 break-all font-mono text-sm" title={r.agent_id}>{r.agent_id}</div>
          </div>
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Recipient</div>
            <div className="mt-1 break-all font-mono text-sm" title={r.recipient_id}>{r.recipient_id}</div>
          </div>
          <div className="min-w-0 sm:col-span-2">
            <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Token contract</div>
            <div className="mt-1 break-all font-mono text-sm" title={r.token_id}>{r.token_id}</div>
          </div>
        </div>
      </section>

      <section aria-label="Verification evidence" className="p-5">
        <div className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Verification evidence</div>
        <div className="grid gap-x-6 gap-y-5 text-sm sm:grid-cols-2">
          <div className="min-w-0"><div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Transaction</div>{r.tx_hash ? <a className="mt-1 inline-flex max-w-full items-center gap-2 rounded-sm font-mono text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={txUrl(r.tx_hash)} target="_blank" rel="noreferrer" title={`Open transaction ${r.tx_hash}`}><span className="break-all">{short(r.tx_hash, 8)}</span><ExternalLink aria-hidden="true" className="size-4 shrink-0" /></a> : <div className="mt-1 text-muted-foreground">{UNKNOWN}</div>}</div>
          <div className="min-w-0"><div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Settlement receipt</div><div className="mt-1 break-all font-mono" title={receiptId ?? undefined}>{receiptId ?? UNKNOWN}</div></div>
          <div className="min-w-0"><div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Runner reason</div><div className="mt-1 break-words">{cells.reason ?? UNKNOWN}</div></div>
          <div className="min-w-0"><div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Chain code</div><div className="mt-1 break-words font-mono">{chain?.chainCode ?? UNKNOWN}</div></div>
          <div className="min-w-0"><div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Observation time</div><div className="mt-1 break-words">{r.source} · {cells.observed}</div></div>
          <div className="min-w-0"><div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Block time</div><div className="mt-1 break-words">{cells.when} UTC</div></div>
          {r.proposal_id && <div className="min-w-0"><div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Proposal</div><div className="mt-1 font-mono">#{r.proposal_id}</div></div>}
          <div className="min-w-0"><div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Verification detail</div><div className="mt-1">{v ? <VerifyDetail v={v} /> : <span className="text-muted-foreground">checking chain...</span>}</div></div>
          <div className="min-w-0 sm:col-span-2"><div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Runner note</div><div className="mt-1 break-words" title={r.note}>{r.note || UNKNOWN}</div></div>
        </div>
      </section>
    </article>
  );
}

// Live payment history = the runner's evidence feed, each row re-checked against RPC.
// No sample rows, ever. No feed configured = an honest empty state.
export function PaymentHistory({ tokenId }: { tokenId: string }) {
  const ev = useView(() => loadEvidence(guard.contractId), []);
  const all = ev.data?.records;
  // Evidence is guard-scoped, not token-picker-scoped: show every persisted payment
  // for this guard so a multi-token export cannot hide a real record.
  const records = useMemo(() => all, [all]);
  const verified = useVerified(ev.data, records);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent payment activity</CardTitle>
        <CardDescription>From the agent payment runner&apos;s evidence feed. Each status is what the runner reports; every row is re-read from chain and only shows &quot;verified&quot; when the agent&apos;s pay call for exactly this request matches.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!EVIDENCE_URL || IS_MOCK ? (
          <div className="flex items-start gap-3 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            <FileJson className="mt-0.5 size-5 shrink-0" />
            <div>No evidence feed connected yet. The payment runner&apos;s output format is <Mono>docs/EVIDENCE_FORMAT.md</Mono> (v2); set <Mono>NEXT_PUBLIC_EVIDENCE_URL</Mono> to its JSON once it exists. Nothing is shown until then: no sample data.</div>
          </div>
        ) : (
          <>
            <ViewBanner views={[ev]} what="payment evidence" from="the evidence feed" />
            {all && !all.length && <p className="text-sm text-muted-foreground">{EMPTY_EVIDENCE_TEXT}. An empty export doesn&apos;t prove there were no on-chain payments.</p>}
            {all && all.length > 0 && records && !records.length && <p className="text-sm text-muted-foreground">{EMPTY_EVIDENCE_TEXT} for this token.</p>}
            {ev.data && records && records.length > 0 && (
              <div className="grid gap-3">
                {records.map((r) => <Row key={evidenceKey(ev.data!, r)} r={r} v={verified(r)} />)}
              </div>
            )}
          </>
        )}
        <p className="text-xs text-muted-foreground">&quot;Reserved&quot; means the guard approved the payment, counted it against today&apos;s limit and issued the transfer, but the transfer&apos;s completion isn&apos;t confirmed. &quot;Settled&quot; means the token transfer itself also succeeded. A reservation is never released if the transfer later fails. A row is verified as settled only when the agent&apos;s pay call matches this request and the token&apos;s own ft_transfer receipt succeeded; a successful guard call with no matching ft_transfer receipt stays &quot;pending&quot;.</p>
      </CardContent>
    </Card>
  );
}
