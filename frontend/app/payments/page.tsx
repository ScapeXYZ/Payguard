"use client";
import { useState } from "react";
import { ArrowRight, Clock, Zap } from "lucide-react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Mono, Progress, WiredByYou } from "@/components/ui";
import { guard, MOCK_PAYMENTS, TOKENS, TOKEN_META, type TokenPolicy } from "@/lib/guard";
import { useTick, useView } from "@/lib/use-guard";
import { signAndSend } from "@/lib/wallet";
import { fmt, remaining } from "@/lib/utils";

const TOKEN = TOKENS[0];
const toRaw = (v: string) => {
  const d = TOKEN_META[TOKEN]?.decimals ?? 24;
  const [w, f = ""] = v.split(".");
  return (BigInt(w || "0") * 10n ** BigInt(d) + BigInt((f + "0".repeat(d)).slice(0, d) || "0")).toString();
};

// Same rule as setPolicy(): tighter on every axis = instant, anything looser = 24h pending.
function classify(old: TokenPolicy | null, next: TokenPolicy) {
  if (!old) return "new";
  const tighter = BigInt(next.max_per_payment) <= BigInt(old.max_per_payment) && BigInt(next.daily_limit) <= BigInt(old.daily_limit) && next.recipients.every((r) => old.recipients.includes(r));
  return tighter ? "instant" : "delayed";
}

export default function Payments() {
  useTick();
  const { data: policy } = useView(() => guard.get_policy(TOKEN));
  const { data: spending } = useView(() => guard.get_spending(TOKEN));
  const { data: pending } = useView(() => guard.get_pending_policy());
  const [edit, setEdit] = useState({ cap: "", daily: "", recipients: "" });

  const spent = BigInt(spending?.spent ?? "0");
  const daily = BigInt(policy?.daily_limit ?? "1");
  const pct = Number((spent * 100n) / (daily || 1n));
  const draft: TokenPolicy | null = edit.cap && edit.daily ? { max_per_payment: toRaw(edit.cap), daily_limit: toRaw(edit.daily), recipients: edit.recipients.split(",").map((s) => s.trim()).filter(Boolean) } : null;
  const kind = draft ? classify(policy ?? null, draft) : null;
  const cd = pending ? remaining(pending.activate_after) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Payments & caps</h1>
        <p className="text-muted-foreground">What the agent is allowed to spend, and what it already spent today (UTC).</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card><CardHeader><CardDescription>Max per payment</CardDescription><CardTitle className="text-2xl">{policy ? fmt(policy.max_per_payment, TOKEN) : "-"}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Daily limit</CardDescription><CardTitle className="text-2xl">{policy ? fmt(policy.daily_limit, TOKEN) : "-"}</CardTitle></CardHeader></Card>
        <Card>
          <CardHeader><CardDescription>Spent today</CardDescription><CardTitle className="text-2xl">{fmt(spent.toString(), TOKEN)}</CardTitle></CardHeader>
          <CardContent>
            <Progress value={pct} tone={pct > 90 ? "danger" : pct > 60 ? "warn" : "default"} />
            <p className="mt-2 text-xs text-muted-foreground">{policy ? fmt((daily - spent > 0n ? daily - spent : 0n).toString(), TOKEN) : "-"} left · resets 00:00 UTC</p>
          </CardContent>
        </Card>
      </div>

      {pending && cd && (
        <Card className="border-amber-500/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Clock className="size-5 text-amber-400" /> Policy change waiting · {cd.label}</CardTitle>
            <CardDescription>Looser rules wait 24h so you or the guardian can stop them. Proposal #{pending.proposal_id}.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Progress value={cd.pct} tone="warn" />
            <div className="grid gap-2 text-sm md:grid-cols-3">
              <Diff label="per payment" a={policy?.max_per_payment} b={pending.policy.max_per_payment} />
              <Diff label="daily" a={policy?.daily_limit} b={pending.policy.daily_limit} />
              <div className="rounded-lg border border-border p-3">
                <div className="text-xs text-muted-foreground">new recipients</div>
                {pending.policy.recipients.filter((r) => !policy?.recipients.includes(r)).map((r) => <Mono key={r}>{r}</Mono>)}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="destructive" onClick={() => signAndSend({ method: "cancel_policy", args: {} })}>Cancel change</Button>
              <Button variant="outline" disabled={!cd.done} onClick={() => signAndSend({ method: "activate_policy", args: { proposal_id: pending.proposal_id } })}>Activate {cd.done ? "" : "(after timer)"}</Button>
            </div>
            <WiredByYou method="cancel_policy · activate_policy" />
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Allowed recipients</CardTitle><CardDescription>The agent can pay nobody else.</CardDescription></CardHeader>
          <CardContent className="flex flex-wrap gap-2">{policy?.recipients.map((r) => <Badge key={r} variant="outline" className="font-mono">{r}</Badge>)}</CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Change the rules</CardTitle><CardDescription>Tighter applies instantly. Looser waits 24h.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Per payment ({TOKEN_META[TOKEN]?.symbol})</Label><Input inputMode="decimal" value={edit.cap} onChange={(e) => setEdit({ ...edit, cap: e.target.value })} placeholder="50" /></div>
              <div><Label>Daily ({TOKEN_META[TOKEN]?.symbol})</Label><Input inputMode="decimal" value={edit.daily} onChange={(e) => setEdit({ ...edit, daily: e.target.value })} placeholder="120" /></div>
            </div>
            <div><Label>Recipients (comma separated)</Label><Input value={edit.recipients} onChange={(e) => setEdit({ ...edit, recipients: e.target.value })} placeholder={policy?.recipients.join(", ")} /></div>
            {kind && (
              <div className="flex items-center gap-2 text-sm">
                {kind === "instant" ? <><Zap className="size-4 text-emerald-400" /> Tighter: applies the moment you sign.</> : kind === "new" ? <>First policy for this token: queued for 24h.</> : <><Clock className="size-4 text-amber-400" /> Looser: the tighter half applies now, the rest waits 24h.</>}
              </div>
            )}
            {draft && BigInt(draft.max_per_payment) > BigInt(draft.daily_limit) && <p className="text-xs text-red-400">per-payment cap can't exceed the daily limit</p>}
            <Button disabled={!draft || BigInt(draft.max_per_payment) > BigInt(draft.daily_limit)} onClick={() => draft && signAndSend({ method: "set_policy", args: { token_id: TOKEN, ...draft } })}>Review & sign</Button>
            <WiredByYou method="set_policy" />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Recent agent payments</CardTitle><CardDescription>Blocked attempts show which rule stopped them. (sample data until an indexer is wired)</CardDescription></CardHeader>
        <CardContent>
          <div className="divide-y divide-border text-sm">
            {MOCK_PAYMENTS.map((p) => (
              <div key={p.request_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="font-mono text-xs text-muted-foreground">{p.request_id}</span>
                <span className="flex items-center gap-2"><ArrowRight className="size-3" /><Mono>{p.recipient_id}</Mono></span>
                <span>{fmt(p.amount, TOKEN)}</span>
                <Badge variant={p.status === "paid" ? "ok" : "danger"}>{p.status}</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Diff({ label, a, b }: { label: string; a?: string; b: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div>{a ? fmt(a, TOKEN) : "-"} <ArrowRight className="inline size-3" /> <span className="text-amber-300">{fmt(b, TOKEN)}</span></div>
    </div>
  );
}
