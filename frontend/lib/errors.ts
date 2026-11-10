// Every requireThat() code in contract/policy.ts (main @ d147ac9), in plain words.
export const CONTRACT_ERRORS: Record<string, string> = {
  agent_only: "Only the agent account can request payments.",
  amount_overflow: "Amount is larger than the contract can hold.",
  bad_account_id: "Not a valid NEAR account id (lowercase letters, digits, . _ -).",
  bad_amount: "Amount must be a positive whole number of base units.",
  bad_day: "Invalid UTC day.",
  bad_recipients: "Recipient list is malformed or longer than 100.",
  bad_request_id: "Request id must be 1-64 characters: letters, digits, _ or -.",
  canonical_exit_required: "Exit account must be written in exact lowercase form.",
  cap_exceeds_daily_limit: "Per-payment cap can't be larger than the daily limit.",
  cold_key_guardian_change_pending: "A cold-key guardian change is pending; only the owner can veto it, and recovery is paused until it resolves.",
  daily_limit: "Blocked: this payment would exceed today's spending limit.",
  duplicate_request: "Blocked: this request id was already used (replay protection).",
  exit_only: "Only the exit (cold) account can propose a cold-key guardian change.",
  guardian_only: "Only the current guardian can do this.",
  identity_timelocked: "The 24h timelock on this proposal hasn't finished yet.",
  invalid_token_contract: "The guard itself can't be used as a token.",
  max_per_payment: "Blocked: amount is above the per-payment cap.",
  no_pending_identity: "There is no pending proposal to activate.",
  no_pending_policy: "There is no pending policy to activate.",
  owner_guardian_change_pending: "The owner already proposed a guardian change; the guardian can't replace it.",
  owner_only: "Only the owner can do this.",
  owner_or_guardian_only: "Only the owner or the guardian can do this.",
  pay_gas_out_of_range: "Payment must attach 60-100 Tgas.",
  pending_policy_exists: "A policy change is already pending. Cancel it or wait for it before proposing another loosening.",
  policy_timelocked: "The 24h timelock on this policy hasn't finished yet.",
  private_callback: "Internal callback; can't be called directly.",
  proposal_id_mismatch: "That proposal was replaced. Refresh and try again.",
  recovery_cooldown: "Owner vetoed a recovery recently; a new one can be proposed after the cooldown.",
  recovery_pending: "An owner recovery is pending; policy loosening and activation are paused.",
  self_payment_forbidden: "The guard can't be one of its own recipients.",
  separate_agent_required: "The agent must be a different account from the owner and the guard.",
  separate_exit_required: "The exit account must be different from every other role.",
  separate_guardian_required: "The guardian must be different from owner, agent and guard.",
  separate_owner_required: "The owner can't be the guard account itself.",
  separate_replacement_required: "The new account must be different from every current role.",
  stale_sweep: "Sweep state changed; refresh.",
  sweep_gas_out_of_range: "Emergency sweep must attach 180-250 Tgas.",
  sweep_pending: "A sweep is already running for this token.",
  unapproved_recipient: "Blocked: recipient is not on the allowlist.",
  unknown_token: "Blocked: there is no active policy for this token.",
  zero_deposit_required: "This call must not attach NEAR.",
};

const CODE_RE = new RegExp(`\\b(${Object.keys(CONTRACT_ERRORS).join("|")})\\b`);

export function contractErrorCode(failure: unknown): string | null {
  const s = typeof failure === "string" ? failure : JSON.stringify(failure ?? "");
  return CODE_RE.exec(s)?.[1] ?? null;
}

// Human sentence for any failure shape (contract panic, wallet error, RPC error).
export function describeFailure(failure: unknown): string {
  const code = contractErrorCode(failure);
  if (code) return `${CONTRACT_ERRORS[code]} (${code})`;
  const s = typeof failure === "string" ? failure : failure instanceof Error ? failure.message : JSON.stringify(failure);
  if (/Contract already initialized/.test(s)) return "This guard is already initialised; init can only run once.";
  if (/Contract must be initialized/.test(s)) return "This guard hasn't been initialised yet.";
  if (/LackBalanceForState/.test(s)) return "The account doesn't hold enough NEAR to cover its storage.";
  if (/NotEnoughBalance/.test(s)) return "Signer account doesn't have enough NEAR for gas.";
  if (/Exceeded the prepaid gas|GasExceeded/.test(s)) return "Ran out of gas.";
  if (/AccessKeyNotFound|InvalidAccessKey|not allowed to call/i.test(s)) return "The wallet's key for this account can't sign this call.";
  return s.length > 240 ? s.slice(0, 240) + "..." : s;
}

export function isUserRejection(e: unknown): boolean {
  // Transport failures, contract rejections and a closed wallet window do not
  // prove that nothing was broadcast. Only an explicit user refusal unlocks signing.
  const error = e as { code?: unknown; type?: unknown; message?: unknown } | null;
  if (error?.code === 4001 || error?.code === "USER_REJECTED" || error?.type === "UserRejected") return true;
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : error?.message;
  return typeof message === "string" && /^user (?:rejected|denied|cancelled|canceled)(?: the)? (?:request|transaction|signature)[.!]?$/i.test(message);
}
