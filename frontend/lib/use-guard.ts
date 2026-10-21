"use client";
import { useEffect, useState } from "react";

// Tiny loader for view calls. Re-polls every 15s so pending timers stay honest.
export function useView<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    let alive = true;
    const load = () => fn().then((d) => alive && setData(d)).catch((e) => alive && setError(String(e?.message ?? e)));
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error };
}

// 1s ticker for countdowns.
export function useTick() {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((n) => n + 1), 1000); return () => clearInterval(t); }, []);
}
