"use client";
import { useState } from "react";
import { ArrowDown, Check, CircleDashed, Lock, Siren, AlertTriangle, X } from "lucide-react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Mono } from "@/components/ui";
import { TxButton } from "@/components/tx";
import { ViewBanner } from "@/components/view-state";
import { guard, TOKENS } from "@/lib/guard";
import { ftBalance } from "@/lib/near-rpc";
import { useView } from "@/lib/use-guard";
import { useToken } from "@/lib/use-token";
import type { TxState } from "@/lib/use-tx";
import type { GuardEvent } from "@/lib/tx-outcome";
import { cn, short } from "@/lib/utils";

// The real lifecycle, as emitted by contract/guard.ts (NEP-297 "payguard" events).
const STEPS = [
  { ev: "sweep_started", t: "Sweep started", d: "a sweep lock is set for this token; agent payments in it are refused while it runs" },
  { ev: "balance", t: "Balance read", d: "the guard asks the token contract for its full balance" },
  { ev: "sweep_transfer_scheduled", t: "Transfer to exit", d: "the whole balance is sent to the exit account; no other destination exists in the code" },
  { ev: "sweep_finished", t: "Finished", d: "the lock clears, with a status: transferred, zero_balance, transfer_failed or balance_query_failed" },
];

const FINISH_COPY: Record<string, { ok: boolean; text: string }> = {
  transferred: { ok: true, text: "Tokens transferred to the exit account." },
  zero_balance: { ok: true, text: "The guard held none of this token; nothing to move." },
  transfer_failed: { ok: false, text: "The token transfer failed (often: exit account not registered with the token). Funds stayed in the guard; the lock is cleared, so it can be retried." },
  balance_query_failed: { ok: false, text: "The token contract didn't return a balance. Nothing moved; the lock is cleared." },
};

export default function Sweep() {
  const config = useView(() => guard.get_config());
  const [tokenId, setTokenId] = useState(TOKENS[0]);
  const token = useToken(tokenId);
  const guardBal = useView(() => ftBalance(tokenId, guard.contractId), [tokenId]);
  const exitBal = useView(() => (config.data ? ftBalance(tokenId, config.data.exit_id) : Promise.reject(new Error("config not loaded"))), [tokenId, config.data?.exit_id]);
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<TxState | null>(null);
  const armed = typed.trim().toUpperCase() === "SWEEP";
  const exit = config.data?.exit_id;

  const events: GuardEvent[] = result?.outcome?.events ?? [];
  const finished = events.find((e) => e.event === "sweep_finished");
  const status = finished ? String(finished.data.status) : typeof result?.outcome?.returnValue === "string" ? result.outcome.returnValue : undefined;
  const reached = (ev: string) => ev === "balance" ? events.some((e) => e.event === "sweep_transfer_scheduled") || (!!status && status !== "balance_query_failed") : events.some((e) => e.event === ev);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><Siren className="size-6 text-red-400" /> Emergency sweep</h1>
        <p className="text-muted-foreground">Something feels wrong? The owner or the guardian can move the guard&apos;s full balance of one token to the cold exit account.</p>
      </div>

      <ViewBanner views={[config, guardBal]} />

      <Card className="border-red-500/40">
        <CardHeader>
          <CardTitle>Where the money goes</CardTitle>
          <CardDescription>The exit account was fixed when the guard was initialised. No method in the contract can change it, so a stolen owner or guardian key can&apos;t redirect a sweep.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center gap-2 rounded-xl border border-border p-6 text-center">
            <div className="text-xs text-muted-foreground">from guard · holds {guardBal.data !== undefined ? token.fmt(guardBal.data) : "..."}</div>
            <Mono>{guard.contractId}</Mono>
            <ArrowDown className="size-6 text-red-400" />
            <div className="text-xs text-muted-foreground">to exit · holds {exitBal.data !== undefined ? token.fmt(exitBal.data) : exitBal.error ? "unreadable" : "..."}</div>
            <div className="flex items-center gap-2"><Lock className="size-4 text-amber-400" /><span className="break-all font-mono text-lg">{exit ?? "..."}</span><Badge variant="warn">immutable</Badge></div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Sweep a token</CardTitle><CardDescription>One token per call, full balance. Signed by the owner or guardian with 200 Tgas (the contract requires 180-250).</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {TOKENS.map((t) => <Button key={t} variant={t === tokenId ? "default" : "outline"} size="sm" className="font-mono" onClick={() => { setTokenId(t); setResult(null); }}>{t === tokenId && token.meta ? token.meta.symbol : short(t, 6)}</Button>)}
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-border p-3 text-sm text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
            <span>The exit account must be registered with the token contract (storage deposit). If it isn&apos;t, the transfer fails and the funds stay in the guard. A sweep is not a guarantee of withdrawal: it depends on the token contract accepting the transfer.</span>
          </div>
          <div>
            <Label>Type SWEEP to confirm</Label>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="SWEEP" className="mt-1 max-w-xs font-mono" />
          </div>
          <TxButton config={config.data} allowed={["owner", "guardian"]} variant="destructive" size="lg"
            label={<><Siren /> Sweep all {token.meta?.symbol ?? short(tokenId, 6)} to {exit ?? "exit"}</>}
            call={armed ? { method: "emergency_sweep", args: { token_id: tokenId } } : null}
            disabled={!armed} disabledWhy="type SWEEP to arm" onDone={(s) => { setResult(s); setTyped(""); }} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Lifecycle</CardTitle><CardDescription>{result?.phase === "confirmed" || result?.outcome ? "Filled from the transaction's on-chain events." : "Steps light up from the real transaction receipts after a sweep. Nothing here is animated or simulated."}</CardDescription></CardHeader>
        <CardContent>
          <ol className="space-y-3">
            {STEPS.map((s, i) => {
              const done = result?.outcome ? reached(s.ev) : false;
              return (
                <li key={s.ev} className="flex items-start gap-3">
                  <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full border text-xs", done ? "border-emerald-500 bg-emerald-500/15 text-emerald-400" : "border-border text-muted-foreground")}>
                    {done ? <Check className="size-3" /> : result?.outcome ? <CircleDashed className="size-3" /> : i + 1}
                  </span>
                  <span><span className="font-medium">{s.t}</span> <span className="text-sm text-muted-foreground">{s.d}</span></span>
                </li>
              );
            })}
          </ol>
          {status && (
            <div className={cn("mt-4 flex items-start gap-2 rounded-lg border p-3 text-sm", FINISH_COPY[status]?.ok ? "border-emerald-500/40 text-emerald-300" : "border-red-500/40 text-red-300")}>
              {FINISH_COPY[status]?.ok ? <Check className="mt-0.5 size-4" /> : <X className="mt-0.5 size-4" />}
              <span><Mono>{status}</Mono> {FINISH_COPY[status]?.text ?? ""}{events.find((e) => e.event === "sweep_transfer_scheduled")?.data.amount ? ` Amount: ${token.fmt(String(events.find((e) => e.event === "sweep_transfer_scheduled")!.data.amount))}.` : ""}</span>
            </div>
          )}
          {result?.phase === "failed" && result.outcome && <p className="mt-4 text-sm text-red-300">The sweep call itself was refused: {result.message}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
