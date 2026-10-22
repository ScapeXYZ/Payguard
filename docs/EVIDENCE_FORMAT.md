# Payment evidence format v2

Status: v1 agreed as the base by the runner owner; v2 adds his changes (provenance per record, policy linkage, receipt-verified settlement). Implemented in `frontend/lib/evidence.ts`. With no feed configured, Payments history, the Overview "blocked" card and the Attack Lab show an explicit empty state, never sample data.

## Why a feed at all

The contract keeps no payment history view, and payments are signed server-side by the runner with the restricted agent key. The runner is the only party that knows every request it sent, including rejected ones. The frontend consumes the runner's records and **re-verifies every record against NEAR RPC**. A record the chain disagrees with is shown as "chain disagrees", never hidden or trusted.

## Transport

- One JSON document at `NEXT_PUBLIC_EVIDENCE_URL` (static file, R2/S3 object, or runner endpoint), CORS open to the frontend origin, read-only, no secrets. Re-fetched every 15s.

## Document

```json
{
  "schema": "payguard.evidence.v2",
  "network": "testnet",
  "guard_id": "guard.myvirusmy.testnet",
  "generated_at": "2026-10-23T09:00:00Z",
  "source": "payguard-runner 0.2.0 (commit abc1234)",
  "records": [
    {
      "request_id": "demo-a-1",
      "scenario": "A",
      "agent_id": "agent.myvirusmy.testnet",
      "recipient_id": "merchant.myvirusmy.testnet",
      "token_id": "usdc.fakes.testnet",
      "token_symbol": "USDC",
      "token_decimals": 6,
      "amount": "3000000",
      "status": "settled",
      "reason": null,
      "tx_hash": "<pay tx hash>",
      "block_height": 274177211,
      "block_timestamp_ns": "1792632395929417961",
      "explorer_url": "https://testnet.nearblocks.io/txns/<pay tx hash>",
      "settlement_receipt_id": "<receipt id of the token's ft_transfer>",
      "policy_id": null,
      "proposal_id": "2",
      "source": "payguard-runner 0.2.0 (commit abc1234)",
      "verified_at": "2026-10-23T08:59:41Z",
      "recipient_balance_before": "0",
      "recipient_balance_after": "3000000",
      "note": null
    }
  ]
}
```

Document rules (any failure rejects the whole file):
- `schema` must be `payguard.evidence.v2`.
- `network` must equal the network the UI reads, `guard_id` must equal the guard the UI reads.
- `generated_at` ISO 8601; `source` = who wrote this file.

### Where `source` / `verified_at` live (decision)

**Per record, required.** Records can come from different runner versions and verification passes (a file is typically appended to over several runs), so one document-level timestamp would misdate older records. The document also carries its own `source` + `generated_at`, describing the file write, not the verification.

## Record

| field | type | meaning |
|---|---|---|
| `request_id` | string | the `request_id` sent to `pay` (1-64 chars, `[A-Za-z0-9_-]`) |
| `scenario` | `"A"`..`"E"` or `null` | Attack Lab scenario; `null` for ordinary payments |
| `agent_id` | string | signer of the `pay` transaction |
| `recipient_id` | string | recipient passed to `pay` |
| `token_id` | string | token contract passed to `pay` |
| `token_symbol`, `token_decimals` | string, integer | from the token's `ft_metadata` |
| `amount` | string | **base units**, decimal string, exactly as sent |
| `status` | enum | see below |
| `reason` | string or `null` | REQUIRED for `rejected` (contract code); for `settlement_failed`, the token's failure text |
| `tx_hash` | string | the `pay` transaction. Rejections must be real submitted transactions |
| `block_height`, `block_timestamp_ns` | integer / string or `null` | block of the transaction |
| `explorer_url` | string | nearblocks link |
| `settlement_receipt_id` | string or `null` | receipt id of the token's `ft_transfer`. **REQUIRED for `settled`**; recommended for `settlement_failed` |
| `policy_id` | string or `null` | reserved; the contract has no policy id today, send `null` |
| `proposal_id` | decimal string or `null` | policy proposal that produced the active policy at pay time, where known |
| `source` | string | who verified THIS record (runner id + commit) |
| `verified_at` | ISO 8601 | when that runner verified it |
| `recipient_balance_before` / `_after` | string or `null` | optional, base units via `ft_balance_of`; shown as "reported by the runner", not chain-verified |
| `note` | string or `null` | free text |

### `status` values

| value | meaning | required proof |
|---|---|---|
| `rejected` | the guard's `pay` receipt panicked; nothing reserved, nothing moved | `reason` = contract code |
| `pending` | submitted, outcome not final | none |
| `reserved` | guard authorized + counted against today's limit; no ft_transfer receipt found | none; never shown as paid |
| `settlement_failed` | reserved, and the token's `ft_transfer` receipt FAILED. Reservation is not released (no callback) | the failed receipt (id recommended) |
| `settled` | reserved, and the token's `ft_transfer` to the recipient SUCCEEDED | `settlement_receipt_id`; balance delta optional |

A successful guard transaction alone is never `settled`. Authorization and reservation happen in the same receipt (`reserve()`), so they are one state.

## How the frontend verifies a record

`EXPERIMENTAL_tx_status(tx_hash, agent_id, wait_until=FINAL)`, then:

1. tx not sent to `guard_id`, or not signed by `agent_id` → **not verified**.
2. `settled` with no `settlement_receipt_id` → **not verified** (the parser already rejects such a file).
3. a guard receipt failed → chain status `rejected`, code from the failure.
4. otherwise look for the settlement receipt: `predecessor_id == guard_id`, `receiver_id == token_id`, `FunctionCall ft_transfer` with args `receiver_id == recipient_id` and `amount == amount`.
   - not found → `reserved` (or `pending` if the tx isn't final)
   - found, outcome Failure → `settlement_failed`
   - found, outcome success → `settled`
5. **verified on chain** only when the chain status equals the record's status, the rejection code matches, and (for `settled` / `settlement_failed` with an id) the receipt id equals the one found. Anything else → **chain disagrees**, with the difference named.

Regular RPC keeps a couple of days; set `NEXT_PUBLIC_NEAR_ARCHIVAL_RPC` for older evidence, otherwise old rows show "not verified" instead of being trusted.

## Attack Lab mapping

| scenario | runner action | expected record |
|---|---|---|
| A | pay 3 USDC to an allowlisted merchant | `settled` + `settlement_receipt_id`, ideally balances before/after |
| B | pay 15 USDC with a 5 USDC cap | `rejected`, `max_per_payment` |
| C | pay a non-allowlisted account | `rejected`, `unapproved_recipient` |
| D | pay until the daily limit is used, then once more | several `settled`, the last `rejected`, `daily_limit` |
| E | re-send an already used `request_id` | `rejected`, `duplicate_request` |

Prerequisite: an ACTIVE policy for the token. The live guard has none today (proposal #2 pending), so every pay call fails with `unknown_token` until it is activated.

## Open questions

1. Hosting: static JSON committed after a run, or a live endpoint?
2. D as one record per payment (assumed) or a summary record?
3. Guard/exit `ft_balance_of` snapshots for the sweep demo?
