"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldCheck, Settings2, Gauge, Users, Siren, Wallet } from "lucide-react";
import { Badge, Button } from "./ui";
import { StartHereHint } from "./guide";
import { guard } from "@/lib/guard";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Setup", icon: Settings2, hint: "owner · guardian · exit" },
  { href: "/payments/", label: "Payments & caps", icon: Gauge, hint: "what the agent can spend" },
  { href: "/guardian/", label: "Guardian & recovery", icon: Users, hint: "24h changes, vetoes" },
  { href: "/sweep/", label: "Emergency sweep", icon: Siren, hint: "move everything to exit" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b border-border md:w-64 md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 p-5">
          <ShieldCheck className="size-6 text-primary" />
          <div>
            <div className="font-semibold">Payguard</div>
            <div className="text-xs text-muted-foreground">agent wallet guard · NEAR</div>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col">
          {NAV.map(({ href, label, icon: Icon, hint }) => {
            const active = href === "/" ? path === "/" : path.startsWith(href.replace(/\/$/, ""));
            return (
              <Link key={href} href={href} className={cn("flex min-w-max items-start gap-3 rounded-lg px-3 py-2 text-sm", active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60")}>
                <Icon className={cn("mt-0.5 size-4", href === "/sweep/" && "text-red-400")} />
                <span>
                  <span className="block">{label}</span>
                  <span className="hidden text-xs text-muted-foreground md:block">{hint}</span>
                </span>
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="flex-1">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">contract</span>
            <span className="font-mono">{guard.contractId}</span>
            <Badge variant={guard.mode === "mock" ? "warn" : "ok"}>{guard.mode === "mock" ? "mock data" : guard.mode}</Badge>
          </div>
          <Button variant="outline" size="sm" disabled title="NEAR Wallet Selector, wired by the contract author">
            <Wallet /> Connect wallet
          </Button>
        </header>
        <StartHereHint onSetup={path === "/"} />
        <main className="mx-auto max-w-5xl p-6">{children}</main>
      </div>
    </div>
  );
}
