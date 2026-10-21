"use client";
import { useState } from "react";
import { Clock, ShieldAlert, UserCog, Check, X } from "lucide-react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Mono, Progress, WiredByYou } from "@/components/ui";
import { guard, nowNs, type PendingIdentity } from "@/lib/guard";
import { useTick, useView } from "@/lib/use-guard";
import { signAndSend } from "@/lib/wallet";
import { remaining } from "@/lib/utils";

const MATRIX: [string, string, string, string][] = [
  ["Tighten caps", "instant", "-", "-"],
  ["Loosen caps / add recipient", "propose (24h)", "cancel", "-"],
  ["Change guardian", "propose (24h)", "propose (24h) · cancel any", "-"],
  ["Recover owner", "veto anytime", "propose (24h)", "-"],
  ["Emergency sweep to exit", "yes", "yes", "-"],
  ["Pay inside caps", "-", "-", "yes"],
];

export default function Guardian() {
  useTick();
  const { data: config } = useView(() => guard.get_config());
  const { data: change } = useView(() => guard.get_pending_guardian_change());
  const { data: recovery } = useView(() => guard.get_pending_owner_recovery());
  const { data: cooldown } = useView(() => guard.get_recovery_cooldown());
  const [nextGuardian, setNextGuardian] = useState("");
  const cooling = cooldown && BigInt(cooldown) > nowNs() ? remaining(cooldown) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Guardian & recovery</h1>
        <p className="text-muted-foreground">Key changes never happen instantly. Every one waits 24h and can be stopped.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardDescription>Current guardian</CardDescription><CardTitle className="font-mono text-lg">{config?.guardian_id}</CardTitle></CardHeader>
        </Card>
        <Card>
          <CardHeader><CardDescription>Current owner</CardDescription><CardTitle className="font-mono text-lg">{config?.owner_id}</CardTitle></CardHeader>
          {cooling && <CardContent className="text-xs text-muted-foreground">recovery cooldown after a veto: {cooling.label}</CardContent>}
        </Card>
      </div>

      <PendingCard
        title="Guardian change"
        icon={UserCog}
        p={change ?? null}
        empty="No guardian change pending."
        who={change?.owner_proposed ? "proposed by the owner" : "proposed by the guardian"}
        stop={{ label: "Guardian: cancel", method: "cancel_guardian_change", note: "Only the current guardian can cancel, even after the 24h. Stops a stolen owner key from swapping the guardian out." }}
        activate="activate_guardian_change"
      />

      <PendingCard
        title="Owner recovery"
        icon={ShieldAlert}
        p={recovery ?? null}
        empty="No owner recovery pending. The guardian can start one if the owner key is lost."
        who="proposed by the guardian"
        stop={{ label: "Owner: veto", method: "cancel_owner_recovery", note: "The owner can veto at any time. A veto blocks new recoveries for 24h." }}
        activate="activate_owner_recovery"
      />

      <Card>
        <CardHeader><CardTitle>Propose a new guardian</CardTitle><CardDescription>Owner or guardian can propose. It activates after 24h unless the current guardian cancels.</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="flex-1"><Label>New guardian account</Label><Input value={nextGuardian} onChange={(e) => setNextGuardian(e.target.value.trim())} placeholder="new-guardian.testnet" /></div>
          <Button disabled={!nextGuardian || [config?.owner_id, config?.agent_id, config?.guardian_id, config?.exit_id].includes(nextGuardian)} onClick={() => signAndSend({ method: "propose_guardian_change", args: { guardian_id: nextGuardian } })}>Propose (24h)</Button>
        </CardContent>
        <CardContent className="pt-0"><WiredByYou method="propose_guardian_change" /></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Who can do what</CardTitle><CardDescription>No single key can drain the guard.</CardDescription></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground"><tr><th className="py-2">Action</th><th>Owner</th><th>Guardian</th><th>Agent</th></tr></thead>
            <tbody className="divide-y divide-border">
              {MATRIX.map(([a, ...cells]) => (
                <tr key={a}><td className="py-2">{a}</td>{cells.map((c, i) => <td key={i} className={c === "-" ? "text-muted-foreground" : ""}>{c === "-" ? <X className="size-4" /> : c === "yes" || c === "instant" ? <span className="flex items-center gap-1"><Check className="size-4 text-emerald-400" />{c === "instant" ? "instant" : ""}</span> : c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function PendingCard({ title, icon: Icon, p, empty, who, stop, activate }: {
  title: string; icon: typeof Clock; p: PendingIdentity | null; empty: string; who: string;
  stop: { label: string; method: "cancel_guardian_change" | "cancel_owner_recovery"; note: string };
  activate: "activate_guardian_change" | "activate_owner_recovery";
}) {
  if (!p) return <Card><CardHeader><CardTitle className="flex items-center gap-2"><Icon className="size-5 text-muted-foreground" /> {title}</CardTitle><CardDescription>{empty}</CardDescription></CardHeader></Card>;
  const cd = remaining(p.activate_after);
  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2"><Icon className="size-5 text-amber-400" /> {title} pending <Badge variant="warn">#{p.proposal_id}</Badge></CardTitle>
        <CardDescription>New account <Mono>{p.account_id}</Mono> · {who}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-baseline justify-between">
          <span className="flex items-center gap-2 text-sm text-muted-foreground"><Clock className="size-4" /> {cd.done ? "timer done" : "activates in"}</span>
          <span className="font-mono text-2xl tabular-nums">{cd.label}</span>
        </div>
        <Progress value={cd.pct} tone="warn" />
        <p className="text-xs text-muted-foreground">{stop.note}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="destructive" onClick={() => signAndSend({ method: stop.method, args: {} })}>{stop.label}</Button>
          <Button variant="outline" disabled={!cd.done} onClick={() => signAndSend({ method: activate, args: { proposal_id: p.proposal_id } })}>Activate</Button>
        </div>
        <WiredByYou method={`${stop.method} · ${activate}`} />
      </CardContent>
    </Card>
  );
}
