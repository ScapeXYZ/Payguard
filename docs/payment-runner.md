# Restricted-agent payment runner

`scripts/pay-agent.mjs` signs one `pay({request_id, token_id, recipient_id, amount})`
call using the existing NEAR SDK. It never deploys code, changes policy, creates
keys, deletes keys, locks accounts, or calls the token directly. No new dependencies.

## Prerequisites

Use Node 22.6+ and the repository's installed dependencies. The guard must already
be initialized and funded, with an active policy. Guard and recipient must be
registered on the intended NEP-141 token. The agent needs native NEAR for fees;
the guard needs native NEAR for storage and the outgoing 1-yocto deposit.

Supply an existing **ed25519 restricted agent credential**, outside this repository,
as a regular single-link file owned by the operator with permissions 0600 or
stricter. Its JSON must contain `account_id`, `public_key`, and `private_key` (or
`secret_key`). The runner never creates, exports or modifies credentials. Do not
paste secrets into CLI arguments, environment variables, source files or logs.
Credential symlinks and paths resolving inside the repository are refused.

Preflight reads finalized guard configuration and the selected public key. It
requires the configured agent identity and a FunctionCall permission with receiver
exactly the guard, methods exactly `["pay"]`, and a positive finite gas allowance.
FullAccess and unlimited/broad permissions are refused. This checks the signing
key, not every key on the agent or guard; it does not certify a keyless deployment.

Choose one durable journal directory outside the repository, on a local filesystem
supporting atomic rename and fsync. Its parent must already exist. The runner
creates the directory with mode 0700; existing directories must be owned and 0700.
Use the same journal for all processes using this agent key, and do not concurrently
use the key through other software. Do not place the journal on ephemeral storage.
Back it up securely. Do not delete entries to retry a business operation.

## Usage

Example values below are placeholders. This default command only performs read-only
RPC preflight: it neither signs nor broadcasts, and creates no journal entry.
Amounts are canonical positive integer strings in the token's **smallest units**;
`40000000` represents 40 tokens only when the token has six decimals.

```sh
npm run pay:agent -- \
  --network testnet \
  --rpc https://rpc.testnet.near.org \
  --guard guard.example.testnet \
  --agent agent.example.testnet \
  --credentials /secure/near/agent.example.testnet.json \
  --journal /secure/payguard-journal \
  --request-id invoice-2026-001 \
  --token token.example.testnet \
  --recipient merchant.example.testnet \
  --amount 40000000 \
  --dry-run
```

When intentionally authorizing payment, use the exact command with `--execute`
instead of `--dry-run`. This is the only mode that can broadcast. Each invocation
makes at most one broadcast attempt. There is no automatic polling/retry loop.

For a timeout or restart, use the **same request ID, payment fields, network,
guard, agent, key and journal**. Use `--reconcile` instead of `--dry-run` for
status lookup only; it cannot broadcast or create a business request. The RPC URL
may change to another trusted endpoint on the same network for archival lookup.
The RPC must use HTTPS and cannot embed credentials, query parameters or fragments.

Exit status: 0 for dry-run or finalized success; 1 for finalized failure or stopped
validation/preflight; 2 for unresolved/prepared state. CLI output includes public
request ID, transaction hash and state. Detailed receipt outcomes/errors live in
`<journal>/<request-id>.json`. The CLI deliberately avoids dumping raw exceptions,
credentials, or signed transaction bytes. For a stopped preflight, check the
operation label and safe error code first. For example,
`Preflight status: RPC transport: EAI_AGAIN` means DNS resolution failed before
any chain/configuration/key query; check network access and DNS. RPC errors show
only their numeric JSON-RPC code, never provider error text or data. Credential
loading failures identify missing/inaccessible files or invalid credential format
without printing file contents. Raw exceptions remain withheld.

Dry-run does not open, validate, lock, or modify the journal directory, even when
it already exists. A successful dry-run therefore does not certify journal
permissions or readiness for execution. Paths must be shell-expanded absolute
paths (for example, use `$HOME/...` when quoting rather than a literal `~`).

## Durability and retries

1. Acquire an exclusive journal-directory lock before finalized nonce lookup.
2. Bind the business ID to immutable network/guard/agent/payment/public key and
   fsync the prepared entry before signing.
3. Sign a single `pay` call with **80 Tgas and zero deposit**. Save and fsync its
   locally computed hash and exact signed bytes before broadcasting. Snapshots
   use mode 0600, atomic rename and directory fsync.
4. Query `tx_status` by saved hash and agent with `wait_until: FINAL` before any
   broadcast. Capture full returned receipt details and execution outcomes.
5. Only an explicit structured `UNKNOWN_TRANSACTION` permits `--execute` to
   broadcast the identical saved transaction. A timeout, arbitrary RPC error,
   malformed response, identity mismatch or nonfinal result stays unresolved.
6. Final success requires matching transaction identity, `FINAL`, terminal receipt
   outcomes and a successful final result. Any receipt failure is terminal failure.
   Subsequent invocations return the recorded terminal result without broadcasting.

A successful `send_tx` submission alone is not payment success. The runner uses
`FINAL` to include finalized receipts, following the
[NEAR transaction RPC documentation](https://docs.near.org/api/rpc/transactions).
Evidence is sanitized for the loaded private key and signed payload. The journal
contains public payment details and **signed transaction bytes that can authorize
that exact payment**; protect it as sensitive operational data. It contains no
private keys or credential objects. Terminal success still trusts RPC reporting
and the token's transfer semantics; it is not independent balance reconciliation.

## Limits and operator recovery

- Select stable, globally unique business IDs upstream. The runner does not infer
  that two different IDs represent the same invoice. Once prepared, an ID cannot
  be rebound even if the guard never accepted it. Replay protection is scoped to
  the deployed guard; a different deployment is a different authorization scope.
- Expired signed transactions, invalid nonces, depleted allowances and final
  rejections are **not automatically re-signed**. An unknown hash is not proof that
  an earlier transaction never executed. Use trusted archival receipts and operator
  reconciliation; this first runner intentionally sacrifices automatic recovery
  rather than risk a second authorization. Do not invent a new ID to retry an
  uncertain or failed business payment.
- Guard reservations and request markers survive downstream FT failure. Final
  failure can therefore consume budget without transferring tokens. The runner
  never refunds, resets spending or changes limits.
- Reconciliation currently requires the original credential and passing preflight,
  including a still-positive restricted allowance. If that key is lost, removed or
  exhausted, use the recorded public hash and agent identity with trusted read-only
  RPC tooling; the runner will not bypass permission checks.
- Resolve one uncertain payment before starting another with the same key. The
  directory lock serializes cooperating processes, not other machines/directories
  or external signers. Crashes may leave `.runner.lock`; confirm the old process is
  stopped before manually removing only that lock. Never remove payment evidence.
- A crash during snapshot writing may leave `.pending-*` files. The last atomically
  renamed entry remains authoritative; malformed journals fail closed.
- Dry-run verifies identity/key configuration, not policy acceptance, token
  registration, balances, guard code hash or eventual gas sufficiency. The contract
  remains authoritative. No public-network payment was used to validate this runner.

## Tests

```sh
npm run test:runner
npm test
npm run check
```

Runner tests use mocked RPC and ephemeral external credentials/journals. They cover
exact amounts, signed action constraints, pre-broadcast persistence, restart and
same-byte retries, final/uncertain failures, redaction, permission checks, filesystem
restrictions, journal integrity and concurrent invocations. They never contact a
public RPC or execute blockchain payments.
