import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { nowNs } from "./guard";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Countdown to an on-chain ns timestamp. The contract compares against BLOCK time, so the
// label says "ready" only once the deadline has passed by device clock; the activate call
// itself is what proves it (a too-early call fails with *_timelocked).
export function remaining(activateAfterNs: string, totalNs = 86_400_000_000_000n) {
  const target = BigInt(activateAfterNs);
  const left = target - nowNs();
  const at = new Date(Number(target / 1_000_000n));
  const atLabel = at.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  if (left <= 0n) return { done: true, label: "timelock finished", pct: 100, at: atLabel };
  const s = Number(left / 1_000_000_000n);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pct = Math.min(100, Math.max(0, 100 - (Number(left / 1_000_000n) / Number(totalNs / 1_000_000n)) * 100));
  return { done: false, label: `${d ? d + "d " : ""}${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`, pct, at: atLabel };
}

export const short = (s: string, n = 8) => (s.length > 2 * n + 3 ? `${s.slice(0, n)}...${s.slice(-n)}` : s);
