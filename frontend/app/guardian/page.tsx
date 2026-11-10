"use client";
import { useState } from "react";
import { Clock, Info, KeyRound, Lock, ShieldAlert, UserCog } from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Mono, Progress } from "@/components/ui";
import { TxButton } from "@/components/tx";
import { ViewBanner } from "@/components/view-state";
import { guard, nowNs, type Config, type PendingIdentity, type Role } from "@/lib/guard";
import { useTick, useView } from "@/lib/use-guard";
import type { WriteCall } from "@/lib/wallet";
import { remaining } from "@/lib/utils";

const ACCOUNT_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

// Who can do what, read from contract/policy.ts at main d147ac9 (not from the audit text).
const MATRIX: { action: string; owner: string; guardian: string; exit: string; agent: string; anyone: string }[] = [
  { action: "Tighten caps / remove recipients", owner: "instant", guardian: "", exit: "", agent: "", anyone: "" },
  { action: "Loosen caps / add recipients", owner: "propose (24h)", guardian: "", exit: "", agent: "", anyone: "" },
  { action: "Cancel a pending policy change", owner: "yes", guardian: "veto", exit: "", agent: "", anyone: "" },
  { action: "Activate a matured policy change", owner: "", guardian: "", exit: "", agent: "", anyone: "yes" },
  { action: "Disable a token's policy", owner: "instant", guardian: "", exit: "", agent: "", anyone: "" },
  { action: "Pause an ACTIVE policy", owner: "disable it", guardian: "no", exit: "", agent: "", anyone: "" },
  { action: "Propose new guardian (normal)", owner: "propose (24h)", guardian: "propose (24h)", exit: "", agent: "", anyone: "" },
  { action: "Veto a normal guardian change", owner: "no", guardian: "veto", exit: "", agent: "", anyone: "" },
  { action: "Propose new guardian (cold key)", owner: "", guardian: "", exit: "propose (24h)", agent: "", anyone: "" },
  { action: "Veto a cold-key guardian change", owner: "veto", guardian: "no", exit: "", agent: "", anyone: "" },
  { action: "Propose owner recovery", owner: "", guardian: "propose (24h)", exit: "", agent: "", anyone: "" },
  { action: "Veto owner recovery (starts 24h cooldown)", owner: "veto, any time", guardian: "", exit: "", agent: "", anyone: "" },
  { action: "Activate a matured identity change", owner: "", guardian: "", exit: "", agent: "", anyone: "yes" },
  { action: "Emergency sweep (to fixed exit only)", owner: "yes", guardian: "yes", exit: "", agent: "", anyone: "" },
  { action: "Pay inside caps", owner: "", guardian: "", exit: "", agent: "runner only", anyone: "" },
];

function replacementError(v: string, c?: Config) {
  if (!v) return null;
  if (v.length < 2 || v.length > 64 || !ACCOUNT_RE.test(v)) return "not a valid NEAR account id";
  if (c && [c.owner_id, c.agent_id, c.guardian_id, c.exit_id, guard.contractId].includes(v)) return "must differ from every current role and the guard (separate_replacement_required)";
  return null;
}

export default function Guardian() {
  useTick();
  const config = useView(() => guard.get_config());
  const change = useView(() => guard.get_pending_guardian_change());
  const recovery = useView(() => guard.get_pending_owner_recovery());
  const cooldown = useView(() => guard.get_recovery_cooldown());
  const c = config.data;
  const cooling = cooldown.data && BigInt(cooldown.data) > nowNs() ? remaining(cooldown.data) : null;
  const coldPending = !!change.data?.cold_key_proposed;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Guardian & recovery</h1>
        <p className="text-muted-foreground">Key changes are never instant. Each one waits 24h, and a specific account can veto it.</p>
      </div>

      <ViewBanner views={[config, change, recovery, cooldown]} />

      <Card className="border-primary/30">
        <CardContent className="flex items-start gap-3 pt-5 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          <div>
            <b>What the guardian can and can&apos;t do.</b> The guardian can veto a <i>pending</i> policy change, veto a normal guardian change, start an owner recovery, and start an emergency sweep to the fixed exit account. It <b>cannot pause or edit an active policy</b>: only the owner can tighten or disable one.
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {(["owner_id", "guardian_id", "agent_id", "exit_id"] as const).map((k) => (
          <Card key={k}><CardHeader>
            <CardDescription className="flex items-center gap-2">{k.replace("_id", "")}{k === "exit_id" && <Badge variant="warn"><Lock className="mr-1 size-3" />immutable</Badge>}</CardDescription>
            <CardTitle className="break-all font-mono text-sm">{c?.[k] ?? "..."}</CardTitle>
          </CardHeader></Card>
        ))}
      </div>

      <PendingCard title="Guardian change" icon={UserCog} p={change.data} config={c} loaded={change.data !== undefined}
        empty="No guardian change pending."
        kind={!change.data ? "" : change.data.cold_key_proposed ? "cold-key change, proposed by the exit account" : change.data.owner_proposed ? "normal change, proposed by the owner" : "normal change, proposed by the guardian"}
        vetoRole={coldPending ? "owner" : "guardian"}
        vetoNote={coldPending ? "Cold-key proposals can be vetoed only by the owner. The current guardian can't block its own replacement." : "Normal guardian changes can be vetoed only by the current guardian, even after 24h and even when the owner proposed them. This stops a stolen owner key from swapping the guardian out."}
        veto={{ method: "cancel_guardian_change", args: {} }}
        activate={change.data ? { method: "activate_guardian_change", args: { proposal_id: change.data.proposal_id } } : null}
        effect="Activating also drops any pending owner recovery." />

      <PendingCard title="Owner recovery" icon={ShieldAlert} p={recovery.data} config={c} loaded={recovery.data !== undefined}
        empty="No owner recovery pending."
        kind="proposed by the guardian" vetoRole="owner"
        vetoNote="The owner can veto any time, even after the 24h, as long as it hasn't been activated. A veto blocks new recovery proposals for 24h."
        veto={{ method: "cancel_owner_recovery", args: {} }}
        activate={recovery.data ? { method: "activate_owner_recovery", args: { proposal_id: recovery.data.proposal_id } } : null}
        activateBlocked={coldPending ? "a cold-key guardian change is pending (cold_key_guardian_change_pending)" : undefined}
        effect="While pending, policy loosening and activation are paused. Activating replaces the owner and drops any pending guardian change." />

      {cooling && <p className="flex items-center gap-2 text-sm text-amber-300"><Clock className="size-4" /> Recovery cooldown after an owner veto: {cooling.label} (until {cooling.at}).</p>}

      <div className="grid gap-4 lg:grid-cols-3">
        <Propose title="Propose a new guardian" desc="Owner or guardian. Activates after 24h unless the current guardian vetoes." role={["owner", "guardian"]} config={c}
          make={(v) => ({ method: "propose_guardian_change", args: { guardian_id: v } })}
          blocked={coldPending ? "a cold-key change is pending" : undefined} />
        <Propose title="Cold-key guardian replacement" desc="Exit (cold) account only. For when the guardian key itself is lost or stolen. Supersedes any pending guardian change; only the owner can veto." role={["exit"]} config={c}
          make={(v) => ({ method: "propose_cold_key_guardian_change", args: { guardian_id: v } })} />
        <Propose title="Recover the owner" desc="Guardian only. For a lost owner key. 24h delay; the current owner can veto." role={["guardian"]} config={c}
          make={(v) => ({ method: "propose_owner_recovery", args: { owner_id: v } })}
          blocked={coldPending ? "a cold-key change is pending" : cooling ? `cooldown after a veto: ${cooling.label}` : undefined} />
      </div>

      <Card>
        <CardHeader><CardTitle>Who can do what</CardTitle><CardDescription>Read from the contract source. The contract enforces every cell; the buttons above only save you a failed signature.</CardDescription></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-2">Action</th><th>Owner</th><th>Guardian</th><th>Exit</th><th>Agent</th><th>Anyone</th></tr></thead>
            <tbody className="divide-y divide-border">
              {MATRIX.map((m) => (
                <tr key={m.action}><td className="py-2 pr-2">{m.action}</td>
                  {[m.owner, m.guardian, m.exit, m.agent, m.anyone].map((x, i) => <td key={i} className={!x || x === "no" ? "text-muted-foreground" : x.includes("veto") ? "text-amber-300" : "text-emerald-400"}>{x || "-"}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function PendingCard({ title, icon: Icon, p, loaded, empty, kind, vetoRole, vetoNote, veto, activate, activateBlocked, effect, config }: {
  title: string; icon: typeof Clock; p: PendingIdentity | null | undefined; loaded: boolean; empty: string; kind: string;
  vetoRole: Role; vetoNote: string; veto: WriteCall; activate: WriteCall | null; activateBlocked?: string; effect: string; config?: Config;
}) {
  if (!loaded) return <Card><CardHeader><CardTitle className="flex items-center gap-2"><Icon className="size-5 text-muted-foreground" /> {title}</CardTitle><CardDescription>...</CardDescription></CardHeader></Card>;
  if (!p) return <Card><CardHeader><CardTitle className="flex items-center gap-2"><Icon className="size-5 text-muted-foreground" /> {title}</CardTitle><CardDescription>{empty}</CardDescription></CardHeader></Card>;
  const cd = remaining(p.activate_after);
  const vetoAccount = vetoRole === "owner" ? config?.owner_id : config?.guardian_id;
  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2"><Icon className="size-5 text-amber-400" /> {title} pending <Badge variant="warn">#{p.proposal_id}</Badge>{p.cold_key_proposed && <Badge variant="danger"><KeyRound className="mr-1 size-3" />cold key</Badge>}</CardTitle>
        <CardDescription>New account <Mono>{p.account_id}</Mono> · {kind}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="flex items-center gap-2 text-sm text-muted-foreground"><Clock className="size-4" /> {cd.done ? "timelock finished" : "activates in"}</span>
          <span className="font-mono text-2xl tabular-nums">{cd.done ? "ready" : cd.label}</span>
        </div>
        <Progress value={cd.pct} tone="warn" />
        <p className="text-xs text-muted-foreground">Earliest activation {cd.at} (block time). {effect}</p>
        <div className="rounded-lg border border-border p-3 text-sm">
          <div>Veto account: <Mono>{vetoAccount ?? "..."}</Mono> <Badge variant="outline">{vetoRole}</Badge></div>
          <p className="mt-1 text-xs text-muted-foreground">{vetoNote}</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <TxButton config={config} allowed={[vetoRole]} variant="destructive" label={`Veto (${vetoRole})`} call={veto} />
          <TxButton config={config} allowed={["anyone"]} variant="outline" label={cd.done ? "Activate" : "Activate (after timelock)"} call={activate}
            disabled={!cd.done || !!activateBlocked} disabledWhy={!cd.done ? "timelock still running" : activateBlocked} />
        </div>
      </CardContent>
    </Card>
  );
}

function Propose({ title, desc, role, config, make, blocked }: { title: string; desc: string; role: Role[]; config?: Config; make: (v: string) => WriteCall; blocked?: string }) {
  const [v, setV] = useState("");
  const err = replacementError(v, config);
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle><CardDescription>{desc}</CardDescription></CardHeader>
      <CardContent className="space-y-2">
        <Label>New account</Label>
        <Input value={v} onChange={(e) => setV(e.target.value.trim().toLowerCase())} placeholder="new-account.testnet" />
        {err && <p className="text-xs text-red-400">{err}</p>}
        <TxButton config={config} allowed={role} label="Propose (24h)" call={v && !err ? make(v) : null} disabled={!v || !!err || !!blocked} disabledWhy={blocked ?? (err || "enter an account")} />
      </CardContent>
    </Card>
  );
}
