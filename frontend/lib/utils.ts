import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { TOKEN_META, nowNs } from "./guard";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmt(raw: string, token: string) {
  const d = TOKEN_META[token]?.decimals ?? 24;
  const v = BigInt(raw);
  const whole = v / 10n ** BigInt(d);
  const frac = (v % 10n ** BigInt(d)).toString().padStart(d, "0").slice(0, 2);
  return `${whole.toLocaleString()}${frac !== "00" ? "." + frac : ""} ${TOKEN_META[token]?.symbol ?? token}`;
}

export function remaining(activateAfterNs: string) {
  const left = BigInt(activateAfterNs) - nowNs();
  if (left <= 0n) return { done: true, label: "ready to activate", pct: 100 };
  const s = Number(left / 1_000_000_000n);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pct = Math.min(100, Math.max(0, 100 - (s / 86400) * 100));
  return { done: false, label: `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`, pct };
}
