"use client";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, BadgeCheck, Clock, Plus, ShieldOff, X, Zap, AlertTriangle } from "lucide-react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Mono, Progress } from "@/components/ui";
import { TxButton } from "@/components/tx";
import { ViewBanner } from "@/components/view-state";
import { PaymentHistory } from "@/components/payment-history";
import { guard, TOKENS, type TokenPolicy } from "@/lib/guard";
import { useTick, useView } from "@/lib/use-guard";
import { useToken, type TokenInfo } from "@/lib/use-token";
import { parseUnits } from "@/lib/amount";
import { remaining, short } from "@/lib/utils";

const ACCOUNT_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const validAccount = (v: string) => v.length >= 2 && v.length <= 64 && ACCOUNT_RE.test(v);

// Same rule as setPolicy() in contract/policy.ts.
function classify(old: TokenPolicy | null, next: TokenPolicy): "new" | "instant" | "mixed" {
  if (!old) return "new";
  const tighter = BigInt(next.max_per_payment) <= BigInt(old.max_per_payment) && BigInt(next.daily_limit) <= BigInt(old.daily_limit) && next.recipients.every((r) => old.recipients.includes(r));
  return tighter ? "instant" : "mixed";
}

export default function Payments() {
  useTick();
  const [tokenId, setTokenId] = useState(TOKENS[0]);
  const token = useToken(tokenId);
  const config = useView(() => guard.get_config());
  const policy = useView(() => guard.get_policy(tokenId), [tokenId]);
  const spending = useView(() => guard.get_spending(tokenId), [tokenId]);
  const pending = useView(() => guard.get_pending_policy());
  const recovery = useView(() => guard.get_pending_owner_recovery());

  const active = policy.data ?? null;
  const pend = pending.data && pending.data.token_id === tokenId ? pending.data : null;
  const pendOther = pending.data && pending.data.token_id !== tokenId ? pending.data : null;
  const cd = pend ? remaining(pend.activate_after) : null;
  const spent = spending.data ? BigInt(spending.data.spent) : null;
  const daily = active ? BigInt(active.daily_limit) : null;
  const pct = spent !== null && daily ? Number((spent * 10_000n) / daily) / 100 : 0;
  const left = spent !== null && daily !== null ? (daily > spent ? daily - spent : 0n) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Payments & caps</h1>
          <p className="text-muted-foreground">What the agent can spend right now, what&apos;s waiting to change, and the evidence of what it did.</p>
        </div>
        <TokenPicker value={tokenId} onChange={setTokenId} token={token} />
      </div>

      <ViewBanner views={[config, policy, spending, pending]} />

      {/* ACTIVE: what the contract enforces today */}
      <section aria-label="Active policy" className="space-y-3">
        <div className="flex items-center gap-2"><Badge variant="ok">ACTIVE</Badge><span className="text-sm text-muted-foreground">enforced by the contract on every payment, right now</span></div>
        {policy.data === null ? (
          <Card className="border-border"><CardContent className="flex items-start gap-3 pt-5 text-sm">
            <ShieldOff className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div><div className="font-medium">No active policy for {token.meta?.symbol ?? short(tokenId)}.</div>
              <div className="text-muted-foreground">The agent can&apos;t pay anything in this token. Every pay call fails with <Mono>unknown_token</Mono>{pend ? "; the pending policy below becomes active only after its timelock and an activate call." : "."}</div></div>
          </CardContent></Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            <Stat label="Max per payment" value={active ? token.fmt(active.max_per_payment) : "..."} />
            <Stat label="Daily limit" value={active ? token.fmt(active.daily_limit) : "..."} />
            <Card>
              <CardHeader><CardDescription>Spent today (UTC day {spending.data?.day ?? "..."})</CardDescription><CardTitle className="text-2xl">{spent !== null ? token.fmt(spent.toString()) : "..."}</CardTitle></CardHeader>
              <CardContent>
                <Progress value={pct} tone={pct > 90 ? "danger" : pct > 60 ? "warn" : "default"} />
                <p className="mt-2 text-xs text-muted-foreground">{left !== null ? `${token.fmt(left.toString())} left` : "..."} · resets 00:00 UTC</p>
              </CardContent>
            </Card>
          </div>
        )}
        {active && (
          <Card>
            <CardHeader><CardTitle className="text-base">Allowed recipients</CardTitle><CardDescription>The agent can pay nobody else.</CardDescription></CardHeader>
            <CardContent className="flex flex-wrap gap-2">{active.recipients.length ? active.recipients.map((r) => <Badge key={r} variant="outline" className="font-mono">{r}</Badge>) : <span className="text-sm text-muted-foreground">none: every payment is blocked</span>}</CardContent>
          </Card>
        )}
      </section>

      {/* PENDING: proposed, not enforced */}
      <section aria-label="Pending policy" className="space-y-3">
        <div className="flex items-center gap-2"><Badge variant="warn">PENDING</Badge><span className="text-sm text-muted-foreground">proposed, not enforced until activated</span></div>
        {pendOther && <p className="text-sm text-muted-foreground">A change is pending for another token (<Mono>{short(pendOther.token_id)}</Mono>). Only one policy change can be pending at a time.</p>}
        {!pend ? (
          <p className="text-sm text-muted-foreground">{pending.data === undefined ? "..." : "No pending change for this token."}</p>
        ) : (
          <Card className="border-amber-500/40">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2"><Clock className="size-5 text-amber-400" /> Proposal #{pend.proposal_id} · {cd!.done ? "timelock finished" : `activates in ${cd!.label}`}</CardTitle>
              <CardDescription>Earliest activation {cd!.at} (block time). Until someone calls activate, the active policy above still applies.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Progress value={cd!.pct} tone="warn" />
              <div className="grid gap-2 text-sm md:grid-cols-3">
                <Diff label="per payment" a={active?.max_per_payment} b={pend.policy.max_per_payment} token={token} />
                <Diff label="daily" a={active?.daily_limit} b={pend.policy.daily_limit} token={token} />
                <div className="rounded-lg border border-border p-3">
                  <div className="text-xs text-muted-foreground">recipients</div>
                  {pend.policy.recipients.map((r) => <div key={r}><Mono>{r}</Mono>{!active?.recipients.includes(r) && <span className="ml-1 text-xs text-amber-300">new</span>}</div>)}
                  {active?.recipients.filter((r) => !pend.policy.recipients.includes(r)).map((r) => <div key={r} className="line-through opacity-60"><Mono>{r}</Mono></div>)}
                </div>
              </div>
              {recovery.data && <p className="flex items-center gap-2 text-sm text-amber-300"><AlertTriangle className="size-4" /> An owner recovery is pending: activation is blocked (<Mono>recovery_pending</Mono>).</p>}
              <div className="grid gap-3 md:grid-cols-2">
                <TxButton config={config.data} allowed={["owner", "guardian"]} variant="destructive" label="Cancel / veto this change"
                  call={{ method: "cancel_policy", args: {} }} />
                <TxButton config={config.data} allowed={["anyone"]} variant="outline" label={cd!.done ? "Activate" : "Activate (after timelock)"}
                  disabled={!cd!.done || !!recovery.data} disabledWhy={!cd!.done ? "timelock still running" : "owner recovery pending"}
                  call={{ method: "activate_policy", args: { proposal_id: pend.proposal_id } }} />
              </div>
              <p className="text-xs text-muted-foreground">Owner or guardian can cancel. Any account can activate once the timelock is over; it can only apply exactly this proposal.</p>
            </CardContent>
          </Card>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <EditPolicy tokenId={tokenId} token={token} active={active} activeKnown={policy.data !== undefined} pendingExists={!!pending.data} recoveryPending={!!recovery.data} configData={config.data} />
        <Card>
          <CardHeader><CardTitle>Turn off this token</CardTitle><CardDescription>Owner only. Instantly removes the active policy and drops any pending change, so the agent can&apos;t pay in this token at all.</CardDescription></CardHeader>
          <CardContent>
            <TxButton config={config.data} allowed={["owner"]} variant="destructive" label="Disable policy" disabled={!active && !pend} disabledWhy="nothing to disable"
              call={{ method: "disable_policy", args: { token_id: tokenId } }} />
          </CardContent>
        </Card>
      </div>

      <PaymentHistory tokenId={tokenId} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <Card><CardHeader><CardDescription>{label}</CardDescription><CardTitle className="break-all text-2xl">{value}</CardTitle></CardHeader></Card>;
}

function Diff({ label, a, b, token }: { label: string; a?: string; b: string; token: TokenInfo }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="break-all">{a ? token.fmt(a) : "none"} <ArrowRight className="inline size-3" /> <span className="text-amber-300">{token.fmt(b)}</span></div>
    </div>
  );
}

function TokenPicker({ value, onChange, token }: { value: string; onChange: (t: string) => void; token: TokenInfo }) {
  return (
    <div className="space-y-1 text-right">
      <div className="flex flex-wrap justify-end gap-2">
        {TOKENS.map((t) => <Button key={t} size="sm" variant={t === value ? "default" : "outline"} onClick={() => onChange(t)} className="font-mono">{t === value && token.meta ? token.meta.symbol : short(t, 6)}</Button>)}
      </div>
      <div className="text-xs">
        {token.loading ? <span className="text-muted-foreground">reading token metadata...</span>
          : token.error ? <span className="text-red-400">token metadata unreadable: amounts shown in base units, editing off</span>
          : token.mismatch ? <span className="text-red-400">metadata mismatch: {token.mismatch}</span>
          : token.verified ? <span className="flex items-center justify-end gap-1 text-emerald-400"><BadgeCheck className="size-3" /> {token.meta!.name} · {token.meta!.decimals} decimals · read from <Mono>{short(value, 6)}</Mono></span>
          : <span className="text-amber-300">mock token</span>}
      </div>
    </div>
  );
}

function EditPolicy({ tokenId, token, active, activeKnown, pendingExists, recoveryPending, configData }: {
  tokenId: string; token: TokenInfo; active: TokenPolicy | null; activeKnown: boolean; pendingExists: boolean; recoveryPending: boolean;
  configData: Parameters<typeof TxButton>[0]["config"];
}) {
  const [cap, setCap] = useState("");
  const [daily, setDaily] = useState("");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [add, setAdd] = useState("");
  const [seededFor, setSeededFor] = useState<string | null>(null);

  // Start from the ACTIVE allowlist so editing a limit never drops recipients by accident.
  useEffect(() => {
    if (!activeKnown || seededFor === tokenId) return;
    setRecipients(active?.recipients ?? []);
    setCap(""); setDaily(""); setSeededFor(tokenId);
  }, [activeKnown, active, tokenId, seededFor]);

  const dec = token.meta?.decimals;
  const capP = dec !== undefined && cap ? parseUnits(cap, dec) : null;
  const dailyP = dec !== undefined && daily ? parseUnits(daily, dec) : null;
  // Blank cap/daily = keep the active value (only allowed when there is one).
  const capRaw = capP?.ok ? capP.raw : !cap && active ? active.max_per_payment : null;
  const dailyRaw = dailyP?.ok ? dailyP.raw : !daily && active ? active.daily_limit : null;
  const removed = (active?.recipients ?? []).filter((r) => !recipients.includes(r));
  const added = recipients.filter((r) => !(active?.recipients ?? []).includes(r));
  const addErr = add && !validAccount(add.toLowerCase()) ? "not a valid NEAR account id" : add && recipients.includes(add.toLowerCase()) ? "already listed" : null;

  const draft: TokenPolicy | null = capRaw && dailyRaw ? { max_per_payment: capRaw, daily_limit: dailyRaw, recipients } : null;
  const unchanged = !!draft && !!active && draft.max_per_payment === active.max_per_payment && draft.daily_limit === active.daily_limit && !added.length && !removed.length;
  const capOverDaily = draft && BigInt(draft.max_per_payment) > BigInt(draft.daily_limit);
  const kind = draft ? classify(active, draft) : null;
  const blockedByPending = kind !== "instant" && pendingExists;
  const blockedByRecovery = kind !== "instant" && recoveryPending;
  const err = !token.meta ? "token metadata not verified" : capP && !capP.ok ? `per payment: ${capP.error}` : dailyP && !dailyP.ok ? `daily: ${dailyP.error}`
    : !draft ? (active ? null : "first policy: enter both amounts") : capOverDaily ? "per-payment cap can't exceed the daily limit"
    : recipients.length > 100 ? "at most 100 recipients" : unchanged ? "nothing changed"
    : blockedByPending ? "a policy change is already pending; cancel it or let it activate first (pending_policy_exists)"
    : blockedByRecovery ? "owner recovery pending; only tightening is allowed (recovery_pending)" : null;
  const call = useMemo(() => (draft && !err ? { method: "set_policy" as const, args: { token_id: tokenId, ...draft } } : null), [draft, err, tokenId]);

  return (
    <Card>
      <CardHeader><CardTitle>Change the rules</CardTitle><CardDescription>Owner only. Tighter on every axis applies instantly. Anything looser: the tighter part applies now, the rest waits 24h and can be vetoed.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><Label>Per payment ({token.meta?.symbol ?? "?"})</Label><Input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder={active ? `keep ${token.fmt(active.max_per_payment)}` : "5"} />
            {capP && !capP.ok && <p className="mt-1 text-xs text-red-400">{capP.error}</p>}</div>
          <div><Label>Daily ({token.meta?.symbol ?? "?"})</Label><Input inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} placeholder={active ? `keep ${token.fmt(active.daily_limit)}` : "20"} />
            {dailyP && !dailyP.ok && <p className="mt-1 text-xs text-red-400">{dailyP.error}</p>}</div>
        </div>
        <div>
          <Label>Recipients {active ? "(starts from the active allowlist)" : ""}</Label>
          <div className="mt-1 flex flex-wrap gap-2">
            {recipients.map((r) => (
              <Badge key={r} variant={added.includes(r) ? "warn" : "outline"} className="gap-1 font-mono">{r}
                <button aria-label={`remove ${r}`} onClick={() => setRecipients(recipients.filter((x) => x !== r))}><X className="size-3" /></button></Badge>
            ))}
            {!recipients.length && <span className="text-xs text-muted-foreground">empty list: the agent could pay nobody</span>}
          </div>
          <div className="mt-2 flex gap-2">
            <Input value={add} onChange={(e) => setAdd(e.target.value.trim())} placeholder="merchant.testnet" />
            <Button variant="outline" disabled={!add || !!addErr} onClick={() => { setRecipients([...recipients, add.toLowerCase()]); setAdd(""); }}><Plus /> Add</Button>
          </div>
          {addErr && <p className="mt-1 text-xs text-red-400">{addErr}</p>}
          {removed.length > 0 && <p className="mt-1 text-xs text-amber-300">You are removing: {removed.join(", ")}</p>}
        </div>
        {draft && !err && kind && (
          <div className="flex items-start gap-2 rounded-lg border border-border p-3 text-sm">
            {kind === "instant" ? <><Zap className="mt-0.5 size-4 text-emerald-400" /> Tighter: applies the moment the transaction confirms.{pendingExists ? " It also cancels the pending proposal (contract rule)." : ""}</>
              : kind === "new" ? <><Clock className="mt-0.5 size-4 text-amber-400" /> First policy for this token: pending 24h, then needs an activate call.</>
              : <><Clock className="mt-0.5 size-4 text-amber-400" /> Looser on some axis: the stricter of old and new applies now; the full change is pending 24h.</>}
          </div>
        )}
        {err && <p className="text-xs text-red-400">{err}</p>}
        {draft && !err && <p className="text-xs text-muted-foreground">Will sign: per payment {token.fmt(draft.max_per_payment)} ({draft.max_per_payment} base units), daily {token.fmt(draft.daily_limit)} ({draft.daily_limit}), {draft.recipients.length} recipient(s).</p>}
        <TxButton config={configData} allowed={["owner"]} label="Review & sign set_policy" call={call} disabled={!call} disabledWhy={err ?? undefined} />
      </CardContent>
    </Card>
  );
}
