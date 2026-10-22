"use client";
import { AlertTriangle, Loader2, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "./ui";
import { RPC_URL } from "@/lib/near-rpc";
import type { ViewState } from "@/lib/use-guard";

const ago = (ms?: number) => (ms ? `${Math.max(0, Math.round((Date.now() - ms) / 1000))}s ago` : "never");

// One banner for a group of views: loading, RPC failure (nothing loaded), or stale.
export function ViewBanner({ views, what = "guard state" }: { views: ViewState<unknown>[]; what?: string }) {
  const loading = views.some((v) => v.loading && !v.data && !v.error);
  const failed = views.filter((v) => v.error && v.data === undefined);
  const stale = views.filter((v) => v.stale);
  const oldest = Math.min(...views.map((v) => v.updatedAt ?? Infinity));
  const retry = () => views.forEach((v) => v.refresh());
  if (failed.length) return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-sm">
      <span className="flex items-center gap-2"><WifiOff className="size-4 text-red-400" /> Couldn&apos;t read {what} from {RPC_URL}: {failed[0].error}. Nothing below is guessed; it stays empty until a read succeeds.</span>
      <Button size="sm" variant="outline" onClick={retry}><RefreshCw /> Retry</Button>
    </div>
  );
  if (stale.length) return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <span className="flex items-center gap-2"><AlertTriangle className="size-4 text-amber-400" /> Showing {what} last read {ago(Number.isFinite(oldest) ? oldest : undefined)}; the latest refresh failed{stale[0].error ? ` (${stale[0].error})` : ""}. It may be out of date.</span>
      <Button size="sm" variant="outline" onClick={retry}><RefreshCw /> Retry</Button>
    </div>
  );
  if (loading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading {what} from chain...</div>;
  return null;
}
