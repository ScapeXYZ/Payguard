# Payment evidence format (PROPOSED, v1)

Status: proposal for agreement with the agent payment runner owner. Nothing in the frontend depends on a runner existing: with no feed configured, the Payments history, the Overview "blocked" card and the Attack Lab all show an explicit empty state, never sample data.

## Why a feed at all

The contract keeps no payment history view (only per-day spend and request markers), and payments are signed server-side by the runner with the restricted agent key. The runner is the only party that knows every request it sent, including the ones the contract rejected. The frontend consumes the runner's record of each attempt and then **re-verifies every record against NEAR RPC** before calling it verified. A record the chain disagrees with is shown as a mismatch, never hidden or trusted.

## Transport

- One JSON document at a URL set in `NEXT_PUBLIC_EVIDENCE_URL` (static file in the repo, an R2/S3 object, or a runner endpoint).
- Served with CORS allowing the frontend origin. Read-only. No secrets in it.
- The frontend re-fetches it every 15s.

## Document

```json
{
  "schema": "payguard.evidence.v1",
  "network": "testnet",
  "guard_id": "guard.myvirusmy.testnet",
  "generated_at": "2026-10-23T09:00:00Z",
  "runner": "payguard-runner 0.1.0 (commit abc1234)",
  "records": [ { "...": "see below" } ]
}
```

`guard_id` must equal the guard the UI is pointed at, or the whole file is rejected.

## Record

| field | type | meaning |
|---|---|---|
| `request_id` | string | the `request_id` sent to `pay` (1-64 chars, `[A-Za-z0-9_-]`, same rule as the contract) |
| `scenario` | `"A"`..`"E"` or `null` | Attack Lab scenario this attempt demonstrates; `null` for ordinary payments |
| `agent_id` | string | signer of the `pay` transaction (the configured agent account) |
| `recipient_id` | string | recipient passed to `pay` |
| `token_id` | string | token contract id passed to `pay` |
| `token_symbol` | string | from the token's `ft_metadata` |
| `token_decimals` | integer | from the token's `ft_metadata` |
| `amount` | string | **base units**, decimal string, exactly as sent (`"3000000"` = 3 USDC at 6 decimals) |
| `status` | enum | see below |
| `reason` | string or `null` | for `rejected`: the contract error code (`max_per_payment`, `unapproved_recipient`, `daily_limit`, `duplicate_request`, `unknown_token`, ...); for `settlement_failed`: the token's failure text |
| `tx_hash` | string | the `pay` transaction hash. Rejected attempts are real transactions too and must be submitted, not just simulated, to count as evidence |
| `block_height` | integer or `null` | block of the transaction |
| `block_timestamp_ns` | string or `null` | block timestamp, ns |
| `explorer_url` | string | e.g. `https://testnet.nearblocks.io/txns/<hash>` |
| `settlement_receipt_id` | string or `null` | receipt id of the token's `ft_transfer`, when there is one |
| `recipient_balance_before` / `recipient_balance_after` | string or `null` | optional, base units, read by the runner via `ft_balance_of` (shown as "reported by the runner", not independently verified) |
| `note` | string or `null` | free text |

### `status` values

| value | what happened on chain |
|---|---|
| `rejected` | the guard's `pay` receipt panicked; nothing reserved, nothing moved. `reason` = the code |
| `reserved` | the guard authorized the payment and counted it against today's limit, but no token transfer receipt exists (yet) |
| `settled` | authorized + reserved, and the token's `ft_transfer` to the recipient succeeded |
| `settlement_failed` | authorized + reserved, but the `ft_transfer` failed. The reservation is NOT released (contract: no callback) |
| `pending` | submitted, final outcome not known yet |

Note: in this contract "authorized" and "reserved" happen in the same receipt (`reserve()` checks the rules and writes the spend), so they are one status.

## How the frontend verifies a record

For each record it calls `EXPERIMENTAL_tx_status(tx_hash, agent_id, wait_until=FINAL)` and derives the status itself:

- tx not sent to `guard_id` → unverifiable
- a receipt executed by the guard failed → `rejected`, reason = the contract code found in the failure
- guard receipts succeeded, a downstream receipt failed → `settlement_failed`
- guard receipts succeeded and a receipt executed by `token_id` exists → `settled`; otherwise `reserved`

It shows **verified on chain** only when the derived status (and, for rejections, the code) equals the record. Regular RPC nodes keep a couple of days of history; set `NEXT_PUBLIC_NEAR_ARCHIVAL_RPC` for older evidence, otherwise old rows show as "not verified" rather than being trusted.

## Attack Lab mapping

| scenario | runner action | expected record |
|---|---|---|
| A | pay 3 USDC to an allowlisted merchant | `settled`, ideally with recipient balances before/after |
| B | pay 15 USDC with a 5 USDC cap | `rejected`, `max_per_payment` |
| C | pay a non-allowlisted account | `rejected`, `unapproved_recipient` |
| D | pay until the daily limit is used, then once more | several `settled`, the last `rejected`, `daily_limit` |
| E | re-send an already used `request_id` | `rejected`, `duplicate_request` |

Prerequisite: an ACTIVE policy for the token. At the time of writing the live guard has none (proposal #2 pending), so every pay call fails with `unknown_token` until it is activated.

## Open questions for the runner owner

1. Hosting: static JSON committed to the repo after a test run, or a live endpoint?
2. Should D be one record per payment (proposed) or one summary record?
3. Do you want the runner to also publish `ft_balance_of` snapshots for the guard and exit (for the sweep demo)?
