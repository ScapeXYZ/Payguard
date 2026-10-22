"use client";
import { useEffect, useState } from "react";
import { BadgeCheck, CircleHelp, ExternalLink, FileJson, ShieldAlert } from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Mono } from "./ui";
import { ViewBanner } from "./view-state";
import { guard, IS_MOCK } from "@/lib/guard";
import { useView } from "@/lib/use-guard";
import { EVIDENCE_URL, loadEvidence, verifyRecord, type EvidenceRecord, type Verification } from "@/lib/evidence";
import { formatUnits } from "@/lib/amount";
import { txUrl } from "@/lib/near-rpc";
import { short } from "@/lib/utils";

export const STATUS_COPY: Record<EvidenceRecord["status"], { label: string; tone: "ok" | "danger" | "warn" | "outline" }> = {
  settled: { label: "settled: tokens moved", tone: "ok" },
  reserved: { label: "authorized + budget reserved", tone: "warn" },
  settlement_failed: { label: "reserved, transfer failed", tone: "danger" },
  rejected: { label: "blocked by contract", tone: "danger" },
  pending: { label: "pending", tone: "outline" },
};

export function useVerified(records: EvidenceRecord[] | undefined) {
  const [v, setV] = useState<Record<string, Verification>>({});
  useEffect(() => {
    if (!records?.length) return;
    let alive = true;
    (async () => {
      for (const r of records) {
        if (!alive) return;
        const res = await verifyRecord(r, guard.contractId);
        if (alive) setV((p) => ({ ...p, [r.tx_hash]: res }));
      }
    })();
    return () => { alive = false; };
  }, [records]);
  return v;
}

export function VerifyBadge({ v }: { v?: Verification }) {
  if (!v) return <Badge variant="outline">checking chain...</Badge>;
  if (v.state === "verified") return <Badge variant="ok" className="gap-1"><BadgeCheck className="size-3" /> verified on chain</Badge>;
  if (v.state === "mismatch") return <Badge variant="danger" className="gap-1" title={`chain says ${v.onchain}${v.reason ? ` (${v.reason})` : ""}`}><ShieldAlert className="size-3" /> chain disagrees: {v.onchain}</Badge>;
  return <Badge variant="outline" className="gap-1" title={v.why}><CircleHelp className="size-3" /> not verified</Badge>;
}

// Live payment history = the runner's evidence feed, each row re-checked against RPC.
// No sample rows, ever. No feed configured = an honest empty state.
export function PaymentHistory({ tokenId }: { tokenId: string }) {
  const ev = useView(() => loadEvidence(guard.contractId), []);
  const records = ev.data?.records.filter((r) => r.token_id === tokenId);
  const verified = useVerified(records);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent payment activity</CardTitle>
        <CardDescription>From the agent payment runner&apos;s evidence feed. Every row is re-read from chain; a row only shows &quot;verified&quot; when the transaction outcome matches.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!EVIDENCE_URL || IS_MOCK ? (
          <div className="flex items-start gap-3 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            <FileJson className="mt-0.5 size-5 shrink-0" />
            <div>No evidence feed connected yet. The payment runner&apos;s output format is being agreed (proposed: <Mono>docs/EVIDENCE_FORMAT.md</Mono>); set <Mono>NEXT_PUBLIC_EVIDENCE_URL</Mono> to its JSON once it exists. Nothing is shown until then: no sample data.</div>
          </div>
        ) : (
          <>
            <ViewBanner views={[ev]} what="payment evidence" />
            {records && !records.length && <p className="text-sm text-muted-foreground">The feed has no payments for this token yet.</p>}
            {records && records.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-2">Request</th><th>Agent → recipient</th><th>Amount</th><th>Status</th><th>Chain check</th><th>Time (UTC)</th><th>Tx</th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {records.map((r) => (
                      <tr key={r.tx_hash} className="align-top">
                        <td className="py-2 font-mono text-xs">{r.request_id}{r.scenario && <Badge variant="outline" className="ml-1">{r.scenario}</Badge>}</td>
                        <td className="font-mono text-xs">{short(r.agent_id, 10)} → {short(r.recipient_id, 10)}</td>
                        <td>{formatUnits(r.amount, r.token_decimals)} {r.token_symbol}</td>
                        <td><Badge variant={STATUS_COPY[r.status].tone}>{STATUS_COPY[r.status].label}</Badge>{r.reason && <div className="mt-1 font-mono text-xs text-red-300">{r.reason}</div>}</td>
                        <td><VerifyBadge v={verified[r.tx_hash]} /></td>
                        <td className="text-xs">{r.block_timestamp_ns ? new Date(Number(BigInt(r.block_timestamp_ns) / 1_000_000n)).toISOString().replace("T", " ").slice(0, 19) : "-"}</td>
                        <td><a className="flex items-center gap-1 text-xs text-primary hover:underline" href={txUrl(r.tx_hash)} target="_blank" rel="noreferrer">{r.tx_hash.slice(0, 8)}... <ExternalLink className="size-3" /></a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <p className="text-xs text-muted-foreground">&quot;Authorized + budget reserved&quot; means the guard approved the payment and counted it against today&apos;s limit. &quot;Settled&quot; means the token transfer itself also succeeded. A reservation is never released if the transfer later fails.</p>
      </CardContent>
    </Card>
  );
}
