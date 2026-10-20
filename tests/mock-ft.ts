// Local Sandbox fixture ONLY. Transfer-compatible subset, not a production FT.
import { NearBindgen, near, initialize, call, view, NearPromise } from "near-sdk-js";
import { accountId, amount, requireThat } from "../contract/policy";

@NearBindgen({ requireInit: true })
class MockFt {
  owner_id = "";

  // Test-only relay: signer remains the agent, predecessor at guard is this FT.
  @call({})
  forward_pay({ guard_id, payment }: { guard_id: string; payment: Record<string, string> }): NearPromise {
    return NearPromise.new(guard_id).functionCall("pay", JSON.stringify(payment), 0n, 80_000_000_000_000n);
  }

  // Test-only identity relay proves signer authority is not inherited.
  @call({})
  forward_identity({ guard_id, method, args }: { guard_id: string; method: string; args: Record<string, string> }): NearPromise {
    return NearPromise.new(guard_id).functionCall(method, JSON.stringify(args), 0n, 30_000_000_000_000n);
  }

  @initialize({})
  init({ owner_id, total_supply }: { owner_id: string; total_supply: string }): void {
    requireThat(near.predecessorAccountId() === owner_id, "owner_only");
    this.owner_id = accountId(owner_id);
    near.storageWrite("balance:" + this.owner_id, amount(total_supply).toString());
  }

  @call({ payableFunction: true })
  storage_deposit({ account_id }: { account_id: string }): void {
    const id = accountId(account_id);
    if (near.storageRead("balance:" + id) === null) near.storageWrite("balance:" + id, "0");
  }

  @call({ payableFunction: true })
  ft_transfer({ receiver_id, amount: units }: { receiver_id: string; amount: string }): void {
    requireThat(near.attachedDeposit() === 1n, "requires_one_yocto");
    const sender = near.predecessorAccountId();
    const receiver = accountId(receiver_id);
    requireThat(sender !== receiver, "self_transfer");
    const recipientBalance = near.storageRead("balance:" + receiver);
    requireThat(recipientBalance !== null, "recipient_not_registered");
    const balance = BigInt(near.storageRead("balance:" + sender) ?? "0");
    const value = amount(units);
    requireThat(balance >= value, "insufficient_balance");
    near.storageWrite("balance:" + sender, (balance - value).toString());
    near.storageWrite("balance:" + receiver, (BigInt(recipientBalance) + value).toString());
  }

  @view({})
  ft_balance_of({ account_id }: { account_id: string }): string {
    return near.storageRead("balance:" + accountId(account_id)) ?? "0";
  }
}
