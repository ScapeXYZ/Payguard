"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Compass, X } from "lucide-react";
import { Button } from "./ui";

const KEY = "payguard.guide.dismissed.v1";

export const GUIDE_STEPS = [
  { n: 1, href: "/", title: "Set up roles", what: "pick the owner (you), the agent, a guardian key and a cold exit account" },
  { n: 2, href: "/payments/", title: "Set caps", what: "max per payment, daily limit, and who the agent is allowed to pay" },
  { n: 3, href: "/guardian/", title: "Guardian", what: "every key change waits 24h, so you or the guardian can stop it" },
  { n: 4, href: "/sweep/", title: "Sweep if something's wrong", what: "one step moves everything to the exit account" },
];

// Shown until dismissed; rendered by default so it is in the static HTML, hidden after mount if dismissed.
export function useGuide() {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try { if (localStorage.getItem(KEY) === "1") setOpen(false); } catch {}
    const on = () => { try { setOpen(localStorage.getItem(KEY) !== "1"); } catch {} };
    window.addEventListener("payguard-guide", on);
    return () => window.removeEventListener("payguard-guide", on);
  }, []);
  const set = (v: boolean) => {
    try { v ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, "1"); } catch {}
    setOpen(v);
    window.dispatchEvent(new Event("payguard-guide"));
  };
  return { open, dismiss: () => set(false), reopen: () => set(true) };
}

// Full first-visit guide: sits on top of the Setup page.
export function FirstVisitGuide() {
  const { open, dismiss } = useGuide();
  if (!open) return null;
  return (
    <div className="relative rounded-xl border border-primary/40 bg-primary/5 p-5">
      <button aria-label="Dismiss guide" onClick={dismiss} className="absolute right-3 top-3 rounded p-1 text-muted-foreground hover:bg-muted"><X className="size-4" /></button>
      <div className="flex items-center gap-2 text-sm font-medium text-primary"><Compass className="size-4" /> New here? Start here</div>
      <p className="mt-1 pr-6 text-sm">Payguard gives your AI agent a wallet it can't drain: it can only pay inside the limits you set, and you can always pull the money out.</p>
      <ol className="mt-4 grid gap-3 md:grid-cols-4">
        {GUIDE_STEPS.map((s) => (
          <li key={s.n}>
            <Link href={s.href} className="flex h-full gap-3 rounded-lg border border-border bg-background/60 p-3 hover:border-primary/60">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">{s.n}</span>
              <span><span className="block text-sm font-medium">{s.title}</span><span className="block text-xs text-muted-foreground">{s.what}</span></span>
            </Link>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">You're on step 1. The sidebar follows the same order.</span>
        <Button size="sm" variant="outline" onClick={dismiss}>Got it</Button>
      </div>
    </div>
  );
}

// Compact "start here" hint for the shell (every page except Setup, which has the full guide).
export function StartHereHint({ onSetup }: { onSetup: boolean }) {
  const { open, dismiss, reopen } = useGuide();
  if (!open) return <button onClick={reopen} className="mx-6 mt-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground "><Compass className="size-3" /> Show the guide</button>;
  if (onSetup) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-primary/30 bg-primary/5 px-6 py-2 text-sm">
      <span className="flex items-center gap-2"><Compass className="size-4 text-primary" /> New here? Start here: <Link href="/" className="font-medium text-primary underline-offset-2 hover:underline">1 set up roles</Link> → 2 set caps → 3 guardian → 4 sweep if something's wrong</span>
      <button aria-label="Dismiss guide" onClick={dismiss} className="rounded p-1 text-muted-foreground hover:bg-muted"><X className="size-4" /></button>
    </div>
  );
}
