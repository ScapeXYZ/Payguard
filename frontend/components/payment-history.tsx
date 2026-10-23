"use client";
import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, CircleHelp, ExternalLink, FileJson, ShieldAlert } from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Mono } from "./ui";
import { ViewBanner } from "./view-state";
import { guard, IS_MOCK } from "@/lib/guard";
import { useView } from "@/lib/use-guard";
import { EMPTY_EVIDENCE_TEXT, EVIDENCE_URL, GENERIC_GUARD_FAILURE, evidenceKey, loadEvidence, verifyRecord, type EvidenceFile, type EvidenceRecord, type Verification } from "@/lib/evidence";
import { formatUnits } from "@/lib/amount";
import { txUrl } from "@/lib/near-rpc";
import { short } from "@/lib/utils";

// Labels follow the exporter's status rules. Only "settled" says tokens moved, and nothing
// pending, reserved or unverified ever gets a green (success) badge.
export const STATUS_COPY: Record<EvidenceRecord["status"], { label: string; tone: "ok" | "danger" | "warn" | "outline" }> = {
  settled: { label: "settled: ft_transfer receipt succeeded", tone: "ok" },
  reserved: { label: "reserved: transfer not confirmed", tone: "warn" },
  settlement_failed: { label: "reserved, ft_transfer failed", tone: "danger" },
  rejected: { label: "rejected by the guard", tone: "danger" },
  pending: { label: "pending: outcome unresolved", tone: "outline" },
};

export const UNKNOWN = "Unknown";
// Unknown decimals = raw base units, never a guessed USDC conversion.
export const fmtEvidenceAmount = (raw: string, r: Pick<EvidenceRecord, "token_decimals" | "token_symbol">) =>
  r.token_decimals === null ? `${raw} base units${r.token_symbol ? ` ${r.token_symbol}` : ""}` : `${formatUnits(raw, r.token_decimals)} ${r.token_symbol ?? `(${UNKNOWN} token)`}`;
export const reasonText = (reason: string | null) =>
  reason === GENERIC_GUARD_FAILURE ? "guard execution failed (specific code not in the export)" : reason === "ft_transfer_failed" ? "token transfer failed" : reason;

// Re-check each record once per distinct (key, status, tx). The records array is rebuilt on
// every render, so the effect keys on a content signature, not the array identity.
export function useVerified(file: EvidenceFile | null | undefined, records: EvidenceRecord[] | undefined) {
  const [v, setV] = useState<Record<string, Verification>>({});
  const sig = useMemo(() => (file && records ? records.map((r) => `${evidenceKey(file, r)}|${r.status}|${r.tx_hash}|${r.settlement_receipt_id}`).join(";") : ""), [file, records]);
  useEffect(() => {
    if (!file || !records?.length) return;
    let alive = true;
    (async () => {
      for (const r of records) {
        if (!alive) return;
        const res = await verifyRecord(r, guard.contractId);
        if (alive) setV((p) => ({ ...p, [evidenceKey(file, r)]: res }));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return v;
}

export function VerifyBadge({ v, status }: { v?: Verification; status?: EvidenceRecord["status"] }) {
  if (!v) return <Badge variant="outline">checking chain...</Badge>;
  if (v.state === "verified") return <Badge variant={v.onchain === "settled" ? "ok" : "outline"} className="gap-1"><BadgeCheck className="size-3" /> verified on chain</Badge>;
  // Null tx_hash / verified_at: never green, never "verified", even when the chain matches.
  if (v.state === "unavailable") return <Badge variant={status === "pending" ? "outline" : "warn"} className="gap-1" title={v.why}><CircleHelp className="size-3" /> verification unavailable</Badge>;
  if (v.state === "mismatch") return <Badge variant="danger" className="gap-1" title={v.detail}><ShieldAlert className="size-3" /> chain disagrees: {v.onchain}</Badge>;
  return <Badge variant="outline" className="gap-1" title={v.why}><CircleHelp className="size-3" /> not verified</Badge>;
}

export function VerifyDetail({ v }: { v?: Verification }) {
  if (!v) return null;
  const failure = (c: { onchain: string; chainCode: string | null; chainFailureText: string | null }) =>
    c.chainCode ? `chain code: ${c.chainCode}` : c.chainFailureText ? `raw failure text (${c.onchain === "settlement_failed" ? "token" : "guard"} receipt): ${c.chainFailureText}` : null;
  const text = v.state === "unverifiable" ? v.why
    : v.state === "unavailable" ? (v.chain ? `${v.why}. chain shows ${v.chain.onchain}${v.chain.agrees ? "" : ` (${v.chain.detail})`}${failure(v.chain) ? `; ${failure(v.chain)}` : ""}` : v.why)
    : v.state === "mismatch" ? v.detail
    : failure(v) ?? (v.settlementReceiptId ? `ft_transfer receipt ${v.settlementReceiptId.slice(0, 8)}...` : null);
  return text ? <div className="mt-1 max-w-[220px] text-xs text-muted-foreground">{text}</div> : null;
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
        <CardDescription>From the agent payment runner&apos;s evidence feed. Every row is re-read from chain; a row only shows &quot;verified&quot; when the transaction outcome matches.</CardDescription>
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
            {records && records.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-2">Request</th><th>Agent → recipient</th><th>Amount</th><th>Status</th><th>Chain check</th><th>Time (UTC)</th><th>Tx</th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {records.map((r) => { const k = evidenceKey(ev.data!, r); return (
                      <tr key={k} className="align-top">
                        <td className="py-2 font-mono text-xs">{r.request_id}{r.scenario && <Badge variant="outline" className="ml-1">{r.scenario}</Badge>}</td>
                        <td className="font-mono text-xs">{short(r.agent_id, 10)} → {short(r.recipient_id, 10)}</td>
                        <td>{fmtEvidenceAmount(r.amount, r)}</td>
                        <td><Badge variant={STATUS_COPY[r.status].tone}>{STATUS_COPY[r.status].label}</Badge>{r.reason && <div className="mt-1 text-xs text-red-300">{reasonText(r.reason)}</div>}</td>
                        <td><VerifyBadge v={verified[k]} status={r.status} /><VerifyDetail v={verified[k]} /><div className="mt-1 text-xs text-muted-foreground" title={r.note ?? undefined}>{r.source}: observed {r.verified_at ? r.verified_at.replace("T", " ").slice(0, 16) : UNKNOWN}{r.proposal_id ? ` · proposal #${r.proposal_id}` : ""}</div></td>
                        <td className="text-xs">{r.block_timestamp_ns ? new Date(Number(BigInt(r.block_timestamp_ns) / 1_000_000n)).toISOString().replace("T", " ").slice(0, 19) : UNKNOWN}</td>
                        <td>{r.tx_hash ? <a className="flex items-center gap-1 text-xs text-primary hover:underline" href={txUrl(r.tx_hash)} target="_blank" rel="noreferrer">{r.tx_hash.slice(0, 8)}... <ExternalLink className="size-3" /></a> : <span className="text-xs text-muted-foreground">{UNKNOWN}</span>}</td>
                      </tr>
                    ); })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <p className="text-xs text-muted-foreground">&quot;Reserved&quot; means the guard approved the payment, counted it against today&apos;s limit and issued the transfer, but the transfer&apos;s completion isn&apos;t confirmed. &quot;Settled&quot; means the token transfer itself also succeeded. A reservation is never released if the transfer later fails. A row is shown as settled only when the token&apos;s own ft_transfer receipt is found on chain and succeeded; a successful guard call alone stays &quot;reserved&quot;.</p>
      </CardContent>
    </Card>
  );
}
