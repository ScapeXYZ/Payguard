"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export const POLL_MS = 15_000;
export const STALE_MS = 45_000; // three missed polls

export type ViewState<T> = {
  data: T | undefined;
  error: string | undefined;     // last attempt failed (data may still be the previous good value)
  loading: boolean;              // first load, nothing to show yet
  updatedAt: number | undefined; // ms of last successful read
  stale: boolean;                // showing data older than STALE_MS, or the last refresh failed
  refresh: () => void;
};

// View-call loader. Re-polls so countdowns and pending state stay honest, keeps the last
// good value on failure but marks it stale, and refreshes on demand after a transaction.
export function useView<T>(fn: () => Promise<T>, deps: unknown[] = []): ViewState<T> {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [updatedAt, setUpdatedAt] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [, tick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const gen = useRef(0);

  const load = useCallback(() => {
    const g = gen.current;
    fnRef.current()
      .then((d) => { if (g !== gen.current) return; setData(d); setError(undefined); setUpdatedAt(Date.now()); })
      .catch((e) => { if (g !== gen.current) return; setError(String(e?.message ?? e)); })
      .finally(() => { if (g === gen.current) setLoading(false); });
  }, []);

  useEffect(() => {
    gen.current++;
    setData(undefined); setError(undefined); setUpdatedAt(undefined); setLoading(true);
    load();
    const t = setInterval(load, POLL_MS);
    const s = setInterval(() => tick((n) => n + 1), 5_000);
    const onRefresh = () => load();
    window.addEventListener("payguard-refresh", onRefresh);
    return () => { gen.current++; clearInterval(t); clearInterval(s); window.removeEventListener("payguard-refresh", onRefresh); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const stale = !!updatedAt && (Date.now() - updatedAt > STALE_MS || !!error);
  return { data, error, loading, updatedAt, stale, refresh: load };
}

// Every view on the page re-reads (after a confirmed transaction).
export const refreshAllViews = () => window.dispatchEvent(new Event("payguard-refresh"));

// 1s ticker for countdowns.
export function useTick() {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((n) => n + 1), 1000); return () => clearInterval(t); }, []);
}
