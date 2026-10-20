# Deployment and irreversible key lock

The owner, agent, guardian, and guard are four distinct accounts. The owner administers
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
   network and RPC explicitly; independently record guard, owner, agent, guardian, token,
   recipients, code hash, limits, and token decimals. Keep signing material in
   trusted signing tooling, outside this repository and logs.
2. Create separate owner, agent and independently controlled guardian accounts. In one **owner-signed transaction**
   to a new guard child, execute `CreateAccount`, `Transfer` for storage/deposits,
   `AddKey` for a temporary operator full-access public key, `DeployContract`,
   then `FunctionCall("init", {owner_id, agent_id, guardian_id}, 30 Tgas, 0)`.
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
`get_pending_policy` and use owner-or-guardian `cancel_policy` to cancel unwanted
proposals during the response window. A persistent owner compromise can cause
denial of service or eventually activate malicious policy; an independent guardian veto is available. The owner cannot replace code, rotate the immutable agent,
clear spending/request markers, or recover arbitrary assets. Keyless accounts
with self-upgrade/recovery code would have different guarantees; verify the code.

Maintain native storage and 1-yocto transfer-deposit funding through incoming
transfers. Restricted agent keys have finite gas allowance; after removing its
full-access keys there is no replenishment/rotation path for that allowance.
Plan a fresh deployment before exhaustion. Loss of owner authority requires guardian-initiated recovery for policy administration. Loss/expiry of agent authority prevents payments. A bug
cannot be patched in place: deploy and initialize a new guard, re-register and
fund it, and update clients. Existing assets can leave only through the old
contract's existing authorized payment path and policy limits; migration or
recovery is not guaranteed. This tradeoff requires explicit operator acceptance.


## Guardian and owner recovery lifecycle

New deployments require `guardian_id` in `init` and return it in `get_config`.
Owner, agent, guardian and guard must all be distinct. Configuration is persistent
SDK-managed on-chain state; authorization always uses NEAR predecessor, never
signer or a supplied identity. This initialization API is incompatible with older
clients. Existing locked deployments cannot upgrade to this code.

`cancel_policy()` accepts the current owner or guardian, immediately invalidates
pending loosening and leaves active policy, daily spending and request markers
untouched. Previously applied mixed-change tightening remains active.

Guardian-only `propose_owner_recovery({owner_id})` stores a unique proposal ID,
replacement account and `activate_after` in nanoseconds. Inspect with
`get_pending_owner_recovery()`. Creation clears pending policy and guardian-initiated guardian changes;
owner-proposed guardian changes survive.
Recovery freezes all policy loosening, including enablement, and policy activation;
owner tightening, disabling and cancellation remain available. Existing bounded
agent payments continue. Owner-only `cancel_owner_recovery()` uses the current
NEAR `predecessor_account_id`, requires zero deposit, and immediately clears the
pending recovery without a timelock or guardian approval, even after its deadline
if activation has not executed. Guardian, agent and third parties cannot cancel.
Canceled activation rejects with `no_pending_identity`, including after the former
deadline. Cancellation releases the recovery freeze but does not restore proposals
cleared when recovery began. It changes no active identity, policy, spending or
replay marker. A successful veto persists `recovery_cooldown_until` at trusted block time plus
24 hours (`86400000000000` ns). Recovery proposals before that timestamp fail
with exact error `recovery_cooldown`, including proposals from the current guardian.
`get_recovery_cooldown()` returns the decimal nanosecond deadline ("0" initially).
Calling cancellation without pending recovery is a no-op and does not extend it.
Cooldown survives identity changes and does not block safe administration,
guardian replacement, or activation. At expiry a new recovery still waits a fresh
full 24 hours.
Every new or replacement proposal gets a new ID and a fresh full 24-hour delay;
cancellation never resets the sequence or preserves a reusable deadline.
Neither proposing nor activating recovery requires an owner signature, so a truly
lost owner key does not block recovery.
Permissionless `activate_owner_recovery({proposal_id})` requires the current ID
and trusted block timestamp at least 24 hours after proposal. Only then does the
new owner acquire policy administration and the old owner lose it. The new owner
still waits the ordinary policy timelock for loosening.

Current-owner-or-guardian `propose_guardian_change({guardian_id})`,
`get_pending_guardian_change()` and permissionless
`activate_guardian_change({proposal_id})` provide succession with a fixed full
24-hour delay. Each superseding proposal gets a fresh ID and deadline. The pending
view adds `owner_proposed` (boolean). Owner proposals take priority: a guardian
cannot overwrite one (`owner_guardian_change_pending`), and recovery proposals
cannot erase one. The owner can propose during pending recovery. Guardian-initiated
changes remain blocked during recovery and are cleared when recovery starts.
Activation of a valid guardian change is allowed despite pending recovery and
clears that recovery atomically. The displaced guardian immediately loses all
guardian permissions; its queued recovery can never activate afterward.
Conversely, recovery activated first clears any pending guardian change, preventing
the former owner's queued administration from surviving loss of ownership.
There is no automatic priority between matured activations: receipt order decides.
A responsive owner should veto recovery before waiting for replacement maturity.
Replacement identities must differ from current owner, guardian, agent and guard.
All mutation calls require zero deposit. Authentication uses current NEAR
predecessor, never signer; no caller-supplied time or delay is accepted.

Use separately controlled owner and guardian accounts with independent monitoring.
A compromised guardian can veto policy and freeze loosening until the owner
responds, but cannot repeatedly propose recovery during the veto cooldown or
prevent an owner-proposed replacement from maturing. If recovery activates before
the owner responds, the old owner loses authority. A compromised owner can veto
legitimate recovery and queue guardian removal; this design cannot distinguish
key theft from legitimate control. Lost guardian keys no longer block owner-led
replacement, but loss of both owner and guardian authority remains unrecoverable.
Account validation does not prove replacement existence or usable key custody.
Monitor identity and policy proposals; timelocks do not trigger alerts.

Recovery preserves the zero-key guard architecture, immutable payment agent,
policy limits, UTC spending history and lifetime request markers. It cannot cancel
already scheduled transfers, repair token code, upgrade WASM, recover arbitrary
assets, restore guard access keys or replenish the restricted agent's allowance.
A compromised current owner can veto guardian recovery repeatedly; this veto
protects a responsive legitimate owner but cannot distinguish compromise from
legitimate control. The old owner can also tighten/disable during the recovery window. Ordinary allowed payments remain exposed during that window.
