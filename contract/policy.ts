// Shared by the WASM contract and deterministic tests. All monetary values are u128.
export const U128_MAX = (1n << 128n) - 1n;
export const DAY_NS = 86_400_000_000_000n;
export const POLICY_DELAY_NS = DAY_NS; // Fixed 24 hours; no configurable bypass.
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
export type Config = { owner_id: string; agent_id: string; guardian_id: string };
export type Payment = { request_id: string; token_id: string; recipient_id: string; amount: string };

function zeroDeposit(host: Host): void {
  requireThat(host.attachedDeposit() === 0n, "zero_deposit_required");
}

export function initialize(host: Host, owner: unknown, agent: unknown, guardian: unknown): Config {
  zeroDeposit(host);
  const owner_id = accountId(owner);
  const agent_id = accountId(agent);
  requireThat(host.predecessor() === owner_id, "owner_only");
  requireThat(agent_id !== owner_id && agent_id !== host.currentAccount(), "separate_agent_required");
  requireThat(owner_id !== host.currentAccount(), "separate_owner_required");
  const guardian_id = accountId(guardian);
  requireThat(![owner_id, agent_id, host.currentAccount()].includes(guardian_id), "separate_guardian_required");
  return { owner_id, agent_id, guardian_id };
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
  const target: TokenPolicy = { max_per_payment: cap.toString(), daily_limit: daily.toString(), recipients };
  const old = getPolicy(host, token);
  const tightening = old !== null && cap <= BigInt(old.max_per_payment) &&
    daily <= BigInt(old.daily_limit) && recipients.every(id => old.recipients.includes(id));
  if (tightening) {
    host.write("pending_policy", "null");
    host.write("policy:" + token, JSON.stringify(target));
    return;
  }
  requireThat(getPendingOwnerRecovery(host) === null, "recovery_pending");
  requireThat(getPendingPolicy(host) === null, "pending_policy_exists");
  // Apply the intersection now: mixed changes cannot postpone tightening.
  if (old !== null) {
    host.write("policy:" + token, JSON.stringify({
      max_per_payment: (cap < BigInt(old.max_per_payment) ? cap : BigInt(old.max_per_payment)).toString(),
      daily_limit: (daily < BigInt(old.daily_limit) ? daily : BigInt(old.daily_limit)).toString(),
      recipients: old.recipients.filter(id => recipients.includes(id)),
    }));
  }
  const proposal_id = (BigInt(host.read("policy_sequence") ?? "0") + 1n).toString();
  host.write("policy_sequence", proposal_id);
  host.write("pending_policy", JSON.stringify({ proposal_id, token_id: token, policy: target,
    activate_after: (host.timestamp() + POLICY_DELAY_NS).toString() }));
  // Never edit spending or request markers.
}

export type PendingPolicy = {
  proposal_id: string; token_id: string; policy: TokenPolicy; activate_after: string;
};

export function getPendingPolicy(host: Host): PendingPolicy | null {
  return JSON.parse(host.read("pending_policy") ?? "null");
}

export function cancelPolicy(host: Host, config: Config): void {
  zeroDeposit(host);
  requireThat([config.owner_id, config.guardian_id].includes(host.predecessor()), "owner_or_guardian_only");
  host.write("pending_policy", "null");
}

export function disablePolicy(host: Host, config: Config, token: unknown): void {
  zeroDeposit(host);
  requireThat(host.predecessor() === config.owner_id, "owner_only");
  const id = accountId(token);
  host.write("pending_policy", "null");
  host.write("policy:" + id, "null");
}

export function activatePolicy(host: Host, proposalId: unknown): void {
  zeroDeposit(host);
  requireThat(getPendingOwnerRecovery(host) === null, "recovery_pending");
  const pending = getPendingPolicy(host);
  requireThat(pending !== null, "no_pending_policy");
  requireThat(proposalId === pending.proposal_id, "proposal_id_mismatch");
  requireThat(host.timestamp() >= BigInt(pending.activate_after), "policy_timelocked");
  host.write("policy:" + pending.token_id, JSON.stringify(pending.policy));
  host.write("pending_policy", "null");
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

// Identity changes never schedule promises or touch payment accounting.
export const RECOVERY_DELAY_NS = DAY_NS;
export const RECOVERY_COOLDOWN_NS = DAY_NS; // Fixed 24 hours after an owner veto.
export function getRecoveryCooldown(host: Host): string {
  return host.read("recovery_cooldown_until") ?? "0";
}
export type PendingIdentity = { proposal_id: string; account_id: string; activate_after: string; owner_proposed?: boolean };
export function getPendingOwnerRecovery(host: Host): PendingIdentity | null {
  return JSON.parse(host.read("pending_owner_recovery") ?? "null");
}
export function getPendingGuardianChange(host: Host): PendingIdentity | null {
  return JSON.parse(host.read("pending_guardian_change") ?? "null");
}
function proposeIdentity(host: Host, config: Config, replacement: unknown, recovery: boolean): void {
  zeroDeposit(host);
  if (recovery) {
    requireThat(host.predecessor() === config.guardian_id, "guardian_only");
    requireThat(host.timestamp() >= BigInt(getRecoveryCooldown(host)), "recovery_cooldown");
  } else {
    requireThat([config.owner_id, config.guardian_id].includes(host.predecessor()), "owner_or_guardian_only");
    if (host.predecessor() !== config.owner_id) {
      requireThat(!getPendingGuardianChange(host)?.owner_proposed, "owner_guardian_change_pending");
      requireThat(getPendingOwnerRecovery(host) === null, "recovery_pending");
    }
  }
  const account_id = accountId(replacement);
  requireThat(![config.owner_id, config.agent_id, config.guardian_id, host.currentAccount()].includes(account_id), "separate_replacement_required");
  const proposal_id = (BigInt(host.read("identity_sequence") ?? "0") + 1n).toString();
  host.write("identity_sequence", proposal_id);
  host.write(recovery ? "pending_owner_recovery" : "pending_guardian_change", JSON.stringify({
    proposal_id, account_id, activate_after: (host.timestamp() + RECOVERY_DELAY_NS).toString(),
    ...(!recovery ? { owner_proposed: host.predecessor() === config.owner_id } : {}),
  }));
  if (recovery) {
    host.write("pending_policy", "null");
    if (!getPendingGuardianChange(host)?.owner_proposed) host.write("pending_guardian_change", "null");
  }
}
export function proposeOwnerRecovery(host: Host, config: Config, replacement: unknown): void {
  proposeIdentity(host, config, replacement, true);
}
// The current owner can veto immediately, including after the recovery deadline.
// Preserve the identity sequence so a canceled proposal can never be reused.
export function cancelOwnerRecovery(host: Host, config: Config): void {
  zeroDeposit(host);
  requireThat(host.predecessor() === config.owner_id, "owner_only");
  if (getPendingOwnerRecovery(host) !== null) {
    host.write("recovery_cooldown_until", (host.timestamp() + RECOVERY_COOLDOWN_NS).toString());
    host.write("pending_owner_recovery", "null");
  }
}
export function proposeGuardianChange(host: Host, config: Config, replacement: unknown): void {
  proposeIdentity(host, config, replacement, false);
}
function activateIdentity(host: Host, config: Config, proposalId: unknown, recovery: boolean): void {
  zeroDeposit(host);
  const pending = recovery ? getPendingOwnerRecovery(host) : getPendingGuardianChange(host);
  requireThat(pending !== null, "no_pending_identity");
  requireThat(pending.proposal_id === proposalId, "proposal_id_mismatch");
  requireThat(host.timestamp() >= BigInt(pending.activate_after), "identity_timelocked");
  requireThat(![config.owner_id, config.agent_id, config.guardian_id, host.currentAccount()].includes(pending.account_id), "separate_replacement_required");
  if (recovery) {
    config.owner_id = pending.account_id;
    // The former owner's pending administration cannot survive ownership recovery.
    host.write("pending_guardian_change", "null");
  } else {
    config.guardian_id = pending.account_id;
    // Displaced guardian authority must not survive in a queued recovery.
    host.write("pending_owner_recovery", "null");
  }
  host.write(recovery ? "pending_owner_recovery" : "pending_guardian_change", "null");
}
export function activateOwnerRecovery(host: Host, config: Config, proposalId: unknown): void {
  activateIdentity(host, config, proposalId, true);
}
export function activateGuardianChange(host: Host, config: Config, proposalId: unknown): void {
  activateIdentity(host, config, proposalId, false);
}
