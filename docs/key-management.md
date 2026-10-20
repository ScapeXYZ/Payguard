# Deployment and irreversible key lock

The owner, agent, and guard are three distinct accounts. The owner administers
`set_policy` by signing transactions on the **owner account**, with guard as
receiver. Incoming contract calls need no guard access key. The agent similarly
signs on its own account. Parent/subaccount naming grants no continuing authority
to deploy, transfer, or add keys to an existing child.

The guard cannot enumerate account keys from WASM. Use RPC `query` with
`request_type: "view_access_key_list"`, `account_id: guardId`, and
`finality: "final"`. Enumerating local credential files is insufficient.
[NEAR's account key commands](https://github.com/near/near-cli-rs/blob/main/docs/GUIDE.en.md)
provide listing and signed deletion; the repository's explicit SDK procedure is
[`scripts/lock-guard.mjs`](../scripts/lock-guard.mjs). It has no executable CLI
or credential loader and tests use only ephemeral Sandbox accounts.

## Ordered operator sequence

1. Build and review the exact WASM (`npm run test:all`). Select the intended
   network and RPC explicitly; independently record guard, owner, agent, token,
   recipients, code hash, limits, and token decimals. Keep signing material in
   trusted signing tooling, outside this repository and logs.
2. Create separate owner and agent accounts. In one **owner-signed transaction**
   to a new guard child, execute `CreateAccount`, `Transfer` for storage/deposits,
   `AddKey` for a temporary operator full-access public key, `DeployContract`,
   then `FunctionCall("init", {owner_id, agent_id}, 30 Tgas, 0)`.
   Never expose a deployed but uninitialized guard.
3. Verify finalized code hash and `get_config`. Owner signs `set_policy` to guard
   with zero deposit. Inspect `get_pending_policy`; initial token enablement waits
   24 hours of block time. Call `activate_policy({proposal_id})` after its deadline
   (permissionless, zero deposit), then verify `get_policy` and `get_spending`.
   There is no setup exemption. Register guard and
   recipients on the intended token; fund guard with the intended test tokens
   and sufficient native storage/deposit balance. Test owner authorization and
   agent payments before making the lock irreversible.
4. Agent signs `AddKey` for a function-call key with receiver exactly guard,
   methods exactly `["pay"]`, finite allowance, and zero-deposit calls. Verify
   this permission through RPC. Agent signs `DeleteKey` for every other agent
   key, with its full-access signing key last. Query the agent list and require
   exactly the one restricted key. Keep the owner account and its keys intact.
5. Stop concurrent deployment/key administration. Query the **entire finalized
   guard key list**, review all public keys/permissions, code hash, initialized
   state, and account IDs. A full-access key on the **guard** must still be
   available; the owner key alone cannot delete an existing guard's keys.
6. Before **any real-network key deletion** (including step 4), require the
   operator's explicit confirmation of network, affected account, complete public
   key deletion list, and irreversible consequences. Do not infer consent from
   this document or a deployment request. No real-network deletion is authorized
   by the current task. Never print or pass private keys in command arguments.
7. With the guard full-access signer, call the reviewed procedure:

   ```js
   await lockGuard({
     guard, provider, signingKey: trustedInMemoryGuardSigner,
     ownerId, agentId,
     confirmation: `LOCK ${guard.accountId} IRREVERSIBLY`,
   });
   ```

   `guard` is a near-workspaces account; `provider` is its explicitly selected
   network's provider. The signer is supplied by trusted signing tooling, never
   embedded in code. The procedure verifies initialized identities and full-access
   authority, enumerates finalized keys, and constructs one guard-to-itself
   transaction with `DeleteKey` for **every** enumerated public key, regardless
   of permission. The signing key is deleted last. Signing and protocol validation
   occur while that authority exists. No contract method or Sandbox patch performs
   deletion. An oversized batch must fail; never truncate it or delete the final
   authority while unreviewed keys remain. For unusually large lists, separately
   review staged batches retaining the signer, re-enumerating before each batch.
8. Wait for successful receipt outcomes. The procedure waits until the finalized
   key query reaches at least the deletion receipt block height (execution can
   precede RPC finality). Query finalized
   `view_access_key_list` again and require `keys: []`, not merely zero full-access
   keys. Save public transaction/block hashes and verification results. If RPC
   fails or any keys remain, stop and investigate; do not claim a successful lock
   or blindly resubmit an ambiguous transaction. Re-query first. Concurrent key
   changes can make the snapshot stale; final verification is mandatory.
9. Verify code/config/policy again, owner-signed policy administration, rejection
   of unauthorized policy changes, and restricted-agent payments after locking.
   The Sandbox suite proves two separate 40-unit payments succeed and the third
   fails `daily_limit` under a 100-unit limit, using actual FT balances. It starts
   with two full-access guard keys and one function-call guard key, then asserts
   the real RPC list is empty and the deleted signer cannot transfer.

## Recovery and upgrade limitations

For this exact deployed code, the guard lock is irreversible: there is no method
that schedules `AddKey`, `DeployContract`, `DeleteAccount`, native withdrawals, or
state resets. Keeping a deleted private key or owning the parent account cannot
restore authority. The owner can still adjust policy, including pausing via an
empty recipient list or `disable_policy`. Loosening waits a fixed 24 hours;
any immediate tightening invalidates pending proposals globally. Monitor
`get_pending_policy` and use owner-only `cancel_policy` to cancel unwanted
proposals during the response window. A persistent owner compromise can cause
denial of service or eventually activate malicious policy; no independent veto
exists. The owner cannot replace code, rotate the immutable owner/agent,
clear spending/request markers, or recover arbitrary assets. Keyless accounts
with self-upgrade/recovery code would have different guarantees; verify the code.

Maintain native storage and 1-yocto transfer-deposit funding through incoming
transfers. Restricted agent keys have finite gas allowance; after removing its
full-access keys there is no replenishment/rotation path for that allowance.
Plan a fresh deployment before exhaustion. Loss of owner authority prevents
policy administration. Loss/expiry of agent authority prevents payments. A bug
cannot be patched in place: deploy and initialize a new guard, re-register and
fund it, and update clients. Existing assets can leave only through the old
contract's existing authorized payment path and policy limits; migration or
recovery is not guaranteed. This tradeoff requires explicit operator acceptance.
