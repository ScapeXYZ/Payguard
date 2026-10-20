import { NearBindgen, near, call, view, initialize, NearPromise } from "near-sdk-js";
import {
  initialize as initializeConfig, setPolicy, reserve, getPolicy, getSpending, dayAt, TRANSFER_GAS,
  activatePolicy, cancelPolicy, disablePolicy, getPendingPolicy,
  getRecoveryCooldown, proposeOwnerRecovery, cancelOwnerRecovery, activateOwnerRecovery, getPendingOwnerRecovery,
  proposeGuardianChange, activateGuardianChange, getPendingGuardianChange,
  type Host, type Payment,
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

  @initialize({})
  init({ owner_id, agent_id, guardian_id }: { owner_id: string; agent_id: string; guardian_id: string }): void {
    const config = initializeConfig(host, owner_id, agent_id, guardian_id);
    this.owner_id = config.owner_id;
    this.agent_id = config.agent_id;
    this.guardian_id = config.guardian_id;
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

  @view({})
  get_config(): { owner_id: string; agent_id: string; guardian_id: string } {
    return { owner_id: this.owner_id, agent_id: this.agent_id, guardian_id: this.guardian_id };
  }

  @view({})
  get_policy({ token_id }: { token_id: string }) { return getPolicy(host, token_id); }

  @view({})
  get_spending({ token_id, day }: { token_id: string; day?: string }) {
    const utc_day = day ?? dayAt(host);
    return { token_id: token_id.toLowerCase(), day: utc_day, spent: getSpending(host, token_id, utc_day) };
  }
}
