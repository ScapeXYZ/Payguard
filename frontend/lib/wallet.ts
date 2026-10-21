// NEAR Wallet Selector placeholder.
// Wire with @near-wallet-selector/core + modal-ui + my-near-wallet / meteor / here-wallet.
// Every write button in the UI calls `signAndSend` below; it is simulated until
// this file is wired. Methods and args match contract/guard.ts exactly.

export type WriteCall =
  | { method: "init"; args: { owner_id: string; agent_id: string; guardian_id: string; exit_id: string } }
  | { method: "set_policy"; args: { token_id: string; max_per_payment: string; daily_limit: string; recipients: string[] } }
  | { method: "activate_policy"; args: { proposal_id: string } }
  | { method: "cancel_policy"; args: Record<string, never> }
  | { method: "disable_policy"; args: { token_id: string } }
  | { method: "propose_guardian_change"; args: { guardian_id: string } }
  | { method: "cancel_guardian_change"; args: Record<string, never> }
  | { method: "activate_guardian_change"; args: { proposal_id: string } }
  | { method: "propose_owner_recovery"; args: { owner_id: string } }
  | { method: "cancel_owner_recovery"; args: Record<string, never> }
  | { method: "activate_owner_recovery"; args: { proposal_id: string } }
  | { method: "emergency_sweep"; args: { token_id: string }; gasTgas: 200 };

export const WALLET_WIRED = false;

export async function signAndSend(call: WriteCall): Promise<{ simulated: true; call: WriteCall }> {
  // TODO(contract author): selector.wallet().signAndSendTransaction({ receiverId: CONTRACT,
  //   actions: [{ type: "FunctionCall", params: { methodName: call.method, args: call.args,
  //   gas: emergency_sweep ? "200000000000000" : "30000000000000", deposit: "0" } }] })
  // Note: emergency_sweep requires 180-250 Tgas prepaid (beginSweep check).
  return { simulated: true, call };
}
