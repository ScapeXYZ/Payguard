import { setTimeout } from "node:timers/promises";

// Explicit operator procedure using near-workspaces account/provider interfaces.
// No CLI, credential loading, public-network selection, or key persistence.
export async function lockGuard({ guard, provider, signingKey, ownerId, agentId, confirmation }) {
  if (confirmation !== `LOCK ${guard.accountId} IRREVERSIBLY`) {
    throw new Error("explicit_irreversible_lock_confirmation_required");
  }
  if (new Set([guard.accountId, ownerId, agentId]).size !== 3) {
    throw new Error("separate_accounts_required");
  }
  const config = await guard.view("get_config");
  if (config.owner_id !== ownerId || config.agent_id !== agentId) {
    throw new Error("initialized_config_mismatch");
  }
  const list = await provider.viewAccessKeys(guard.accountId, { finality: "final" });
  if (!Array.isArray(list.keys)) throw new Error("invalid_access_key_list");
  const signer = signingKey.getPublicKey().toString();
  if (!list.keys.some(k => k.public_key === signer && k.access_key.permission === "FullAccess")) {
    throw new Error("guard_full_access_signer_required");
  }
  // Include ALL permissions; keep the signing key last. One atomic action batch.
  // Never silently truncate to a protocol action limit: failure leaves keys intact.
  const batch = guard.batch(guard);
  for (const key of list.keys.filter(k => k.public_key !== signer)) batch.deleteKey(key.public_key);
  batch.deleteKey(signer);
  const result = await batch.transact(signingKey);
  if (result.failed) throw new Error("lock_transaction_failed");
  // Transaction execution can precede RPC finality. Do not inspect an older
  // finalized snapshot and mistake it for the deletion's resulting state.
  const blocks = await Promise.all(result.result.receipts_outcome.map(
    receipt => provider.block({ blockId: receipt.block_hash })));
  const executionHeight = Math.max(...blocks.map(block => block.header.height));
  let after;
  for (let attempt = 0; attempt < 60; attempt++) {
    after = await provider.viewAccessKeys(guard.accountId, { finality: "final" });
    if (after.block_height >= executionHeight) break;
    await setTimeout(500);
  }
  if (!(after?.block_height >= executionHeight)) throw new Error("lock_finality_timeout_stop_and_investigate");
  if (!Array.isArray(after.keys) || after.keys.length !== 0) {
    throw new Error("lock_not_verified_stop_and_investigate");
  }
  return result;
}
