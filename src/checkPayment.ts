// payguard: checks every agent payment before it goes out.
// Returns allow or block, always with a reason.

export type Payment = {
  to: string;      // recipient address / account id
  amount: number;  // in token units
  token: string;   // token symbol or contract id
};

export type Policy = {
  maxPerPayment: Record<string, number>; // token -> max amount in one payment
  dailyLimit: Record<string, number>;    // token -> max total per UTC day
  knownAddresses: string[];              // allowlist of recipients
};

export type Decision =
  | { allow: true; reason: string }
  | { allow: false; reason: string; rule: "max_per_payment" | "daily_limit" | "unknown_address" | "bad_input" };

// spentToday: token -> amount already sent today (caller keeps this state for now)
export function checkPayment(
  p: Payment,
  policy: Policy,
  spentToday: Record<string, number> = {}
): Decision {
  if (!p.to || !p.token || !(p.amount > 0)) {
    return { allow: false, rule: "bad_input", reason: "payment needs a recipient, a token and an amount above 0" };
  }

  // rule 1: only known addresses
  if (!policy.knownAddresses.map((a) => a.toLowerCase()).includes(p.to.toLowerCase())) {
    return { allow: false, rule: "unknown_address", reason: `recipient ${p.to} is not on the known address list` };
  }

  // rule 2: max per payment
  const max = policy.maxPerPayment[p.token];
  if (max !== undefined && p.amount > max) {
    return { allow: false, rule: "max_per_payment", reason: `${p.amount} ${p.token} is above the ${max} ${p.token} per-payment cap` };
  }

  // rule 3: daily limit
  const limit = policy.dailyLimit[p.token];
  const spent = spentToday[p.token] ?? 0;
  if (limit !== undefined && spent + p.amount > limit) {
    return { allow: false, rule: "daily_limit", reason: `would bring today's ${p.token} total to ${spent + p.amount}, limit is ${limit}` };
  }

  return { allow: true, reason: "passes all 3 rules" };
}
