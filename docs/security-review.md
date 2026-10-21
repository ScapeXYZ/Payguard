# Focused PayGuard security review

Review date: 2026-10-20. Scope: `contract/guard.ts`, `contract/policy.ts`, SDK-generated
entrypoints and bundle, deterministic/Sandbox tests, pinned package graph and
`docs/dependency-audit.json`. This is a focused code review, not a formal audit or
an assurance about native QuickJS/compiler/NEAR binaries.

## Findings by severity

### High — unresolved build dependency denial of service

The snapshot's **12 high entries are 12 affected packages, not 12 independent
advisories**. All trace to `braces` GHSA-vfj7-8cjw-p6xm / CVE-2026-93687. The
upstream advisory lists versions through 3.0.3 with no patched version:
https://github.com/advisories/GHSA-vfj7-8cjw-p6xm .

The SDK build calls `validateContract(source)` in
`node_modules/near-sdk-js/lib/cli/utils.js`, then
`Project.addSourceFilesAtPaths(source)` in `ts-morph`,
`RealFileSystemHost.globSync` in `@ts-morph/common`, `fast-glob.sync`,
`micromatch` brace expansion and the recursive brace AST walkers. This is an
actual build-process attack surface, irrespective of `devDependencies` placement.

A bounded local reproduction used `new Project().addSourceFilesAtPaths(pattern)`
with `pattern = '{'.repeat(4500) + 'a,b' + '}'.repeat(4500)` (9,003 characters).
It raised `RangeError: Maximum call stack size exceeded`. A longer 20,001-character
pattern was instead rejected by fast-glob's 10,000-character cap; the shorter
reproduction demonstrates that this cap does not eliminate the vulnerability.
No large expansion, external target or production service was used.

Normal repository builds pass fixed literal paths `contract/guard.ts` and
`tests/mock-ft.ts`; no payment argument becomes a build glob. Therefore remote
contract callers cannot trigger this path. It becomes exploitable if a build
service accepts attacker-controlled source/glob arguments or ESLint project globs.
Untrusted repository build execution also has broader code-execution risks.
Keep build workers isolated, without signing/deployment credentials; apply resource
limits and never interpolate payment inputs into SDK CLI arguments. No dependency
versions were upgraded during this review.

| High entry (installed version) | Package role / vulnerable-function classification | Build reachability | Deployed WASM reachability |
| --- | --- | --- | --- |
| `braces` 3.0.3 | Build-only | Actual recursive expansion path; bounded reproduction confirmed | None in generated bundle |
| `micromatch` 4.0.8 | Build-only | Loaded by fast-glob; delegates brace expansion | None |
| `fast-glob` 3.3.3 | Build-only | Called by SDK validator through ts-morph | None |
| `@ts-morph/common` 0.17.0 | Build-only | Its real-filesystem glob adapter calls fast-glob | None |
| `ts-morph` 16.0.0 | Build-only | SDK validator calls its project glob API | None |
| `near-sdk-js` 2.0.0 | Runtime **and** build package; high advisory path is build-only | CLI validator reaches the chain above | Runtime API code is present; CLI/glob/brace functionality is absent |
| `globby` 11.1.0 | Build-only, dormant in current commands | ESLint parser's project-glob resolution can call fast-glob; not loaded in traced normal build | None |
| `@typescript-eslint/typescript-estree` 5.62.0 | Build-only, dormant | `parseSettings/resolveProjectList.js` calls globby for globbed parser project settings | None |
| `@typescript-eslint/parser` 5.62.0 | Build-only, dormant | ESLint parsing can reach typescript-estree; no repository lint command invokes it | None |
| `@typescript-eslint/utils` 5.62.0 | Build-only, dormant | Propagated through typescript-estree; no current build/test call observed | None |
| `@typescript-eslint/type-utils` 5.62.0 | Build-only, dormant | Propagated through utils/typescript-estree in lint/type services | None |
| `@typescript-eslint/eslint-plugin` 5.62.0 | Build-only, dormant | Propagated lint/parser chain; not invoked by current build/typecheck/test commands | None |

None of these high advisory paths is test-runtime-only. Sandbox commands **build**
two contracts before testing, so their build phase shares the exposure.
`near-workspaces` itself is low severity in this post-tar-fix snapshot, not high.

Evidence: inspection of pinned installed source, CJS module-load tracing during
`npm run build` (showed ts-morph/common, fast-glob, micromatch and braces), and
`build/guard.js.map` source inventory. The generated bundle contains exactly six
SDK runtime source modules: `utils.js`, `types/public_key.js`, `types/vm_types.js`,
`api.js`, `near-bindgen.js`, and `promise.js`, plus lodash and contract code. None
of the other eleven high packages or SDK CLI code is in the QJSC input bundle.
The SDK's presence in WASM must not be confused with its build-only advisory path.
This evidence addresses the listed advisories, not every possible SDK/VM flaw.

### Medium — duplicate business-request retry could pay twice (fixed)

Previously two separately signed calls with identical recipient, token and amount
both paid if budget remained. NEAR nonce protection stops replaying an identical
signed transaction; it does not stop a client creating another transaction after
an ambiguous response. This was documented behavior, but unsafe for payment retry
workflows. It did not bypass daily limits.

`pay` now requires a stable `request_id` and writes a persistent marker in the
same receipt as spending and transfer-promise creation. Reuse rejects before a
new reservation or transfer, including altered payloads, later UTC days, policy
changes and downstream transfer failures. A guard-receipt failure rolls back both
writes. No callback or owner method clears markers. This is an API compatibility
change: clients must persist and reuse IDs, not create a new one for each retry.
No retrospective protection is possible for old payments that had no ID.

Different IDs can still cause identical payments within policy; business-intent
identity is a client responsibility. A marker is not proof of successful settlement:
inspect final receipt outcomes and token balances. Markers increase persistent
storage per accepted request; storage needs funding, and pruning would weaken
lifetime replay protection. The restricted agent can consume budget/storage with
otherwise authorized requests, bounded operationally by its gas allowance.

### Low — final-newline acceptance in canonical-input regexes (fixed)

JavaScript `$` may match before a final newline. Previously `accountId` accepted
`alice.near\n`, and amount validation accepted `40\n` (BigInt then stripped the
whitespace). Day-key and newly introduced request-ID checks would have the same
pitfall. No spending-cap or owner-authorization bypass was found, but invalid IDs
could be persisted or passed to downstream token code, and input rules were not
being enforced as documented. Checks now compare the entire regex match with the
input. Unit and Sandbox regressions reject final-newline variants.

### Accepted availability/operational boundaries

Failed asynchronous `ft_transfer` calls keep their budget reservation **and**
request marker. This prevents unsafe budget reopening/retry double payment but
lets the configured agent exhaust its own daily budget with failed transfers.
Ordinary payments have no refund/reconciliation or status callback. A failed later receipt does not roll back the guard's earlier
committed receipt. NEAR deposit refunds are not budget refunds.

An uninitialized public deployment can be claimed by a caller naming itself
owner. The supported lifecycle creates, deploys and initializes a new guard in
one owner-signed action batch, tested in Sandbox; never split that batch. Owner
configuration remains trusted. Guard full-access signing keys are trusted only
during setup; the required post-initialization lock removes every guard key.
Approved token code can lie or be upgraded; syntax validation is not token-code
verification. Recipients can forward tokens after receipt. Historical spending
and request markers require storage; the contract has no cleanup method; emergency FT exit is described below. UTC calendar days allow spending on both sides of midnight,
not a rolling 24-hour cap.
Policy changes cannot cancel already scheduled promises. Reservations belong to
their authorization day; transfers authorized before midnight may settle after
midnight, so the cap is not a bound on total settlement within a UTC calendar day.

## Timelocked policy changes

Owner compromise previously allowed immediate cap/recipient expansion. Token
policies now use a fixed 24-hour block-timestamp delay for any loosening, including
first enablement and re-enablement. Agent ID remains immutable; owner recovery follows the lifecycle below. The owner cannot modify the delay or supply time.

Validation precedes storage writes. A replacement tightens only when both caps
are nonincreasing and recipients are a subset after canonicalization. Mixed
updates immediately apply minimum caps and recipient intersection, then queue the
full validated target. Missing fields reject rather than imply defaults. Empty
recipient sets do not exempt cap increases or new tokens from delay.

Persistent `pending_policy` contains the exact target, canonical token, unique
monotonic proposal ID and earliest activation timestamp. `policy_sequence` retains
IDs across cancellation/activation. There is one pending proposal globally;
loosening/mixed overwrites reject before writes. Immediate non-loosening updates
(including no-ops) and `disable_policy` invalidate the global pending proposal.
Owner-or-guardian `cancel_policy` also clears it; mixed tightening remains active.
Permissionless `activate_policy({proposal_id})` checks the exact current ID and
trusted deadline before copying the stored target and clearing the proposal.
Thus neither stale activation nor disable/re-enable nor recipient substitution
can revive old authority. All new calls require zero attached deposit.
Spending and request-marker keys are never edited by these operations.

Policy timelocking provides a response window: an attacker can cause
immediate denial of service, repeatedly propose malicious policies, and have them
activated after expiry. Monitor proposals and respond using owner or guardian authority;
independent guardian veto and delayed owner rotation are now available. Existing allowed payments
and already scheduled transfers remain exposed. Full-access guard keys before
locking can replace code and bypass these protections. Malicious/upgraded token
code remains a separate trust boundary. See the README lifecycle and key runbook.

Deterministic tests cover exact expiry minus one nanosecond, expiry itself,
reload persistence, mixed changes, overwrites, stale IDs, empty recipients,
disabling/re-enabling, partial-input rejection and unchanged historical spending.
Cross-token tightening also cancels pending enablement; re-proposing uses a new
ID and restarts the full delay rather than inheriting the canceled deadline.
Sandbox fixtures set a long epoch length in genesis before starting the node to
reduce time-jump overhead; deployed state and the fixed delay are never patched.
Tests advance actual local blocks, observe finalized timestamps, reject
above-old-cap payments and owner/stranger early activation, then activate through
a stranger and verify actual FT balances using the restricted agent after expiry.

## Contract boundary checks

- **Owner / policy:** `set_policy` checks exact predecessor against the current
  persisted `owner_id`; it does not accept a replacement owner/agent/policy in
  `pay`. Only owner can propose caps/recipients; loosening waits 24 hours. Spending and request
  markers survive replacement, including lowering daily limits below prior spend.
  SDK initialization is required and reinitialization rejects.
- **Agent:** exact `predecessorAccountId`, never signer ID. A test-only relay is
  called with agent as signer, but its call to guard has token-contract predecessor
  and rejects. Full-access test callers cannot bypass contract authentication.
- **Keys:** Sandbox inspects the actual installed access key: receiver guard,
  methods exactly `["pay"]`, finite 1 NEAR allowance. It verifies protocol errors
  `ReceiverMismatch`, `MethodNameMismatch`, `DepositWithFunctionCall`, and
  `RequiresFullAccess`. The restricted signing options never receive an owner key;
  fixtures retire the agent setup key and delete all guard keys before payment
  scenarios, while the owner retains its own authority. Production
  key custody must still follow the documented setup; it cannot be proved by WASM.
- **Token / recipient:** ASCII canonical lowercase account IDs, length 2–64,
  valid nonconsecutive separators; no symbol aliases. Both policy limits must be
  present; unknown tokens and unapproved recipients reject. Policy/ledger keys
  cannot collide because identifiers exclude the storage-key separators.
- **Integer bounds:** positive canonical decimal strings, at most u128 max.
  BigInt comparison `units <= daily - spent` occurs before addition; successful
  `spent + units` is therefore bounded by the u128 daily limit. Lowered limits
  cause rejection rather than underflow. Numbers/decimals/whitespace reject.
- **UTC / persistence:** host block nanoseconds divided by fixed 86,400 seconds;
  no supplied clock/day/totals in `pay`. Storage keys include canonical token and
  UTC epoch day. Unit tests cover one nanosecond before/at midnight, token
  isolation, storage reload and u128 boundaries; Sandbox covers separate receipts
  and real local-chain day advancement.
- **Funds / promises:** contract owns the FT balance and returns only a configured
  token's `ft_transfer` promise, with approved receiver/amount, exactly 1 yoctoNEAR
  from guard, and 30 Tgas. Mock FT rejects any other deposit, verifies balance and
  registration, and actual recipient/guard balances are asserted. Guard uses
  zero-deposit call wrappers plus an explicit check, and accepts 60–100 Tgas
  prepaid. Full-access calls test deposit and gas checks independently of key ACLs.
  Scheduling/storage failure in the guard receipt rolls back its reservation;
  downstream failure does not. There is no claim of cross-contract atomic settlement.
- **Public surface:** compiled WASM exports only `init`, `set_policy`, `pay`,
  `get_config`, `get_policy`, `get_spending`, `get_pending_policy`,
  `activate_policy`, `cancel_policy`, `disable_policy`, `propose_owner_recovery`,
  `get_pending_owner_recovery`, `cancel_owner_recovery`, `activate_owner_recovery`, `propose_guardian_change`,
  `get_pending_guardian_change`, `cancel_guardian_change`, `activate_guardian_change`, `get_recovery_cooldown`. The views do not write state or
  schedule calls. No arbitrary call or reset is exported; private sweep callbacks are described below.
  The agent key permits only `pay`; even a key configuration mistake would still
  face contract ACLs. The zero-key guard has no account-key escape or self-upgrade method.

## Guard account lock

The supported lifecycle ends with zero guard access keys. The operator procedure
in `scripts/lock-guard.mjs` enumerates the finalized on-chain list and submits
ordinary `DeleteKey` actions in a guard-signed batch, deleting its signing key
last. It never asks WASM to enumerate keys. Verification waits for a finalized
snapshot at or after the deletion receipt's block and requires an empty list.
A transaction response alone or removing local credentials is insufficient.

Sandbox starts with two full-access keys and one function-call key, deletes all
three without state patching, and queries the actual key list. It checks missing
confirmation leaves keys intact, owner keys remain unchanged, and the agent has
exactly its restricted `pay` key. The deleted guard signer is refused by the
SDK's on-chain key lookup. Owner policy changes and restricted-agent payments
run after locking, including the separate 40 + 40 + rejected 40 scenario.

The current contract exposes no upgrade or key installation path, so
this lock is irreversible. The owner retains policy administration and fixed-destination emergency exit authority. The
agent's removal of full-access authority also prevents key rotation and finite
allowance replenishment. See [the operational runbook](key-management.md) for
explicit real-network confirmation and migration/recovery limitations.

## Other dependency risks and compatibility

The unchanged audit snapshot reports 0 critical, 12 high, 3 moderate, 13 low
entries. Moderate URI-decoder DoS is reachable in the **build** sourcemap plugin:
SDK CLI installs `rollup-plugin-sourcemaps`, which reads sourceMappingURL data
through `source-map-resolve` / `decode-uri-component`. Untrusted source/dependency
map content can therefore affect builds, even though it is absent from WASM.
Low elliptic/secp256k1 findings affect client/test signing code if secp256k1 is
selected; current Sandbox keys explicitly use Ed25519. Changing signing algorithms
or using these packages in production changes exposure; package classification
alone is not a mitigation.

No major upgrades were introduced. `near-api-js` 7 migration changes client APIs
and would not automatically replace the 5.x copy required by near-workspaces 5;
ESLint/parser major upgrades have peer/API constraints and do not repair the
SDK's separate ts-morph brace path. Replacing SDK/validator code or maintaining a
reviewed upstream patch needs separate compatibility work. The existing tar
7.5.22 override remains unchanged. Native SDK compiler/Sandbox downloads are
outside npm's package-lock integrity coverage; build isolation and artifact
verification remain required operational work.

## Validation

`npm run test:all` passed on 2026-10-20: **57 tests** (21 original TypeScript
regressions, 29 deterministic policy regressions, 7 Sandbox scenarios), TypeScript
checks, both WASM builds and the exact eighteen-method export allowlist check.
Negative receipt failures are expected test inputs. The suite requires local
listening ports: the restricted runner returned `EPERM` and exhausted the port
search heap; the complete suite passed outside that restriction with default
Node heap settings. Owner-veto regressions cover unauthorized cancellation,
immediate cancellation before and after maturity, stale activation after the
former deadline, policy unfreezing, unchanged identities/policy/ledger/replay,
fresh full-delay recovery and loss of old-owner authority after unvetoed recovery.
The earlier source-map assertion confirmed exclusion of the eleven non-SDK high
packages and the SDK CLI path; it was not repeated for this owner-veto change.
The existing TypeScript guard and its 21 tests were not changed by this review.
PR #8 additionally covers exact cooldown boundaries and persistence, no-op vetoes,
activation during cooldown, full-delay replacement supersession, owner proposal
priority, recovery/replacement mutual invalidation, old guardian revocation and
new guardian permissions. Sandbox relays identity calls with owner/guardian as
signer through the mock FT and verifies predecessor-based rejection. The production
export allowlist includes `get_recovery_cooldown` and guardian-only `cancel_guardian_change`.
Guardian-change veto coverage verifies owner-proposed cancellation, rejection before
and after the original deadline, fresh full-delay proposals, retained current-guardian
authority, former-guardian rejection, zero deposit, and preservation of pending recovery,
cooldown, policy, spending and replay protection. Deterministic tests compare every
storage entry; Sandbox tests use real predecessor calls and reject a guardian-signed
relay whose predecessor is the mock FT.


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

## PR #10: emergency cold exit review (2026-10-21)

The initialization trust boundary now includes immutable `exit_id`. Validation
requires exact canonical lowercase syntax and separation from all four existing
accounts. Both proposal and activation identity checks also exclude exit, so
rotation cannot collapse custody roles. Only init writes exit; export checks
include no setter or upgrade path. SDK initialization remains once-only.

`emergency_sweep({token_id})` authenticates current owner/current guardian by
predecessor, requires zero deposit and 180–250 Tgas, and makes no policy lookup.
It queries `ft_balance_of` on one validated, non-self token and never takes a
caller-selected destination or amount. Balance parsing accepts only canonical
u128 strings (including zero). No spending or replay records are reset. Token
registration is enforced by the token's `ft_transfer`: failure is reported and
never redirects assets. No automatic storage spending is authorized.

The new private exported callbacks are `on_sweep_balance` and
`on_sweep_transfer`. They require self-predecessor and the active monotonic sweep
ID; external owner, guardian, token and signer relays cannot invoke them. A
per-token lock spans query through transfer completion, rejects concurrent sweeps
and new ordinary same-token payments, and never uses an unsafe timeout unlock.
Different token locks are independent. Successful zero-balance/query-failure/
transfer-failure resolution releases only that token lock; prior payment ledger,
request markers and policy/identity state are retained. Callback success carries
an explicit status, not necessarily a successful token transfer.

Accepted risks: earlier payment receipts can change the balance after discovery;
funds arriving later require another call. A callback failure outside handled
promise-result errors can strand the lock permanently. Insufficient native funds,
storage or gas can prevent exit. Fixed gas must be checked against each actual
token; malicious/upgraded token code can lie, consume gas or refuse transfers.
There is no asset registry, multi-token atomicity, native withdrawal or universal
asset evacuation. Current owner or guardian compromise permits immediate forced
cold evacuation; independent exit custody is essential. Immutable cold account
loss/compromise is unrecoverable. Rotation revokes new sweep initiation, but
cannot revoke already scheduled authorization. Existing dependency findings and
unaudited status remain applicable.
