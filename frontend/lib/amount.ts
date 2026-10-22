// Token amounts as exact base-unit BigInts. No floats, no silent truncation.
// Mirrors contract/policy.ts amount(): a positive decimal integer string, <= u128.

export const U128_MAX = (1n << 128n) - 1n;

export type ParseResult = { ok: true; raw: string } | { ok: false; error: string };

// "12.5" with 6 decimals -> "12500000". Rejects anything the contract would reject,
// plus anything that would lose precision on the way in.
export function parseUnits(input: string, decimals: number): ParseResult {
  const v = input.trim();
  if (v === "") return { ok: false, error: "enter an amount" };
  if (v.startsWith("-")) return { ok: false, error: "amount can't be negative" };
  if (!/^\d+(\.\d+)?$/.test(v)) return { ok: false, error: "use digits and one decimal point only, like 12.50" };
  const [whole, frac = ""] = v.split(".");
  if (frac.length > decimals) return { ok: false, error: `this token has ${decimals} decimals; ${frac.length} given. Nothing was rounded, shorten it` };
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (raw <= 0n) return { ok: false, error: "amount must be greater than zero" };
  if (raw > U128_MAX) return { ok: false, error: "amount is too large for the contract (u128)" };
  return { ok: true, raw: raw.toString() };
}

// Full precision, trailing zeros trimmed: "12500000" (6) -> "12.5". Never cuts digits.
export function formatUnits(raw: string, decimals: number): string {
  let v: bigint;
  try { v = BigInt(raw); } catch { return raw; }
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = (v / base).toLocaleString("en-US");
  const frac = decimals > 0 ? (v % base).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}
