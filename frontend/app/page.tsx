"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Ban, Bot, Check, ChevronLeft, ChevronRight, Clock, FlaskConical, Lock, LogOut, ShieldCheck, ShieldHalf, User, Vault, Wrench } from "lucide-react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Mono } from "@/components/ui";
import { TxButton } from "@/components/tx";
import { ViewBanner } from "@/components/view-state";
import { FirstVisitGuide } from "@/components/guide";
import { guard, IS_MOCK, TOKENS, isMissingContract, isUninitialised, type Config } from "@/lib/guard";
import { ftBalance } from "@/lib/near-rpc";
import { useTick, useView } from "@/lib/use-guard";
import { useToken } from "@/lib/use-token";
import { useWallet } from "@/lib/wallet";
import { EMPTY_EVIDENCE_TEXT, EVIDENCE_URL, loadEvidence } from "@/lib/evidence";
import { useVerified } from "@/components/payment-history";
import { CONTRACT_ERRORS } from "@/lib/errors";
import { cn, remaining, short } from "@/lib/utils";

export default function Home() {
  const config = useView(() => guard.get_config());
  if (config.data) return <Overview config={config.data} />;
  if (isUninitialised(config.error)) return <Setup />;
  if (isMissingContract(config.error)) return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">No guard contract at <Mono>{guard.contractId}</Mono></h1>
      <p className="text-muted-foreground">There&apos;s no deployed contract on this account. Deploying a new guard is a contract-author step (deployment tooling in <Mono>scripts/</Mono>); this UI only initialises and operates an already-deployed one.</p>
    </div>
  );
  return <div className="space-y-4"><h1 className="text-2xl font-semibold">PayGuard</h1><ViewBanner views={[config]} /></div>;
}

// ---------------- dashboard for an initialised guard ----------------
function Overview({ config }: { config: Config }) {
  useTick();
  const pending = useView(() => guard.get_pending_policy());
  const change = useView(() => guard.get_pending_guardian_change());
  const recovery = useView(() => guard.get_pending_owner_recovery());
  const ev = useView(() => loadEvidence(guard.contractId), []);
  const [showNew, setShowNew] = useState(false);
  const reported = useMemo(() => ev.data?.records.filter((r) => r.status === "rejected"), [ev.data]);
  const verified = useVerified(ev.data, reported);
  // Definitive counts only from chain-verified rejections, keyed by the code read from the guard receipt.
  const confirmed = (reported ?? []).map((r) => verified(r)).filter((v) => v?.state === "verified" && v.onchain === "rejected");
  const byReason = confirmed.reduce<Record<string, number>>((a, v) => { const k = (v?.state === "verified" && v.chainCode) || "no code"; a[k] = (a[k] ?? 0) + 1; return a; }, {});
  const unconfirmed = (reported?.length ?? 0) - confirmed.length;
  const attention = [
    pending.data && { t: `Policy change #${pending.data.proposal_id} pending`, d: remaining(pending.data.activate_after), href: "/payments/" },
    change.data && { t: `${change.data.cold_key_proposed ? "Cold-key guardian" : "Guardian"} change #${change.data.proposal_id} pending`, d: remaining(change.data.activate_after), href: "/guardian/" },
    recovery.data && { t: `Owner recovery #${recovery.data.proposal_id} pending`, d: remaining(recovery.data.activate_after), href: "/guardian/" },
  ].filter(Boolean) as { t: string; d: ReturnType<typeof remaining>; href: string }[];

  return (
    <div className="space-y-6">
      <FirstVisitGuide />
      <div>
        <h1 className="text-2xl font-semibold">Your agent&apos;s wallet, under on-chain rules</h1>
        <p className="text-muted-foreground">The agent can request payments. It can&apos;t get around the limits below: the contract checks every one.</p>
      </div>
      <ViewBanner views={[pending, change, recovery]} />

      {attention.length > 0 && (
        <Card className="border-amber-500/40"><CardContent className="space-y-2 pt-5">
          {attention.map((a) => (
            <Link key={a.t} href={a.href} className="flex flex-wrap items-center justify-between gap-2 text-sm hover:underline">
              <span className="flex items-center gap-2"><Clock className="size-4 text-amber-400" /> {a.t}</span>
              <span className="font-mono text-xs text-amber-300">{a.d.done ? "timelock finished" : a.d.label}</span>
            </Link>
          ))}
        </CardContent></Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Vault className="size-5 text-primary" /> What is protected</CardTitle><CardDescription>Tokens held by the guard contract itself.</CardDescription></CardHeader>
          <CardContent className="space-y-2">{TOKENS.map((t) => <HeldRow key={t} tokenId={t} />)}
            <p className="text-xs text-muted-foreground">Emergency exit: <Mono>{config.exit_id}</Mono> <Badge variant="warn"><Lock className="mr-1 size-3" />immutable</Badge></p></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Bot className="size-5 text-primary" /> What the agent can spend</CardTitle><CardDescription>Agent <Mono>{config.agent_id}</Mono>, active policy only.</CardDescription></CardHeader>
          <CardContent className="space-y-3">{TOKENS.map((t) => <SpendRow key={t} tokenId={t} />)}</CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Ban className="size-5 text-red-400" /> What has been blocked</CardTitle><CardDescription>Contract rejections from the payment runner&apos;s evidence.</CardDescription></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {ev.stale && ev.data && <p className="text-xs text-amber-300">Stale snapshot: the latest evidence refresh failed{ev.error ? ` (${ev.error})` : ""}.</p>}
            {!EVIDENCE_URL || IS_MOCK ? <p className="text-muted-foreground">No evidence feed connected yet, so nothing is claimed here. Rejections will appear once the runner publishes verified records.</p>
              : ev.error && !ev.data ? <p className="text-red-300">Evidence feed unavailable: {ev.error}</p>
              : !ev.data ? <p className="text-muted-foreground">Loading evidence...</p>
              : ev.data.records.length === 0 ? <p className="text-muted-foreground">{EMPTY_EVIDENCE_TEXT}. An empty export doesn&apos;t prove there were no on-chain payments.</p>
              : !reported?.length ? <p className="text-muted-foreground">No rejected payments in the persisted evidence.</p>
              : <>
                  {Object.entries(byReason).map(([k, n]) => <div key={k} className="flex justify-between"><span>{k === "no code" ? "Guard execution failed (no contract code in the receipt)" : CONTRACT_ERRORS[k]?.replace(/^Blocked: /, "") ?? k}</span><Badge variant="danger">{n} verified</Badge></div>)}
                  {unconfirmed > 0 && <p className="text-xs text-muted-foreground">Runner reports {unconfirmed} more rejection{unconfirmed === 1 ? "" : "s"} not verified on chain; not counted.</p>}
                </>}
            <Button asChild size="sm" variant="outline"><Link href="/attack-lab/"><FlaskConical /> Attack Lab</Link></Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5 text-primary" /> What the owner and guardian can do</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div><Badge>owner</Badge> <Mono>{short(config.owner_id, 14)}</Mono>: tighten or disable a policy instantly, propose looser rules (24h), veto owner recovery and cold-key guardian changes, sweep.</div>
            <div><Badge variant="ok">guardian</Badge> <Mono>{short(config.guardian_id, 14)}</Mono>: veto pending policy changes and normal guardian changes, start owner recovery, sweep. It can&apos;t pause an active policy.</div>
            <div><Badge variant="warn">exit</Badge> <Mono>{short(config.exit_id, 14)}</Mono>: receives sweeps; can propose a cold-key guardian replacement.</div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button asChild size="sm"><Link href="/payments/">Payments &amp; caps <ChevronRight /></Link></Button>
              <Button asChild size="sm" variant="outline"><Link href="/guardian/">Guardian &amp; recovery</Link></Button>
              <Button asChild size="sm" variant="outline"><Link href="/sweep/">Emergency sweep</Link></Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="text-sm">
        <button className="text-muted-foreground underline-offset-4 hover:underline" onClick={() => setShowNew(!showNew)}>Want a new guard instead?</button>
        {showNew && (
          <Card className="mt-2"><CardContent className="flex items-start gap-3 pt-5 text-muted-foreground">
            <Wrench className="mt-0.5 size-4 shrink-0" />
            <span><Mono>{guard.contractId}</Mono> is already initialised, and <Mono>init</Mono> can only ever run once, so there is nothing to initialise here. A new guard is a new contract account: deploy it with the contract author&apos;s tooling, then point this UI at it with <Mono>NEXT_PUBLIC_GUARD_CONTRACT</Mono>. The setup flow appears automatically for an uninitialised guard.</span>
          </CardContent></Card>
        )}
      </div>
    </div>
  );
}

function HeldRow({ tokenId }: { tokenId: string }) {
  const token = useToken(tokenId);
  const bal = useView(() => ftBalance(tokenId, guard.contractId), [tokenId]);
  return <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="font-mono text-xs text-muted-foreground">{token.meta?.name ?? short(tokenId, 6)}</span><span className="text-xl font-semibold">{bal.data !== undefined ? token.fmt(bal.data) : bal.error ? <span className="text-sm text-red-300">unreadable</span> : "..."}</span></div>;
}

function SpendRow({ tokenId }: { tokenId: string }) {
  const token = useToken(tokenId);
  const policy = useView(() => guard.get_policy(tokenId), [tokenId]);
  const spending = useView(() => guard.get_spending(tokenId), [tokenId]);
  const p = policy.data;
  if (p === undefined) return <p className="text-sm text-muted-foreground">{policy.error ? `unreadable: ${policy.error}` : "..."}</p>;
  if (p === null) return <p className="text-sm"><Badge variant="outline">{token.meta?.symbol ?? short(tokenId, 6)}</Badge> <b>Nothing.</b> <span className="text-muted-foreground">No active policy, so every payment is refused.</span></p>;
  const spent = spending.data ? BigInt(spending.data.spent) : null;
  const left = spent !== null ? (BigInt(p.daily_limit) > spent ? BigInt(p.daily_limit) - spent : 0n) : null;
  return (
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap justify-between gap-2"><span>Up to <b>{token.fmt(p.max_per_payment)}</b> per payment</span><span>{left !== null ? <><b>{token.fmt(left.toString())}</b> left today</> : "..."}</span></div>
      <div className="text-xs text-muted-foreground">only to: {p.recipients.length ? p.recipients.map((r) => <Mono key={r}>{r}</Mono>) : "nobody"}</div>
    </div>
  );
}

// ---------------- setup: ONLY for a deployed, uninitialised guard ----------------
const ACCOUNT_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
type RoleKey = "owner_id" | "agent_id" | "guardian_id" | "exit_id";
const STEPS: { key: RoleKey; title: string; icon: typeof User; what: string; rule: string }[] = [
  { key: "owner_id", title: "Owner", icon: User, what: "You. Sets the spending rules and can veto a recovery.", rule: "Must be the account that signs this setup." },
  { key: "agent_id", title: "Agent", icon: Bot, what: "The AI agent. It can only call pay, inside your caps, to allowlisted recipients.", rule: "Separate from the owner and the guard contract." },
  { key: "guardian_id", title: "Guardian", icon: ShieldHalf, what: "A second key you keep apart. Vetoes risky pending changes and can start a sweep.", rule: "Separate from owner, agent and guard." },
  { key: "exit_id", title: "Exit (cold)", icon: LogOut, what: "Where an emergency sweep sends funds. Fixed forever at setup.", rule: "Separate from every other role, exact lowercase id." },
];

function Setup() {
  const { accountId } = useWallet();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<Record<RoleKey, string>>({ owner_id: "", agent_id: "", guardian_id: "", exit_id: "" });
  const errors: Partial<Record<RoleKey, string>> = {};
  for (const s of STEPS) {
    const v = form[s.key];
    if (!v) continue;
    if (!ACCOUNT_RE.test(v) || v.length < 2 || v.length > 64) errors[s.key] = CONTRACT_ERRORS.bad_account_id;
    if (v === guard.contractId) errors[s.key] = "can't be the guard contract itself";
    const clash = STEPS.find((o) => o.key !== s.key && form[o.key] === v && STEPS.indexOf(o) < STEPS.indexOf(s));
    if (clash) errors[s.key] = `same account as ${clash.title.toLowerCase()}; every role must be separate`;
  }
  const review = step === STEPS.length;
  const cur = STEPS[step];
  const canNext = !review && !!form[cur.key] && !errors[cur.key];
  const signerMismatch = review && accountId && accountId !== form.owner_id;

  return (
    <div className="space-y-6">
      <FirstVisitGuide />
      <div>
        <h1 className="text-2xl font-semibold">Initialise this guard</h1>
        <p className="text-muted-foreground"><Mono>{guard.contractId}</Mono> is deployed but not initialised yet (read from chain). Four accounts, each with one job. This can be done exactly once.</p>
      </div>
      <ol className="flex flex-wrap gap-2">
        {[...STEPS.map((s) => s.title), "Review"].map((t, i) => (
          <li key={t} className={cn("flex items-center gap-2 rounded-full border px-3 py-1 text-xs", i === step ? "border-primary text-primary" : i < step ? "border-border text-foreground" : "border-border text-muted-foreground")}>
            {i < step ? <Check className="size-3" /> : <span>{i + 1}</span>} {t}
          </li>
        ))}
      </ol>
      {!review ? (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><cur.icon className="size-5 text-primary" /> {cur.title}</CardTitle><CardDescription>{cur.what}</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <Label htmlFor={cur.key}>{cur.title} account</Label>
            <Input id={cur.key} placeholder={cur.key === "owner_id" && accountId ? accountId : "name.testnet"} value={form[cur.key]} onChange={(e) => setForm({ ...form, [cur.key]: e.target.value.trim() })} />
            <p className={cn("text-xs", errors[cur.key] ? "text-red-400" : "text-muted-foreground")}>{errors[cur.key] ?? cur.rule}</p>
            {cur.key === "exit_id" && <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200"><Lock className="mt-0.5 size-4 shrink-0" /> Use a cold wallet you never connect to apps. A stolen guardian key can only send funds here.</div>}
            <div className="flex justify-between pt-2">
              <Button variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}><ChevronLeft /> Back</Button>
              <Button disabled={!canNext} onClick={() => setStep(step + 1)}>Next <ChevronRight /></Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader><CardTitle>Review before you sign</CardTitle><CardDescription>Exactly what the contract will store.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <div className="divide-y divide-border rounded-lg border border-border">
              {STEPS.map((s) => <div key={s.key} className="flex items-center justify-between gap-4 p-3 text-sm"><span className="flex items-center gap-2"><s.icon className="size-4 text-muted-foreground" /> {s.title}</span><span className="flex items-center gap-2"><Mono>{form[s.key]}</Mono>{s.key === "exit_id" && <Badge variant="warn">immutable</Badge>}</span></div>)}
            </div>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li>· the agent can pay only after a policy for a token is active</li>
              <li>· loosening a policy or changing a key waits 24h and can be vetoed</li>
              <li>· the exit account can never be changed, by anyone</li>
            </ul>
            {signerMismatch && <p className="text-xs text-red-400">The contract requires the owner to sign init: connect as {form.owner_id} (you&apos;re {accountId}).</p>}
            <div className="flex flex-wrap items-start justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep(step - 1)}><ChevronLeft /> Back</Button>
              <TxButton config={undefined} allowed={["anyone"]} label="Sign & initialise" call={{ method: "init", args: form }} disabled={!!signerMismatch} disabledWhy="signer must be the owner (owner_only)" />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
