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

// Pure validation: no ledger reads or writes.
function validatePayment(p: Payment, policy: Policy, spent: number): Decision {
  if (!p.to || !p.token || !Number.isFinite(p.amount) || !(p.amount > 0)) {
    return { allow: false, rule: "bad_input", reason: "payment needs a recipient, a token and a finite amount above 0" };
  }
  if (!policy.knownAddresses.some((a) => a.toLowerCase() === p.to.toLowerCase())) {
    return { allow: false, rule: "unknown_address", reason: `recipient ${p.to} is not on the known address list` };
  }
  const max = tokenLimit(policy.maxPerPayment, p.token);
  const limit = tokenLimit(policy.dailyLimit, p.token);
  if (max === undefined || limit === undefined) {
    return { allow: false, rule: "unknown_token", reason: `token ${p.token} needs both payment and daily limits` };
  }
  if (p.amount > max) {
    return { allow: false, rule: "max_per_payment", reason: `${p.amount} ${p.token} is above the ${max} ${p.token} per-payment cap` };
  }
  if (spent + p.amount > limit) {
    return { allow: false, rule: "daily_limit", reason: `would bring today's ${p.token} total to ${spent + p.amount}, limit is ${limit}` };
  }
  return { allow: true, reason: "passes all 3 rules" };
}

// Choose the strictest cap if policy keys differ only by case.
function tokenLimit(limits: Record<string, number>, token: string): number | undefined {
  const matches = Object.entries(limits).filter(([key]) => key.toLowerCase() === token.toLowerCase());
  if (!matches.length || matches.some(([, value]) => !Number.isFinite(value) || value < 0)) return undefined;
  return Math.min(...matches.map(([, value]) => value));
}

/** One trusted authorization scope. Reuse this instance for every payment. */
export function createPaymentGuard(now: () => Date = () => new Date()) {
  const ledger = new Map<string, Map<string, number>>();
  return function checkPayment(
    p: Payment,
    policy: Policy,
    spentToday: Record<string, number> = {}
  ): Decision {
    const date = now();
    if (!Number.isFinite(date.getTime())) {
      return { allow: false, rule: "bad_input", reason: "clock must return a valid date" };
    }
    const day = date.toISOString().slice(0, 10);
    const token = p.token.toLowerCase();
    const daily = ledger.get(day);
    const recorded = daily?.get(token) ?? 0;
    // Legacy caller data may tighten a check, but can never lower trusted spending.
    const supplied = Object.entries(spentToday)
      .filter(([key, value]) => key.toLowerCase() === token && Number.isFinite(value) && value >= 0)
      .map(([, value]) => value);
    const spent = Math.max(recorded, supplied.reduce((total, amount) => total + amount, 0));
    const decision = validatePayment(p, policy, spent);
    if (decision.allow) {
      const totals = daily ?? new Map<string, number>();
      totals.set(token, spent + p.amount);
      ledger.set(day, totals);
    }
    return decision;
  };
}

// Synchronous validation and reservation have no await point between them.
// This shared instance accounts for all calls through this module in this process.
export const checkPayment = createPaymentGuard();
