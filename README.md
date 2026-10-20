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
guard with fake six-decimal USDC, installs a restricted key, and sends three
separate signed payments of `"40000000"` units against `"100000000"` daily:
the first two transfer tokens; the third rejects with `daily_limit`. It also
tests caller/key restrictions, policy authentication, bad inputs, failed
cross-contract transfers, and rollover. `tests/mock-ft.ts` is a minimal local
transfer fixture, **not a production token implementation**.
Deterministic tests execute the same policy functions as the contract using
controlled host storage/time; they do not substitute for WASM/Sandbox validation.
The Sandbox UTC rollover test can take several minutes while advancing the
local chain; its timeout is ten minutes. Exact midnight boundaries are also
covered by the fast deterministic tests.

## Contract API and accounting

- `init({owner_id, agent_id})`: once only; predecessor must equal owner. Owner,
  agent, and guard must be separate accounts. Create/deploy/initialize together
  as described below to prevent an initialization takeover.
- `set_policy({token_id, max_per_payment, daily_limit, recipients})`: owner-only,
  zero deposit. Sets both positive u128 limits together; cap cannot exceed daily
  limit. At most 100 recipients. Empty recipients pauses the token. Existing
  spending is never reset, even after reconfiguration or lowering limits.
  Changes govern new authorizations; they cannot cancel previously scheduled transfers.
- `pay({request_id, token_id, recipient_id, amount})`: configured agent **predecessor** only,
  zero deposit, 60–100 Tgas prepaid (use 80 Tgas). Returns the transfer promise.
- Read-only `get_config`, `get_policy({token_id})`, and
  `get_spending({token_id, day?})`. Day is a decimal UTC epoch-day string;
  omitted day uses current block timestamp.

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

The contract schedules only `ft_transfer` on the configured token contract, with
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
handles a missing/failed callback because no callback exists.

## Testnet deployment outline and keys

These are setup instructions, not actions performed by the test suite. Use only
testnet accounts and valueless test tokens; no mainnet deployment is included.

1. Create separate owner and agent accounts. Keep all full-access credentials
   with the trusted operator. In **one transaction action batch signed by owner**,
   receiver a new child guard account: create account, fund storage, optionally
   add an operator-only full-access key, deploy `build/guard.wasm`, and call `init`
   with `{owner_id, agent_id}` and zero deposit. The Sandbox fixture demonstrates
   this sequence. Do not deploy uninitialized code publicly: an attacker could
   claim it by naming themselves owner. A separate owner cannot deploy arbitrary
   code onto an existing account; the creation batch establishes this authority.
2. Owner calls `set_policy` with verified testnet token contract IDs, decimal
   integer limits and approved account IDs. Register guard and recipient accounts
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
   Revoke it using the operator-held full-access key when compromised or unused.

Function-call allowance limits cumulative gas fees, **not token spending**, and
does not encode a per-call gas cap. PayGuard additionally enforces 60–100 Tgas
for accepted `pay` calls. Rejected calls can still burn gas up to protocol limits;
the finite allowance bounds that exposure. The configured agent predecessor
check protects the contract even when other accounts call `pay` with their own
full-access keys. No reliance is placed on `signer_account_id` for authorization.
See [NEAR access keys](https://near.github.io/nearcore/DataStructures/AccessKey.html)
and [asynchronous cross-contract calls](https://docs.near.org/smart-contracts/anatomy/crosscontract).

## Security boundaries and limitations

The owner is trusted to change policy; any retained guard-account full-access
key holder is trusted to replace code. The agent must never receive those keys or
control another funded execution path. Only tokens held by the guard are covered.
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
