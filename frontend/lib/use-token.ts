"use client";
import { ftMetadata, type FtMetadata } from "./near-rpc";
import { EXPECTED_META, IS_MOCK } from "./guard";
import { useView } from "./use-guard";
import { formatUnits } from "./amount";

export type TokenInfo = {
  id: string;
  meta?: FtMetadata;
  verified: boolean;    // metadata read from the token contract on chain
  mismatch?: string;    // chain metadata differs from what the UI expected
  loading: boolean;
  error?: string;
  fmt: (raw: string) => string; // exact, never truncated; raw base units if unverified
};

// Symbol and decimals come from the token contract's own ft_metadata, never from a
// hard-coded table. Until they're verified, amounts show as raw base units.
export function useToken(id: string): TokenInfo {
  const v = useView(() => (IS_MOCK ? Promise.resolve({ spec: "ft-1.0.0", name: "Mock USDC", symbol: "USDC", decimals: 6 }) : ftMetadata(id)), [id]);
  const meta = v.data;
  const exp = EXPECTED_META[id];
  const mismatch = meta && exp && (meta.decimals !== exp.decimals || meta.symbol !== exp.symbol)
    ? `chain says ${meta.symbol}/${meta.decimals} decimals, expected ${exp.symbol}/${exp.decimals}` : undefined;
  return {
    id, meta, verified: !!meta && !IS_MOCK, mismatch, loading: v.loading, error: v.error,
    fmt: (raw) => (meta ? `${formatUnits(raw, meta.decimals)} ${meta.symbol}` : `${raw} base units`),
  };
}
