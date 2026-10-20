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
  | { allow: false; reason: string; rule: "max_per_payment" | "daily_limit" | "unknown_address" | "unknown_token" | "bad_input" };

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

  const token = p.token.toUpperCase();
  const matchingAmounts = (amounts: Record<string, number>) =>
    Object.entries(amounts)
      .filter(([key]) => key.toUpperCase() === token)
      .map(([, amount]) => amount);
  // If multiple case variants are configured, retain the strictest cap.
  const maxima = matchingAmounts(policy.maxPerPayment);
  const limits = matchingAmounts(policy.dailyLimit);
  const max = maxima.length ? Math.min(...maxima) : undefined;
  const limit = limits.length ? Math.min(...limits) : undefined;
  if (max === undefined || limit === undefined) {
    return { allow: false, rule: "unknown_token", reason: `token ${p.token} must have both a per-payment cap and a daily limit configured` };
  }

  // rule 2: max per payment
  if (max !== undefined && p.amount > max) {
    return { allow: false, rule: "max_per_payment", reason: `${p.amount} ${p.token} is above the ${max} ${p.token} per-payment cap` };
  }

  // rule 3: daily limit
  const spent = matchingAmounts(spentToday).reduce((total, amount) => total + amount, 0);
  if (limit !== undefined && spent + p.amount > limit) {
    return { allow: false, rule: "daily_limit", reason: `would bring today's ${p.token} total to ${spent + p.amount}, limit is ${limit}` };
  }

  return { allow: true, reason: "passes all 3 rules" };
}
