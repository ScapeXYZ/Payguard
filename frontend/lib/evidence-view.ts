// Display + cache helpers for evidence rows (review F4, F5). Pure, no React.
import { formatUnits } from "./amount";

export const MAX_DECIMALS = 38;
// Canonical positive u128 base-unit string (the contract's amount type).
export const isU128 = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,38}$/.test(v) && BigInt(v) < 2n ** 128n;
// Canonical non-negative decimal (balances may be 0).
export const isDecimal = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]{0,38})$/.test(v);
export const isDecimals = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_DECIMALS;
// Block timestamp in ns, bounded so `new Date(ns / 1e6)` is always a valid date.
export const MAX_TS_NS = 8_640_000_000_000_000_000_000n;
export const isTimestampNs = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]{0,21})$/.test(v) && BigInt(v) <= MAX_TS_NS;

// Amount for display. Feed decimals are bounded first; anything unusable = raw base units.
// Symbol/decimals come from the runner, not from the chain, so the caller labels them.
export function fmtEvidenceAmount(raw: unknown, decimals: unknown, symbol: unknown): string {
  const sym = typeof symbol === "string" && symbol ? ` ${symbol}` : "";
  if (!isDecimal(raw)) return "invalid amount";
  if (!isDecimals(decimals)) return `${raw} base units${sym}`;
  try { return `${formatUnits(raw, decimals)}${sym}`; } catch { return `${raw} base units${sym}`; }
}

export function fmtBlockTime(ns: unknown): string | null {
  if (ns === null || ns === undefined) return null;
  if (!isTimestampNs(ns)) return "invalid timestamp";
  try {
    const d = new Date(Number(BigInt(ns) / 1_000_000n));
    return Number.isNaN(d.getTime()) ? "invalid timestamp" : d.toISOString().replace("T", " ").slice(0, 19);
  } catch { return "invalid timestamp"; }
}

// Everything a verification result depends on. A cached result is only shown when its
// fingerprint equals the CURRENT record's, so a refresh that changes any field hides the
// old result at once (synchronously, in render), before re-verification finishes.
export function recordFingerprint(r: object, ctx: string): string {
  const o = r as Record<string, unknown>;
  return JSON.stringify([ctx, ...Object.keys(o).sort().map((k) => [k, o[k]])]);
}

export type Fingerprinted<V> = { fp: string; v: V };
export function resultFor<V>(cache: Record<string, Fingerprinted<V>>, key: string, fp: string): V | undefined {
  const hit = cache[key];
  return hit && hit.fp === fp ? hit.v : undefined;
}

// Duplicate tx hashes across records are ambiguous: one chain result could vouch for two rows.
export function duplicateTxHash(records: { tx_hash: string | null }[]): string | null {
  const seen = new Set<string>();
  for (const r of records) {
    if (r.tx_hash === null) continue;
    if (seen.has(r.tx_hash)) return r.tx_hash;
    seen.add(r.tx_hash);
  }
  return null;
}
