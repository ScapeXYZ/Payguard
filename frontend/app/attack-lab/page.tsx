"use client";
import { CheckCircle2, ExternalLink, FileJson, FlaskConical, Hourglass, ShieldX } from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Mono } from "@/components/ui";
import { ViewBanner } from "@/components/view-state";
import { STATUS_COPY, VerifyBadge, VerifyDetail, fmtEvidenceAmount, reasonText, useVerified } from "@/components/payment-history";
import { guard, IS_MOCK, TOKENS } from "@/lib/guard";
import { useView } from "@/lib/use-guard";
import { useToken } from "@/lib/use-token";
import { EMPTY_EVIDENCE_TEXT, EVIDENCE_URL, evidenceKey, loadEvidence, type EvidenceFile, type EvidenceRecord, type Scenario } from "@/lib/evidence";
import { CONTRACT_ERRORS } from "@/lib/errors";
import { txUrl } from "@/lib/near-rpc";
import { cn } from "@/lib/utils";

// Each scenario names the exact check in reserve() (contract/policy.ts) that decides it.
const SCENARIOS: { id: Scenario; title: string; attack: string; expect: "settled" | "rejected"; code?: string; check: string }[] = [
  { id: "A", title: "Legitimate payment", attack: "Agent requests 3 USDC to an allowlisted merchant, inside every limit.", expect: "settled", check: "all checks pass → budget reserved → ft_transfer receipt to merchant succeeds (settled needs that receipt)" },
  { id: "B", title: "Overspending attack", attack: "Agent requests 15 USDC; the per-payment cap is 5 USDC.", expect: "rejected", code: "max_per_payment", check: "units <= policy.max_per_payment" },
  { id: "C", title: "Unauthorized recipient", attack: "Agent tries to pay an account that isn't on the allowlist.", expect: "rejected", code: "unapproved_recipient", check: "policy.recipients.includes(recipient_id)" },
  { id: "D", title: "Daily spending limit", attack: "Agent keeps paying until today's budget is used up; the next payment must fail.", expect: "rejected", code: "daily_limit", check: "units <= daily_limit - spent_today" },
  { id: "E", title: "Replay attempt", attack: "Agent reuses a request id that was already paid.", expect: "rejected", code: "duplicate_request", check: "request:<id> not yet stored" },
];

export default function AttackLab() {
  const ev = useView(() => loadEvidence(guard.contractId), []);
  const records = ev.data?.records ?? [];
  const verified = useVerified(ev.data, ev.data?.records);
  const policy = useView(() => guard.get_policy(TOKENS[0]));
  const token = useToken(TOKENS[0]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><FlaskConical className="size-6 text-primary" /> Attack Lab</h1>
        <p className="text-muted-foreground">Five things a misbehaving AI agent might try, and the on-chain rule that stops each one. Every result here comes from a real testnet transaction, re-checked against the chain in your browser.</p>
      </div>

      <Card className="border-amber-500/40">
        <CardContent className="flex items-start gap-3 pt-5 text-sm">
          <FileJson className="mt-0.5 size-5 shrink-0 text-amber-400" />
          <div>
            <b>Proposed interface.</b> Payments are signed only by the agent payment runner (server-side, restricted key); this page never signs and never holds the agent key. Scenario results load from the runner&apos;s evidence feed (<Mono>docs/EVIDENCE_FORMAT.md</Mono> v2). {!EVIDENCE_URL || IS_MOCK ? "No feed is connected yet, so every scenario below is awaiting verified testnet evidence. Nothing is simulated." : null}
          </div>
        </CardContent>
      </Card>

      {EVIDENCE_URL && !IS_MOCK && <ViewBanner views={[ev]} what="evidence feed" from="the evidence feed" />}
      {ev.data && !ev.data.records.length && <p className="text-sm text-muted-foreground">{EMPTY_EVIDENCE_TEXT}. An empty export doesn&apos;t prove there were no on-chain payments.</p>}
      {ev.data && ev.data.records.length > 0 && !ev.data.records.some((r) => r.scenario) && <p className="text-sm text-muted-foreground">The evidence has payments but none is tagged with a scenario, so no Attack Lab result is claimed from it.</p>}

      <Card>
        <CardHeader><CardTitle className="text-base">Rules in force right now</CardTitle><CardDescription>Live from the guard, so you can check each verdict against them.</CardDescription></CardHeader>
        <CardContent className="text-sm">
          {policy.data === undefined ? "..." : policy.data === null ? <span className="text-muted-foreground">No active policy for {token.meta?.symbol ?? "this token"} yet: right now every payment fails with <Mono>unknown_token</Mono>.</span>
            : <span>Max <b>{token.fmt(policy.data.max_per_payment)}</b> per payment · <b>{token.fmt(policy.data.daily_limit)}</b> per UTC day · only to {policy.data.recipients.map((r) => <Mono key={r}>{r}</Mono>)}</span>}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {SCENARIOS.map((s) => <ScenarioCard key={s.id} s={s} file={ev.data ?? null} records={records.filter((r) => r.scenario === s.id)} verified={verified} />)}
      </div>
    </div>
  );
}

function ScenarioCard({ s, file, records, verified }: { s: (typeof SCENARIOS)[number]; file: EvidenceFile | null; records: EvidenceRecord[]; verified: ReturnType<typeof useVerified> }) {
  const kOf = (r: EvidenceRecord) => (file ? evidenceKey(file, r) : r.request_id);
  // The deciding record: for D the last one (the payment that tipped over the limit).
  const key = s.id === "D" ? records.filter((r) => r.status === "rejected").at(-1) ?? records.at(-1) : records.at(-1);
  const v = key ? verified(key) : undefined;  // only a result for exactly this record's content
  const matchesExpectation = key && v?.state === "verified" && v.onchain === s.expect && (s.expect !== "rejected" || v.chainCode === s.code);
  const tone = !key ? "border-dashed" : matchesExpectation ? (s.expect === "settled" ? "border-emerald-500/40" : "border-red-500/40") : "border-amber-500/40";
  return (
    <Card className={cn(tone)}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2"><Badge variant="outline">{s.id}</Badge> {s.title}</CardTitle>
        <CardDescription>{s.attack}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="rounded-lg bg-muted/50 p-3 text-xs">
          <div className="text-muted-foreground">contract check</div>
          <div className="font-mono">{s.check}</div>
          <div className="mt-1 text-muted-foreground">expected: {s.expect === "settled" ? "payment settles" : <>rejected with <Mono>{s.code!}</Mono>: {CONTRACT_ERRORS[s.code!]}</>}</div>
        </div>
        {!key ? (
          <div className="flex items-center gap-2 text-muted-foreground"><Hourglass className="size-4" /> Awaiting verified testnet evidence.</div>
        ) : (
          <div className="space-y-2">
            {records.map((r) => (
              <div key={kOf(r)} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2">
                <span className="font-mono text-xs">{r.request_id} · {fmtEvidenceAmount(r.amount, r)} → {r.recipient_id}</span>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant={STATUS_COPY[r.status].tone}>{r.reason ? `runner reports: ${reasonText(r.reason)}` : STATUS_COPY[r.status].label}</Badge>
                  <VerifyBadge v={verified(r)} status={r.status} />
                  <VerifyDetail v={verified(r)} />
                  {r.tx_hash && <a className="flex items-center gap-1 text-xs text-primary hover:underline" href={txUrl(r.tx_hash)} target="_blank" rel="noreferrer">tx <ExternalLink className="size-3" /></a>}
                </span>
              </div>
            ))}
            {s.id === "A" && key.recipient_balance_before && key.recipient_balance_after && (
              <p className="text-xs text-muted-foreground">Merchant balance (reported by the runner): {fmtEvidenceAmount(key.recipient_balance_before, key)} → {fmtEvidenceAmount(key.recipient_balance_after, key)}</p>
            )}
            <div className={cn("flex items-center gap-2 font-medium", matchesExpectation ? (s.expect === "settled" ? "text-emerald-400" : "text-red-300") : "text-amber-300")}>
              {matchesExpectation ? (s.expect === "settled" ? <CheckCircle2 className="size-4" /> : <ShieldX className="size-4" />) : <Hourglass className="size-4" />}
              {matchesExpectation ? (s.expect === "settled" ? "Paid: the pay call settled, verified on chain." : `Blocked: the pay call failed with ${s.code}, verified on chain.`) : v ? `Runner reports ${reasonText(key.reason) ?? key.status}; not verified on chain as the expected outcome.` : "Checking the chain..."}
            </div>
            <div className="text-xs text-muted-foreground">Scenario tag {s.id} is reported by the runner; the chain proves the outcome of this pay call, not the intent behind it.
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
