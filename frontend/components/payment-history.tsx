"use client";
import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, CircleHelp, ExternalLink, FileJson, ShieldAlert } from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Mono } from "./ui";
import { ViewBanner } from "./view-state";
import { guard, IS_MOCK } from "@/lib/guard";
import { useView } from "@/lib/use-guard";
import { EVIDENCE_URL, evidenceKey, loadEvidence, verifyRecord, type EvidenceFile, type EvidenceRecord, type Verification } from "@/lib/evidence";
import { fmtBlockTime, fmtEvidenceAmount, recordFingerprint, resultFor, type Fingerprinted } from "@/lib/evidence-view";
import { txUrl } from "@/lib/near-rpc";
import { short } from "@/lib/utils";

// What the RUNNER claims. Never shown as fact: the chain check sits next to it, and only a
// verified settled row gets a green badge.
export const STATUS_COPY: Record<EvidenceRecord["status"], { label: string; tone: "danger" | "warn" | "outline" }> = {
  settled: { label: "runner reports: settled", tone: "outline" },
  reserved: { label: "runner reports: reserved, not settled", tone: "warn" },
  settlement_failed: { label: "runner reports: reserved, ft_transfer failed", tone: "warn" },
  rejected: { label: "runner reports: rejected", tone: "outline" },
  pending: { label: "runner reports: pending", tone: "outline" },
};

export type VerifiedLookup = (r: EvidenceRecord) => Verification | undefined;

// Verify each record once per distinct content. The effect keys on a content signature,
// not on array identity (arrays are rebuilt every render/poll), so a settled record is
// checked once, not in a loop. The returned lookup only yields a result whose fingerprint
// equals the CURRENT record's, so a changed record never shows its old result.
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

export function VerifyBadge({ v }: { v?: Verification }) {
  if (!v) return <Badge variant="outline">checking chain...</Badge>;
  if (v.state === "verified") return <Badge variant={v.onchain === "settled" ? "ok" : "outline"} className="gap-1"><BadgeCheck className="size-3" /> verified on chain: {v.onchain}</Badge>;
  if (v.state === "mismatch") return <Badge variant="danger" className="gap-1" title={v.detail}><ShieldAlert className="size-3" /> chain disagrees: {v.onchain}</Badge>;
  return <Badge variant="outline" className="gap-1" title={v.why}><CircleHelp className="size-3" /> not verified</Badge>;
}

export function VerifyDetail({ v }: { v?: Verification }) {
  if (!v) return null;
  const text = v.state === "unverifiable" ? v.why : v.state === "mismatch" ? v.detail
    : v.onchain === "rejected" && v.reason ? `chain code: ${v.reason}`
    : v.settlementReceiptId ? `ft_transfer receipt ${v.settlementReceiptId.slice(0, 8)}...` : null;
  return text ? <div className="mt-1 max-w-[220px] text-xs text-muted-foreground">{text}</div> : null;
}

// One row. Any unexpected value renders as an error row; it never takes the page down.
function Row({ r, v }: { r: EvidenceRecord; v?: Verification }) {
  let cells;
  try {
    const when = fmtBlockTime(r.block_timestamp_ns);
    cells = {
      amount: fmtEvidenceAmount(r.amount, r.token_decimals, r.token_symbol),
      status: STATUS_COPY[r.status] ?? { label: `runner reports: ${String(r.status)}`, tone: "outline" as const },
      when: when ?? "-",
      observed: typeof r.verified_at === "string" ? r.verified_at.replace("T", " ").slice(0, 16) : "-",
    };
  } catch (e) {
    return <tr><td colSpan={7} className="py-2 text-xs text-red-300">Record {String(r?.request_id ?? "?")} couldn&apos;t be displayed: {String((e as Error)?.message ?? e)}</td></tr>;
  }
  return (
    <tr className="align-top">
      <td className="py-2 font-mono text-xs">{r.request_id}{r.scenario && <Badge variant="outline" className="ml-1" title="scenario tag reported by the runner">{r.scenario}</Badge>}</td>
      <td className="font-mono text-xs">{short(r.agent_id, 10)} → {short(r.recipient_id, 10)}</td>
      <td title="symbol and decimals as reported by the runner, not read from chain">{cells.amount}</td>
      <td><Badge variant={cells.status.tone}>{cells.status.label}</Badge>{r.reason && <div className="mt-1 font-mono text-xs text-muted-foreground">runner reason: {r.reason}</div>}</td>
      <td><VerifyBadge v={v} /><VerifyDetail v={v} /><div className="mt-1 text-xs text-muted-foreground" title={`reported by ${r.source}`}>runner check {cells.observed}{r.proposal_id ? ` · policy #${r.proposal_id}` : ""}</div></td>
      <td className="text-xs">{cells.when}</td>
      <td><a className="flex items-center gap-1 text-xs text-primary hover:underline" href={txUrl(r.tx_hash)} target="_blank" rel="noreferrer">{r.tx_hash.slice(0, 8)}... <ExternalLink className="size-3" /></a></td>
    </tr>
  );
}

// Live payment history = the runner's evidence feed, each row re-checked against RPC.
// No sample rows, ever. No feed configured = an honest empty state.
export function PaymentHistory({ tokenId }: { tokenId: string }) {
  const ev = useView(() => loadEvidence(guard.contractId), []);
  const all = ev.data?.records;
  const records = useMemo(() => all?.filter((r) => r.token_id === tokenId), [all, tokenId]);
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
            <ViewBanner views={[ev]} what="payment evidence" />
            {records && !records.length && <p className="text-sm text-muted-foreground">The feed has no payments for this token yet.</p>}
            {ev.data && records && records.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-2">Request</th><th>Agent → recipient</th><th>Amount</th><th>Status</th><th>Chain check</th><th>Time (UTC)</th><th>Tx</th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {records.map((r) => <Row key={evidenceKey(ev.data!, r)} r={r} v={verified(r)} />)}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <p className="text-xs text-muted-foreground">&quot;Reserved&quot; means the guard approved the payment and counted it against today&apos;s limit. &quot;Settled&quot; means the token transfer itself also succeeded. A reservation is never released if the transfer later fails. A row is verified as settled only when the agent&apos;s pay call matches this request and the token&apos;s own ft_transfer receipt succeeded; a successful guard call alone stays &quot;reserved&quot;.</p>
      </CardContent>
    </Card>
  );
}
