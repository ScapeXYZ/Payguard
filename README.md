# PayGuard

An on-chain payment policy guard for AI agents on NEAR. **The funded guard
contract is authoritative.** It owns NEP-141 tokens and initiates `ft_transfer`
only after checking the configured agent, approved recipients, per-payment cap,
and persistent per-token UTC-day spending. The TypeScript guard in `src/` is a
reference/compatibility layer only; its in-memory decisions cannot authorize
on-chain transfers. Its original API and limitations are in
[the reference guide](docs/typescript-reference.md).

## Build and test locally

Requires Node 22.6+ and npm on Linux x86_64 (the SDK downloads its compiler tools;
near-workspaces downloads NEAR Sandbox). No Rust installation is required.

```sh
npm install --ignore-scripts
npm run setup:tools       # Download SDK compiler tools and local NEAR Sandbox
npm test                 # Original 21 regression tests + deterministic policy tests
npm run check           # TypeScript checks
npm run build           # build/guard.wasm
npm run test:sandbox    # Builds guard and local mock FT; runs local blockchain tests
npm run test:all        # All of the above
```

SDK 2 publishes a pnpm-only preinstall. To retain this repository's npm workflow,
install packages with lifecycle scripts disabled and run only the SDK and Sandbox
tool installers explicitly through `setup:tools`. Dependencies are pinned in the
lockfile; subsequent installations can use `npm ci --ignore-scripts`.

`test:sandbox` explicitly selects Sandbox, never a public network. It funds the
guard with fake six-decimal USDC, deletes all three guard keys through a signed
account-action batch, verifies the empty RPC key list, and sends three
separate signed payments using the agent's sole restricted key, each of
`"40000000"` units against `"100000000"` daily:
the first two transfer tokens; the third rejects with `daily_limit`. It also
tests caller/key restrictions, policy authentication, bad inputs, failed
cross-contract transfers, and rollover. `tests/mock-ft.ts` is a minimal local
transfer fixture, **not a production token implementation**.
Deterministic tests execute the same policy functions as the contract using
controlled host storage/time; they do not substitute for WASM/Sandbox validation.
Sandbox fixtures configure long epochs in local genesis before the node starts
so day-long `fastForward` jumps avoid expensive epoch transitions. Tests observe
actual finalized block timestamps; neither contract state nor the 24-hour delay
is patched. Each scenario has a ten-minute timeout. Exact timestamp boundaries
are also covered by the fast deterministic tests.

## Contract API and accounting

- `init({owner_id, agent_id, guardian_id, exit_id})`: once only; predecessor must equal owner. Owner,
  agent, guardian, guard and exit must be separate accounts. Create/deploy/initialize together
  as described below to prevent an initialization takeover.
- `set_policy({token_id, max_per_payment, daily_limit, recipients})`: owner-only,
  zero deposit. Submits a full token policy under the timelock lifecycle below.
  Sets both positive u128 limits together; cap cannot exceed daily
  limit. At most 100 recipients. Empty recipients pauses the token. Existing
  spending is never reset, even after reconfiguration or lowering limits.
  Changes govern new authorizations; they cannot cancel previously scheduled transfers.
- `disable_policy({token_id})`: owner-only, zero deposit; immediately disables the
  token and cancels any pending proposal, preserving all spending.
- `cancel_policy()`: owner-or-guardian, zero deposit; clears the pending proposal.
- `activate_policy({proposal_id})`: permissionless, zero deposit; activates only
  the exact current proposal after its on-chain deadline, then clears it.
- `get_pending_policy()`: view returning `null` or
  `{proposal_id, token_id, policy, activate_after}`; IDs and nanosecond timestamps
  are decimal strings. `get_policy` returns only the active policy.
- `pay({request_id, token_id, recipient_id, amount})`: configured agent **predecessor** only,
  zero deposit, 60–100 Tgas prepaid (use 80 Tgas). Returns the transfer promise.
- Read-only `get_config`, `get_policy({token_id})`, and
  `get_spending({token_id, day?})`. Day is a decimal UTC epoch-day string;
  omitted day uses current block timestamp.

### Policy timelock lifecycle

The fixed delay is **24 hours** (`86400000000000` nanoseconds), measured from
NEAR's trusted block timestamp. No public method can configure or skip it.
Both initial token enablement and re-enablement require this delay. Submit
`set_policy`, inspect `get_pending_policy`, wait until `activate_after`, then
call `activate_policy` with that proposal's ID. Expiry alone does not activate it.
Any account may activate; it cannot supply a replacement policy or deadline.
The agent identity remains immutable; owner recovery and guardian succession follow the lifecycle below.

A full replacement is immediate only if both limits are no higher and every
recipient was already approved. Duplicates/casing are normalized before comparison.
Missing fields reject; partial patches are unsupported. Empty recipients pause
payments immediately when limits do not increase. For mixed changes, the active
policy immediately takes the minimum of each old/new cap and the intersection of
recipients; the full requested policy waits. Any increase, added recipient, or
new/disabled token is conservatively delayed, even if its recipient set is empty.

Only one proposal can be pending across all tokens. Another loosening/mixed update
rejects atomically with `pending_policy_exists`; cancel first to propose anew,
which starts a fresh full delay and new monotonically increasing ID. An immediate
non-loosening update (including an identical policy) or token disable cancels any
pending proposal globally. This prevents an older queued change from undoing
later tightening. Activation with an old ID fails, even if a new proposal exists.
Cancellation never rolls back the tightening portion of a mixed update.
No lifecycle operation changes current or historical spending or replay markers.
Changes affect new authorizations, not transfers already scheduled.

Amounts are canonical positive decimal **strings in smallest units**, bounded by
u128; JSON numbers, decimals, exponent notation, signs and leading zeros reject.
There is no floating-point conversion or token-decimal lookup. For a token with
six decimals, 40 tokens is `"40000000"`. The owner must verify token decimals.

Token identifiers are actual NEP-141 contract account IDs, ASCII-lowercased and
validated consistently on every configuration, payment and view. Symbols such as
`USDC` have no alias mapping; they cannot select a configured USDC contract.
Whitespace and malformed separators reject. Recipient IDs are normalized the
same way. The guard cannot be its own token contract or payment recipient.

Storage keys are `policy:<canonical-token-id>` and
`spent:<canonical-token-id>:<UTC-epoch-day>`. Block timestamp nanoseconds divided
by `86400000000000` determines the day; the caller cannot supply time or totals.
Checks and reservation occur synchronously within one NEAR receipt. NEAR
serializes receipts against contract state, so separate transactions share the
same committed budget. Rejected guard calls do not consume budget. A panic in
the guard receipt rolls back that receipt, including its reservation.
Accounting uses the authorization day, not the later transfer-settlement day.

`request_id` is required: 1–64 ASCII letters, digits, underscores or hyphens,
case-sensitive and unique across this guard's lifetime. Persist a stable business
request ID before submission and reuse it for every retry. A persistent
`request:<request_id>` marker is committed with spending and promise creation.
Reuse rejects with `duplicate_request`, even with different payment arguments,
after policy changes, after a failed transfer, or on a later UTC day. A rejection
before reservation does not consume the ID. Fresh IDs represent new payments;
the contract cannot infer that different IDs describe the same business intent.

This is an on-chain API change: callers must now supply `request_id`. Existing
policy/spending storage remains readable, but legacy payments made without IDs
cannot be deduplicated retrospectively. The test helper creates fresh IDs for
distinct test payments; production retry logic must retain its original ID.

Ordinary `pay` schedules only `ft_transfer` on the configured token contract, with
the validated recipient/amount, 30 Tgas and 1 yoctoNEAR from the guard. It exposes
no raw-call, native withdrawal, spending reset, refund, or key-management method.
It accepts ordinary incoming `ft_transfer` deposits after token registration;
it does not implement `ft_on_transfer` / `ft_transfer_call` deposits.

## Asynchronous failures

Reservation and transfer settlement are **not atomic across contracts**. Once
the guard receipt commits, its reservation survives a later token receipt
failure (unregistered recipient, insufficient FT balance, token panic or gas
failure). Failed transfers leave tokens with the guard on a compliant NEP-141
contract. Failed attached deposits are handled by NEAR, not a PayGuard refund.

There is deliberately no callback that releases budget and no reconciliation
method that can reset it. Operators should inspect final receipt outcomes and
token balances when reconciling off-chain. A returned promise failure does not
mean the guard reservation rolled back. Same-ID retries reject without paying
again; a deliberately new ID reserves again. The agent can exhaust its
daily budget with failed transfers and must wait until a new UTC day (or a
trusted owner deliberately changes policy). This conservative accounting also
handles a missing/failed payment callback because payments have no callback.

## Testnet deployment outline and keys

These are setup instructions, not actions performed by the test suite. Use only
testnet accounts and valueless test tokens; no mainnet deployment is included.

1. Create separate owner, agent and independently controlled guardian accounts. Keep setup full-access credentials
   with the trusted operator until their on-chain retirement. In **one transaction action batch signed by owner**,
   receiver a new child guard account: create account, fund storage,
   add a temporary operator-only full-access key, deploy `build/guard.wasm`, and call `init`
   with `{owner_id, agent_id, guardian_id, exit_id}` and zero deposit. The Sandbox fixture demonstrates
   this sequence. Do not deploy uninitialized code publicly: an attacker could
   claim it by naming themselves owner. A separate owner cannot deploy arbitrary
   code onto an existing account; the creation batch establishes this authority.
2. Owner calls `set_policy` with verified testnet token contract IDs, decimal
   integer limits and approved account IDs. Inspect the pending proposal, wait
   the full 24 hours, activate its ID, and verify the active policy. Register guard and recipient accounts
   via the token's `storage_deposit` using trusted funds. Transfer test tokens to
   guard via `ft_transfer`. Fund guard with enough test NEAR for code/storage and
   outgoing 1 yoctoNEAR deposits. The agent account holds gas funds only.
3. Using agent's operator-held full-access key, install a fresh **function-call
   access key** whose receiver is exactly the guard account, method allowlist is
   exactly `["pay"]`, and allowance is finite (for example
   `"1000000000000000000000000"` yoctoNEAR = 1 NEAR of gas fees). Give only this
   restricted private key to the AI. Never put private keys in this repository.
   The Sandbox fixture demonstrates installation with
   `transactions.functionCallAccessKey(guard.accountId, ["pay"], allowance)`.
4. Inspect the installed key using RPC `view_access_key`. Verify receiver,
   `["pay"]`, and finite remaining allowance. Empty method lists permit **every**
   method; omitted/unlimited allowance is inappropriate. Sign agent transactions
   with zero deposit and 80 Tgas. The key cannot transfer native NEAR, attach
   deposits, deploy code, add keys, call token contracts, or call owner methods.
   After verifying it, retire every other agent key with agent-signed `DeleteKey`
   actions, leaving exactly this function-call key. This also removes direct agent
   key rotation/recovery: replace the deployment if the key is lost or exhausted.
5. Complete the verification and **irreversible guard lock** in
   [the exact key-management runbook](docs/key-management.md). Enumerate every
   on-chain guard key and delete all of them, including function-call keys and
   the signing full-access key, using guard-signed account actions. Confirm the
   finalized RPC key list is empty before treating this deployment as locked.
   Any real-network deletion requires separate explicit operator confirmation;
   the repository tests perform deletion only on local Sandbox accounts.

Function-call allowance limits cumulative gas fees, **not token spending**, and
does not encode a per-call gas cap. PayGuard additionally enforces 60–100 Tgas
for accepted `pay` calls. Rejected calls can still burn gas up to protocol limits;
the finite allowance bounds that exposure. The configured agent predecessor
check protects the contract even when other accounts call `pay` with their own
full-access keys. No reliance is placed on `signer_account_id` for authorization.
See [NEAR access keys](https://near.github.io/nearcore/DataStructures/AccessKey.html)
and [asynchronous cross-contract calls](https://docs.near.org/smart-contracts/anatomy/crosscontract).

## Security boundaries and limitations

An owner compromise can immediately pause/restrict payments or cancel proposals
(denial of service). It can loosen policy only after the 24-hour delay; monitoring
and an owner or guardian cancellation response are required during that
window. A separately configured guardian can veto proposals and initiate delayed owner recovery; there is no automatic veto. An
attacker retaining owner authority can re-propose and eventually activate malicious
changes, including malicious tokens/recipients. The delay does not protect funds
after that deadline, recover a compromised key, or stop payments already allowed
by the active policy. Before locking, guard-account full-access
key holders can replace code or bypass the guard; after the required zero-key
lock, this contract has no code upgrade, key recovery, or state reset path.
The agent must never receive setup full-access keys or control another funded
execution path. Only tokens held by the guard are covered.
No native NEAR payments, swaps, arbitrary contract calls, dynamic agent rotation,
automated refunds, or storage cleanup are implemented. Replacing the deployment
or using another funded guard starts a different authorization scope.

Approved token contracts must actually implement trustworthy NEP-141 semantics;
an owner can configure malicious or upgradeable token code that lies about
transfers. Syntax validation does not verify token code or economic value.
Recipients may forward funds after receiving them. Daily means UTC calendar day,
not rolling 24 hours; spending near midnight can span two daily caps. Historical
ledger storage grows with active tokens/days and accepted request IDs and needs
operator-funded storage. Request markers are never pruned, to preserve replay protection.
Gas budgets must be validated for the chosen token contract. This hackathon
implementation is unaudited; local tests do not prove production security.

The dependency audit snapshot in [docs/dependency-audit.json](docs/dependency-audit.json)
reports 0 critical, 12 high, 3 moderate and 13 low affected dependency entries.
`tar` is overridden to patched version 7.5.22; its extraction API was checked
against the Sandbox installer's usage. Remaining root advisories involve brace
pattern parsing, URI decoding and legacy elliptic crypto in development tooling.
The approved SDK/test stack has no automatic upgrade that resolves all of them.
Build inputs, downloaded compiler/Sandbox binaries and operator signing tooling
remain trust boundaries; these findings require review before production use.
Recheck with `npm audit`; it currently exits nonzero for the remaining findings.

See [the focused security review](docs/security-review.md) for severity-ranked
findings, all twelve high-severity dependency entries and their reachability.


## Guardian and owner recovery lifecycle

New deployments require `guardian_id` and `exit_id` in `init` and return both in `get_config`.
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
view adds `owner_proposed` (boolean). Owner proposals take priority over competing proposals: a guardian
cannot overwrite one (`owner_guardian_change_pending`), and recovery proposals
cannot erase one. The owner can propose during pending recovery. Guardian-initiated
changes remain blocked during recovery and are cleared when recovery starts.
Current-guardian-only `cancel_guardian_change()` authenticates through NEAR
`predecessor_account_id` and requires zero attached deposit. It immediately clears
any pending guardian replacement, including owner proposals, even after maturity.
Activation then fails with `no_pending_identity`, including after the original
deadline. Cancellation changes no active identity, policy, spending, replay marker,
pending owner recovery or recovery cooldown. With no pending change it is a no-op.
The owner or current guardian can propose again under the existing rules; every
fresh proposal has a new ID and a fresh full 24-hour delay.

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
responds. It can also veto legitimate owner attempts to replace it, potentially
indefinitely. This change does not solve compromised-guardian recovery. It cannot
repeatedly propose owner recovery during the owner-veto cooldown. If recovery activates before
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

## Emergency cold exit (PR #10)

New deployments use `init({owner_id, agent_id, guardian_id, exit_id})` and expose
all four IDs through `get_config()`. `exit_id` must already be a canonical lowercase
NEAR account ID, separate from guard, owner, agent and guardian. It is permanent:
there is no setter, migration or upgrade method. Recovery and guardian rotation
cannot change it or adopt it as a replacement identity.

Current owner or current guardian can call `emergency_sweep({token_id})`, with
zero deposit and 180–250 Tgas (recommended 200 Tgas). Authentication uses
`predecessor_account_id`. No destination or amount is accepted; extra JSON fields
cannot override the stored exit. Policy caps, daily limits, allowlists, disabled
policies, pending recovery and guardian replacement do not restrict this exit.
Spending and payment request records remain intact. Former identities cannot
initiate sweeps after rotation; already authorized receipts can still complete.

This sweeps **one NEP-141 token contract per call**, including tokens with no
payment policy. Operators discover token contract IDs from funding records or an
external indexer; there is no on-chain enumeration of every asset held by a NEAR
account. The guard queries that token's `ft_balance_of({account_id: guard})` with
30 Tgas, then transfers the entire reported u128 balance to `exit_id` via
`ft_transfer` (30 Tgas, exactly 1 yoctoNEAR from guard). It does not sweep native
NEAR, NFTs, locked balances, or funds arriving after the balance snapshot.
Register **both guard and exit on each token**, using that token's
`storage_deposit`, before funding. The sweep does not auto-register or redirect:
a compliant token rejects an unregistered exit safely, leaving tokens in guard.
This follows [NEP-141](https://github.com/near/NEPs/blob/master/neps/nep-0141.md)
and [NEP-145](https://github.com/near/NEPs/blob/master/neps/nep-0145.md).

The returned promise resolves to `transferred`, `zero_balance`,
`balance_query_failed`, or `transfer_failed`. The last two are failure statuses,
**even when the outer transaction succeeds**: inspect the returned value and
final token balances. Zero balance makes no transfer. Failed queries (including
malformed/non-u128 responses) and failed transfers release the per-token lock,
allowing a fresh authorized attempt. Each attempt has a persistent monotonic ID;
private `on_sweep_balance` and `on_sweep_transfer` callbacks check the active ID.
Concurrent same-token sweeps reject with `sweep_pending`; different tokens are
independent. New same-token payments also reject while locked. Previously queued
payments can race the snapshot and cause a transfer failure; retry after their
settlement. New deposits can require another sweep. Repeating a completed sweep
queries the current balance rather than replaying an old amount.

Callbacks reserve 120 Tgas for balance resolution and 30 Tgas for settlement.
Guard needs native NEAR for storage and outgoing deposits. A callback panic,
resource exhaustion or protocol failure can leave its token lock stuck; there is
intentionally no unsafe timeout unlock or administrative reset. Such a failure
may permanently prevent that token's payments and sweeps on a keyless guard.
Token code and these fixed gas budgets remain trust/availability boundaries;
a malicious or upgraded token can lie about balances or success, stall, or reject.
A compromised owner **or guardian** can force immediate evacuation to the cold
account, so cold custody must be independent, usable and monitored. Loss or
compromise of that immutable destination cannot be repaired by rotation.
