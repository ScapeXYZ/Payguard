"use client";
import { CheckCircle2, CircleDashed, ExternalLink, Loader2, PenLine, Send, ShieldX, XCircle } from "lucide-react";
import { Button } from "./ui";
import { cn } from "@/lib/utils";
import { txUrl } from "@/lib/near-rpc";
import { guard, IS_MOCK, rolesOf, type Config, type Role } from "@/lib/guard";
import { useWallet, type WriteCall } from "@/lib/wallet";
import { useTx, type TxPhase, type TxState } from "@/lib/use-tx";
import { runThenNotify } from "@/lib/tx-click";

const PHASES: { key: TxPhase; label: string }[] = [
  { key: "awaiting_signature", label: "Awaiting signature" },
  { key: "submitted", label: "Submitted" },
  { key: "pending", label: "Pending on chain" },
  { key: "confirmed", label: "Confirmed" },
];

export function TxStatus({ state }: { state: TxState }) {
  if (state.phase === "idle") return null;
  const ix = PHASES.findIndex((p) => p.key === state.phase);
  const tone = state.phase === "confirmed" ? "border-emerald-500/40 bg-emerald-500/5"
    : state.phase === "failed" ? "border-red-500/40 bg-red-500/5"
    : state.phase === "rejected" ? "border-border bg-muted/40" : "border-amber-500/40 bg-amber-500/5";
  const Icon = state.phase === "confirmed" ? CheckCircle2 : state.phase === "failed" ? XCircle : state.phase === "rejected" ? ShieldX
    : state.phase === "awaiting_signature" ? PenLine : state.phase === "submitted" ? Send : Loader2;
  const title = state.phase === "confirmed" ? "Confirmed on chain"
    : state.phase === "failed" ? (state.outcome ? "Failed on chain" : "Not sent")
    : state.phase === "rejected" ? "Rejected in wallet"
    : PHASES[ix]?.label ?? state.phase;
  return (
    <div role="status" aria-live="polite" className={cn("mt-3 space-y-2 rounded-lg border p-3 text-sm", tone)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium">
          <Icon className={cn("size-4", state.phase === "pending" && !state.message && "animate-spin", state.phase === "confirmed" ? "text-emerald-400" : state.phase === "failed" ? "text-red-400" : "text-amber-400")} />
          {title} <span className="font-mono text-xs text-muted-foreground">{state.method}</span>
        </span>
        {state.hash && (
          <a className="flex items-center gap-1 text-xs text-primary hover:underline" href={txUrl(state.hash)} target="_blank" rel="noreferrer">
            {state.hash.slice(0, 10)}... explorer <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      {ix >= 0 && state.phase !== "confirmed" && (
        <ol className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {PHASES.map((p, i) => (
            <li key={p.key} className={cn("flex items-center gap-1", i < ix && "text-foreground", i === ix && "text-amber-300")}>
              {i < ix ? <CheckCircle2 className="size-3" /> : <CircleDashed className="size-3" />} {p.label}
            </li>
          ))}
        </ol>
      )}
      {state.message && <p className={state.phase === "failed" ? "text-red-300" : "text-muted-foreground"}>{state.message}</p>}
      {state.phase === "confirmed" && state.outcome?.downstreamFailures.length ? (
        <p className="text-amber-300">The guard call succeeded, but a downstream receipt failed: {state.outcome.downstreamFailures[0].executor}: {state.outcome.downstreamFailures[0].message}</p>
      ) : null}
      {state.phase === "confirmed" && state.outcome?.events.length ? (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {state.outcome.events.map((e, i) => <li key={i}>event <span className="font-mono text-foreground">{e.event}</span>{e.data.status ? ` · ${String(e.data.status)}` : ""}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

const ROLE_LABEL: Record<Role | "anyone", string> = { owner: "owner", guardian: "guardian", agent: "agent", exit: "exit (cold) account", anyone: "any account" };

// A contract write. Disabled unless a wallet is connected AS a role the contract accepts
// for this method (the contract still enforces it; this just avoids a doomed signature).
export function TxButton({ call, allowed, config, label, variant = "default", size, disabled, disabledWhy, className, onDone }: {
  call: WriteCall | null; allowed: (Role | "anyone")[]; config: Config | undefined; label: React.ReactNode;
  variant?: "default" | "destructive" | "outline" | "secondary"; size?: "sm" | "default" | "lg";
  disabled?: boolean; disabledWhy?: string; className?: string; onDone?: (s: TxState) => void;
}) {
  const { accountId, connect, ready } = useWallet();
  const { state, run, busy, retry } = useTx();
  const roles = rolesOf(accountId, config);
  const roleOk = allowed.includes("anyone") ? !!accountId : roles.some((r) => allowed.includes(r));
  const why = IS_MOCK ? "mock data: signing disabled"
    : !accountId ? null
    : !roleOk ? `needs the ${allowed.map((a) => ROLE_LABEL[a]).join(" or ")}; you're signed in as ${accountId}${roles.length ? ` (${roles.join(", ")})` : " (no role on this guard)"}`
    : disabled ? disabledWhy : null;
  return (
    <div className={className}>
      {!accountId && !IS_MOCK ? (
        <Button variant="outline" size={size} disabled={!ready} onClick={connect}>Connect wallet to sign</Button>
      ) : (
        <Button variant={variant} size={size} disabled={IS_MOCK || !call || !roleOk || disabled || busy}
          onClick={() => { void runThenNotify(call, run, onDone); }}>
          {busy ? <Loader2 className="animate-spin" /> : null}{label}
        </Button>
      )}
      {why && <p className="mt-1 text-xs text-muted-foreground">{why}</p>}
      <TxStatus state={state} />
      {state.phase === "pending" && state.message && state.hash && (
        <Button variant="outline" size="sm" onClick={() => { void retry(); }}>Retry verification</Button>
      )}
    </div>
  );
}

export const GUARD_ID = guard.contractId;
