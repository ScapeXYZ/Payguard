import { NearBindgen, near, call, view, initialize, NearPromise } from "near-sdk-js";
import {
  initialize as initializeConfig, setPolicy, reserve, getPolicy, getSpending, dayAt, TRANSFER_GAS,
  activatePolicy, cancelPolicy, disablePolicy, getPendingPolicy,
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

  @initialize({})
  init({ owner_id, agent_id }: { owner_id: string; agent_id: string }): void {
    const config = initializeConfig(host, owner_id, agent_id);
    this.owner_id = config.owner_id;
    this.agent_id = config.agent_id;
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
  get_config(): { owner_id: string; agent_id: string } {
    return { owner_id: this.owner_id, agent_id: this.agent_id };
  }

  @view({})
  get_policy({ token_id }: { token_id: string }) { return getPolicy(host, token_id); }

  @view({})
  get_spending({ token_id, day }: { token_id: string; day?: string }) {
    const utc_day = day ?? dayAt(host);
    return { token_id: token_id.toLowerCase(), day: utc_day, spent: getSpending(host, token_id, utc_day) };
  }
}
