// Shared by the WASM contract and deterministic tests. All monetary values are u128.
export const U128_MAX = (1n << 128n) - 1n;
export const DAY_NS = 86_400_000_000_000n;
export const TRANSFER_GAS = 30_000_000_000_000n;
export const MIN_PAY_GAS = 60_000_000_000_000n;
export const MAX_PAY_GAS = 100_000_000_000_000n;

export function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// JavaScript's $ anchor also matches before a final newline. Require the
// matched substring to equal the entire input for canonical on-chain keys.
function fullMatch(value: string, pattern: RegExp): boolean {
  return pattern.exec(value)?.[0] === value;
}

// ASCII account IDs only. Symbols, whitespace and separator runs are rejected.
export function accountId(value: unknown): string {
  requireThat(typeof value === "string", "bad_account_id");
  requireThat(fullMatch(value, /^[A-Za-z0-9._-]+$/), "bad_account_id");
  const id = value.toLowerCase();
  requireThat(id.length >= 2 && id.length <= 64 &&
    fullMatch(id, /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/), "bad_account_id");
  return id;
}

export function amount(value: unknown): bigint {
  requireThat(typeof value === "string" && fullMatch(value, /^[1-9][0-9]{0,38}$/), "bad_amount");
  const result = BigInt(value);
  requireThat(result <= U128_MAX, "amount_overflow");
  return result;
}

export type TokenPolicy = {
  max_per_payment: string;
  daily_limit: string;
  recipients: string[];
};
export type Host = {
  predecessor(): string;
  currentAccount(): string;
  attachedDeposit(): bigint;
  prepaidGas(): bigint;
  timestamp(): bigint;
  read(key: string): string | null;
  write(key: string, value: string): void;
};
export type Config = { owner_id: string; agent_id: string };
export type Payment = { request_id: string; token_id: string; recipient_id: string; amount: string };

function zeroDeposit(host: Host): void {
  requireThat(host.attachedDeposit() === 0n, "zero_deposit_required");
}

export function initialize(host: Host, owner: unknown, agent: unknown): Config {
  zeroDeposit(host);
  const owner_id = accountId(owner);
  const agent_id = accountId(agent);
  requireThat(host.predecessor() === owner_id, "owner_only");
  requireThat(agent_id !== owner_id && agent_id !== host.currentAccount(), "separate_agent_required");
  requireThat(owner_id !== host.currentAccount(), "separate_owner_required");
  return { owner_id, agent_id };
}

export function setPolicy(host: Host, config: Config, input: {
  token_id: unknown; max_per_payment: unknown; daily_limit: unknown; recipients: unknown;
}): void {
  zeroDeposit(host);
  requireThat(host.predecessor() === config.owner_id, "owner_only");
  const token = accountId(input.token_id);
  requireThat(token !== host.currentAccount(), "invalid_token_contract");
  const cap = amount(input.max_per_payment);
  const daily = amount(input.daily_limit);
  requireThat(cap <= daily, "cap_exceeds_daily_limit");
  requireThat(Array.isArray(input.recipients) && input.recipients.length <= 100, "bad_recipients");
  const recipients = [...new Set(input.recipients.map(accountId))];
  requireThat(!recipients.includes(host.currentAccount()), "self_payment_forbidden");
  host.write("policy:" + token, JSON.stringify({
    max_per_payment: cap.toString(), daily_limit: daily.toString(), recipients,
  }));
  // Reconfiguration never edits spending, including historical days.
}

export function getPolicy(host: Host, token: unknown): TokenPolicy | null {
  const stored = host.read("policy:" + accountId(token));
  return stored === null ? null : JSON.parse(stored);
}

export function dayAt(host: Host): string {
  return (host.timestamp() / DAY_NS).toString();
}

export function getSpending(host: Host, token: unknown, day: unknown): string {
  requireThat(typeof day === "string" && fullMatch(day, /^(0|[1-9][0-9]{0,19})$/), "bad_day");
  return host.read("spent:" + accountId(token) + ":" + day) ?? "0";
}

// Called within a single NEAR receipt. No async boundary before reservation.
export function reserve(host: Host, config: Config, input: Payment): Payment {
  zeroDeposit(host);
  requireThat(host.predecessor() === config.agent_id, "agent_only");
  requireThat(host.prepaidGas() >= MIN_PAY_GAS && host.prepaidGas() <= MAX_PAY_GAS, "pay_gas_out_of_range");
  requireThat(typeof input.request_id === "string" && fullMatch(input.request_id, /^[A-Za-z0-9_-]{1,64}$/), "bad_request_id");
  const requestKey = "request:" + input.request_id;
  requireThat(host.read(requestKey) === null, "duplicate_request");
  const token_id = accountId(input.token_id);
  const recipient_id = accountId(input.recipient_id);
  const units = amount(input.amount);
  const policy = getPolicy(host, token_id);
  requireThat(policy !== null, "unknown_token");
  requireThat(policy.recipients.includes(recipient_id), "unapproved_recipient");
  requireThat(units <= BigInt(policy.max_per_payment), "max_per_payment");
  const day = dayAt(host);
  const spent = BigInt(getSpending(host, token_id, day));
  requireThat(units <= BigInt(policy.daily_limit) - spent, "daily_limit");
  host.write("spent:" + token_id + ":" + day, (spent + units).toString());
  // Written in the same receipt as spending and promise creation. Retained after
  // downstream transfer failure, across policy changes and UTC-day rollover.
  host.write(requestKey, "reserved");
  return { request_id: input.request_id, token_id, recipient_id, amount: units.toString() };
}
