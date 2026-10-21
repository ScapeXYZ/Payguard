"use client";
import { useState } from "react";
import { Check, ChevronLeft, ChevronRight, Lock, Bot, User, ShieldHalf, LogOut } from "lucide-react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Mono, WiredByYou } from "@/components/ui";
import { guard } from "@/lib/guard";
import { useView } from "@/lib/use-guard";
import { signAndSend } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { FirstVisitGuide } from "@/components/guide";

// Mirrors initialize() in contract/policy.ts: canonical ids, every role distinct.
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
type Role = "owner_id" | "agent_id" | "guardian_id" | "exit_id";
const STEPS: { key: Role; title: string; icon: typeof User; what: string; rule: string }[] = [
  { key: "owner_id", title: "Owner", icon: User, what: "You. Sets the spending rules and can veto a recovery.", rule: "Must be the account signing this setup." },
  { key: "agent_id", title: "Agent", icon: Bot, what: "The AI agent. It can only call pay, inside your caps, to allowlisted recipients.", rule: "Separate from the owner and the guard contract." },
  { key: "guardian_id", title: "Guardian", icon: ShieldHalf, what: "A second key you keep apart (hardware wallet, a friend). Cancels risky changes and can sweep.", rule: "Separate from owner and agent." },
  { key: "exit_id", title: "Exit (cold)", icon: LogOut, what: "Where an emergency sweep sends everything. Set once, can never be changed by anyone.", rule: "Separate from every other role, exact lowercase id." },
];

export default function Setup() {
  const { data: config } = useView(() => guard.get_config());
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<Record<Role, string>>({ owner_id: "", agent_id: "", guardian_id: "", exit_id: "" });
  const [sent, setSent] = useState(false);

  const errors: Partial<Record<Role, string>> = {};
  for (const s of STEPS) {
    const v = form[s.key];
    if (!v) continue;
    if (!ACCOUNT_RE.test(v) || v.length < 2 || v.length > 64) errors[s.key] = "not a valid NEAR account id (lowercase, no spaces)";
    const clash = STEPS.find((o) => o.key !== s.key && form[o.key] === v && STEPS.indexOf(o) < STEPS.indexOf(s));
    if (clash) errors[s.key] = `same account as ${clash.title.toLowerCase()}; every role must be separate`;
  }
  const review = step === STEPS.length;
  const cur = STEPS[step];
  const canNext = !review && !!form[cur.key] && !errors[cur.key];

  return (
    <div className="space-y-6">
      <FirstVisitGuide />
      <div>
        <h1 className="text-2xl font-semibold">Set up your guard</h1>
        <p className="text-muted-foreground">Four accounts, each with one job. Nothing here can be bypassed later by the agent.</p>
      </div>

      {config && guard.mode !== "mock" && (
        <Card><CardContent className="pt-5 text-sm">Already initialised: owner <Mono>{config.owner_id}</Mono> · exit <Mono>{config.exit_id}</Mono></CardContent></Card>
      )}

      <ol className="flex flex-wrap gap-2">
        {[...STEPS.map((s) => s.title), "Review"].map((t, i) => (
          <li key={t} className={cn("flex items-center gap-2 rounded-full border px-3 py-1 text-xs", i === step ? "border-primary text-primary" : i < step ? "border-border text-foreground" : "border-border text-muted-foreground")}>
            {i < step ? <Check className="size-3" /> : <span>{i + 1}</span>} {t}
          </li>
        ))}
      </ol>

      {!review ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><cur.icon className="size-5 text-primary" /> {cur.title}</CardTitle>
            <CardDescription>{cur.what}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Label htmlFor={cur.key}>{cur.title} account</Label>
            <Input id={cur.key} placeholder={`e.g. ${config?.[cur.key] ?? "name.testnet"}`} value={form[cur.key]}
              onChange={(e) => setForm({ ...form, [cur.key]: e.target.value.trim() })} />
            <p className={cn("text-xs", errors[cur.key] ? "text-red-400" : "text-muted-foreground")}>{errors[cur.key] ?? cur.rule}</p>
            {cur.key === "exit_id" && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
                <Lock className="mt-0.5 size-4 shrink-0" /> Use a cold wallet you never connect to apps. If the guardian key is stolen, the worst it can do is send funds here.
              </div>
            )}
            <div className="flex justify-between pt-2">
              <Button variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}><ChevronLeft /> Back</Button>
              <Button disabled={!canNext} onClick={() => setStep(step + 1)}>Next <ChevronRight /></Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Review before you sign</CardTitle>
            <CardDescription>This is exactly what the contract will store.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="divide-y divide-border rounded-lg border border-border">
              {STEPS.map((s) => (
                <div key={s.key} className="flex items-center justify-between gap-4 p-3 text-sm">
                  <span className="flex items-center gap-2"><s.icon className="size-4 text-muted-foreground" /> {s.title}</span>
                  <span className="flex items-center gap-2"><Mono>{form[s.key]}</Mono>{s.key === "exit_id" && <Badge variant="warn">permanent</Badge>}</span>
                </div>
              ))}
            </div>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li>· the agent can pay only after you set a policy for a token</li>
              <li>· loosening a policy or changing the guardian waits 24h and can be cancelled</li>
              <li>· the exit account can never be changed, by you or anyone</li>
            </ul>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(step - 1)}><ChevronLeft /> Back</Button>
              <Button onClick={async () => { await signAndSend({ method: "init", args: form }); setSent(true); }}>
                {sent ? <><Check /> Simulated</> : "Sign & initialise"}
              </Button>
            </div>
            <WiredByYou method="init" />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
