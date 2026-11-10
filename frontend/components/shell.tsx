"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldCheck, LayoutDashboard, Gauge, Users, Siren, FlaskConical, Wallet, LogOut, ExternalLink } from "lucide-react";
import { Badge, Button } from "./ui";
import { StartHereHint } from "./guide";
import { guard, IS_MOCK, rolesOf } from "@/lib/guard";
import { accountUrl } from "@/lib/near-rpc";
import { useView } from "@/lib/use-guard";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard, hint: "what's protected, at a glance" },
  { href: "/payments/", label: "Payments & caps", icon: Gauge, hint: "what the agent can spend" },
  { href: "/guardian/", label: "Guardian & recovery", icon: Users, hint: "24h changes, vetoes" },
  { href: "/sweep/", label: "Emergency sweep", icon: Siren, hint: "move a token to exit" },
  { href: "/attack-lab/", label: "Attack Lab", icon: FlaskConical, hint: "see attacks get blocked" },
];

function WalletControl() {
  const { accountId, connect, disconnect, ready, error } = useWallet();
  const { data: config } = useView(() => guard.get_config());
  const roles = rolesOf(accountId, config);
  if (IS_MOCK) return <Badge variant="warn">mock mode · signing off</Badge>;
  if (!accountId) return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" disabled={!ready} onClick={connect}><Wallet /> {ready ? "Connect wallet" : "Loading wallets..."}</Button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <a href={accountUrl(accountId)} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-mono hover:underline">{accountId}<ExternalLink className="size-3" /></a>
      {roles.length ? roles.map((r) => <Badge key={r} variant={r === "owner" ? "default" : r === "guardian" ? "ok" : "warn"}>{r}</Badge>)
        : <Badge variant="outline" title="This account has no role on this guard; it can read, and can only activate matured proposals.">no role</Badge>}
      {roles.includes("agent") && <span className="text-xs text-amber-300">agent key in a browser wallet: payments are runner-only here</span>}
      <Button variant="ghost" size="sm" onClick={() => disconnect()}><LogOut /> Disconnect</Button>
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b border-border md:w-64 md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 p-5">
          <ShieldCheck className="size-6 text-primary" />
          <div>
            <div className="font-semibold">PayGuard</div>
            <div className="text-xs text-muted-foreground">on-chain spending rules for AI agents · NEAR</div>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col">
          {NAV.map(({ href, label, icon: Icon, hint }) => {
            const active = href === "/" ? path === "/" : path.startsWith(href.replace(/\/$/, ""));
            return (
              <Link key={href} href={href} className={cn("flex min-w-max items-start gap-3 rounded-lg px-3 py-2 text-sm", active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60")}>
                <Icon className={cn("mt-0.5 size-4", href === "/sweep/" && "text-red-400", href === "/attack-lab/" && "text-primary")} />
                <span>
                  <span className="block">{label}</span>
                  <span className="hidden text-xs text-muted-foreground md:block">{hint}</span>
                </span>
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">guard</span>
            <a href={accountUrl(guard.contractId)} target="_blank" rel="noreferrer" className="truncate font-mono hover:underline">{guard.contractId}</a>
            <Badge variant={IS_MOCK ? "warn" : "ok"}>{IS_MOCK ? "mock data" : guard.mode}</Badge>
          </div>
          <WalletControl />
        </header>
        <StartHereHint onSetup={path === "/"} />
        <main className="mx-auto max-w-5xl p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
