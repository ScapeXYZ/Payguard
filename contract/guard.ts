import { NearBindgen, near, call, view, initialize, NearPromise } from "near-sdk-js";
import {
  initialize as initializeConfig, setPolicy, reserve, getPolicy, getSpending, dayAt, TRANSFER_GAS,
  activatePolicy, cancelPolicy, disablePolicy, getPendingPolicy,
  getRecoveryCooldown, proposeOwnerRecovery, cancelOwnerRecovery, activateOwnerRecovery, getPendingOwnerRecovery,
  proposeColdKeyGuardianChange, proposeGuardianChange, cancelGuardianChange, activateGuardianChange, getPendingGuardianChange,
  beginSweep, checkSweep, finishSweep, amount, type Host, type Payment,
} from "./policy";

const host: Host = {
  predecessor: () => near.predecessorAccountId(),
  currentAccount: () => near.currentAccountId(),
  attachedDeposit: () => near.attachedDeposit(),
  prepaidGas: () => near.prepaidGas(),
  timestamp: () => near.blockTimestamp(),
  read: (key) => near.storageRead(key),
  write: (key, value) => { near.storageWrite(key, value); },
};

@NearBindgen({ requireInit: true })
class PayGuard {
  owner_id = "";
  agent_id = "";
  guardian_id = "";
  exit_id = "";

  @initialize({})
  init({ owner_id, agent_id, guardian_id, exit_id }: { owner_id: string; agent_id: string; guardian_id: string; exit_id: string }): void {
    const config = initializeConfig(host, owner_id, agent_id, guardian_id, exit_id);
    this.owner_id = config.owner_id;
    this.agent_id = config.agent_id;
    this.guardian_id = config.guardian_id;
    this.exit_id = config.exit_id;
  }

  @call({})
  set_policy(input: { token_id: string; max_per_payment: string; daily_limit: string; recipients: string[] }): void {
    setPolicy(host, this, input);
  }

  @call({})
  activate_policy({ proposal_id }: { proposal_id: string }): void { activatePolicy(host, proposal_id); }

  @call({})
  cancel_policy(): void { cancelPolicy(host, this); }

  @call({})
  disable_policy({ token_id }: { token_id: string }): void { disablePolicy(host, this, token_id); }

  @view({})
  get_pending_policy() { return getPendingPolicy(host); }

  @view({})
  get_recovery_cooldown() { return getRecoveryCooldown(host); }

  @call({})
  propose_owner_recovery({ owner_id }: { owner_id: string }): void { proposeOwnerRecovery(host, this, owner_id); }

  @call({})
  cancel_owner_recovery(): void { cancelOwnerRecovery(host, this); }

  @view({})
  get_pending_owner_recovery() { return getPendingOwnerRecovery(host); }

  @call({})
  activate_owner_recovery({ proposal_id }: { proposal_id: string }): void { activateOwnerRecovery(host, this, proposal_id); }

  @call({})
  propose_guardian_change({ guardian_id }: { guardian_id: string }): void { proposeGuardianChange(host, this, guardian_id); }

  @call({})
  propose_cold_key_guardian_change({ guardian_id }: { guardian_id: string }): void { proposeColdKeyGuardianChange(host, this, guardian_id); }

  @call({})
  cancel_guardian_change(): void { cancelGuardianChange(host, this); }

  @view({})
  get_pending_guardian_change() { return getPendingGuardianChange(host); }

  @call({})
  activate_guardian_change({ proposal_id }: { proposal_id: string }): void { activateGuardianChange(host, this, proposal_id); }

  @call({})
  pay(input: Payment): NearPromise {
    const payment = reserve(host, this, input);
    // Guard owns the FT balance; predecessor of ft_transfer is this contract.
    // No callback releases reservations. A failed later receipt cannot undo them.
    return NearPromise.new(payment.token_id).functionCall("ft_transfer", JSON.stringify({
      receiver_id: payment.recipient_id, amount: payment.amount,
    }), 1n, TRANSFER_GAS);
  }

  @call({})
  emergency_sweep({ token_id }: { token_id: string }): NearPromise {
    const pending = beginSweep(host, this, token_id);
    return NearPromise.new(pending.token_id).functionCall("ft_balance_of",
      JSON.stringify({ account_id: near.currentAccountId() }), 0n, 30_000_000_000_000n)
      .then(NearPromise.new(near.currentAccountId()).functionCall("on_sweep_balance",
        JSON.stringify(pending), 0n, 120_000_000_000_000n));
  }

  @call({ privateFunction: true })
  on_sweep_balance({ token_id, sweep_id }: { token_id: string; sweep_id: string }): NearPromise | string {
    checkSweep(host, token_id, sweep_id);
    let balance: string;
    try {
      const result = JSON.parse(near.promiseResult(0));
      balance = result === "0" ? "0" : amount(result).toString();
    } catch (_) {
      finishSweep(host, token_id, sweep_id);
      return "balance_query_failed";
    }
    if (balance === "0") {
      finishSweep(host, token_id, sweep_id);
      return "zero_balance";
    }
    // Registration is enforced by ft_transfer itself. Never auto-register or
    // select a fallback recipient on failure.
    return NearPromise.new(token_id).functionCall("ft_transfer", JSON.stringify({
      receiver_id: this.exit_id, amount: balance,
    }), 1n, TRANSFER_GAS).then(NearPromise.new(near.currentAccountId()).functionCall(
      "on_sweep_transfer", JSON.stringify({ token_id, sweep_id }), 0n, 30_000_000_000_000n));
  }

  @call({ privateFunction: true })
  on_sweep_transfer({ token_id, sweep_id }: { token_id: string; sweep_id: string }): string {
    checkSweep(host, token_id, sweep_id);
    let status = "transferred";
    try { near.promiseResult(0); } catch (_) { status = "transfer_failed"; }
    finishSweep(host, token_id, sweep_id);
    return status;
  }

  @view({})
  get_config(): { owner_id: string; agent_id: string; guardian_id: string; exit_id: string } {
    return { owner_id: this.owner_id, agent_id: this.agent_id, guardian_id: this.guardian_id, exit_id: this.exit_id };
  }

  @view({})
  get_policy({ token_id }: { token_id: string }) { return getPolicy(host, token_id); }

  @view({})
  get_spending({ token_id, day }: { token_id: string; day?: string }) {
    const utc_day = day ?? dayAt(host);
    return { token_id: token_id.toLowerCase(), day: utc_day, spent: getSpending(host, token_id, utc_day) };
  }
}
