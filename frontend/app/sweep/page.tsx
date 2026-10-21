"use client";
import { useState } from "react";
import { ArrowDown, Lock, Siren, Check, AlertTriangle } from "lucide-react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Mono, WiredByYou } from "@/components/ui";
import { guard, TOKENS, TOKEN_META } from "@/lib/guard";
import { useView } from "@/lib/use-guard";
import { signAndSend } from "@/lib/wallet";
import { cn } from "@/lib/utils";

const FLOW = [
  { t: "Lock", d: "a sweep lock is set for this token, agent payments in it stop" },
  { t: "Read balance", d: "guard asks the token contract for its full balance" },
  { t: "Send all to exit", d: "the whole balance goes to the exit account, never anywhere else" },
  { t: "Unlock", d: "lock clears whether it succeeded or failed, nothing gets stuck" },
];

export default function Sweep() {
  const { data: config } = useView(() => guard.get_config());
  const [token, setToken] = useState(TOKENS[0]);
  const [typed, setTyped] = useState("");
  const [stage, setStage] = useState(-1);
  const armed = typed.trim().toUpperCase() === "SWEEP";

  async function run() {
    await signAndSend({ method: "emergency_sweep", args: { token_id: token }, gasTgas: 200 });
    for (let i = 0; i < FLOW.length; i++) { setStage(i); await new Promise((r) => setTimeout(r, 700)); }
    setStage(FLOW.length);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><Siren className="size-6 text-red-400" /> Emergency sweep</h1>
        <p className="text-muted-foreground">Something feels wrong? Move everything to your cold exit account in one step. Owner or guardian can do this at any time.</p>
      </div>

      <Card className="border-red-500/40">
        <CardHeader>
          <CardTitle>Where the money goes</CardTitle>
          <CardDescription>The destination is fixed at setup. Nobody can change it, so a stolen key can't redirect the sweep.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center gap-2 rounded-xl border border-border p-6 text-center">
            <div className="text-xs text-muted-foreground">from guard</div>
            <Mono>{guard.contractId}</Mono>
            <ArrowDown className="size-6 text-red-400" />
            <div className="text-xs text-muted-foreground">to exit</div>
            <div className="flex items-center gap-2"><Lock className="size-4 text-amber-400" /><span className="font-mono text-lg">{config?.exit_id}</span><Badge variant="warn">permanent</Badge></div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Sweep a token</CardTitle><CardDescription>Sweeps the full balance of one token per call.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {TOKENS.map((t) => (
              <Button key={t} variant={t === token ? "default" : "outline"} size="sm" onClick={() => setToken(t)}>{TOKEN_META[t]?.symbol ?? t}</Button>
            ))}
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-border p-3 text-sm text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" /> The exit account must be registered on the token contract. If it isn't, the transfer fails safely and the funds stay in the guard.
          </div>
          <div>
            <Label>Type SWEEP to confirm</Label>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="SWEEP" className="mt-1 max-w-xs font-mono" />
          </div>
          <Button variant="destructive" size="lg" disabled={!armed || (stage >= 0 && stage < FLOW.length)} onClick={run}>
            <Siren /> Sweep all {TOKEN_META[token]?.symbol ?? token} to {config?.exit_id}
          </Button>
          <WiredByYou method="emergency_sweep (200 Tgas)" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>What happens</CardTitle></CardHeader>
        <CardContent>
          <ol className="space-y-3">
            {FLOW.map((f, i) => (
              <li key={f.t} className="flex items-start gap-3">
                <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full border text-xs", stage > i ? "border-emerald-500 bg-emerald-500/15 text-emerald-400" : stage === i ? "border-red-400 text-red-400" : "border-border text-muted-foreground")}>
                  {stage > i ? <Check className="size-3" /> : i + 1}
                </span>
                <span><span className="font-medium">{f.t}</span> <span className="text-sm text-muted-foreground">{f.d}</span></span>
              </li>
            ))}
          </ol>
          {stage === FLOW.length && <p className="mt-4 text-sm text-emerald-400">Simulated sweep complete.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
