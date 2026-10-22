# Proposed payment evidence contract (schema version 1)

This is a proposed frontend integration contract; no frontend evidence spec was
present during implementation. Partner confirmation is required before treating
this as a stable API. The configured `~/payguard-agent-journal` was absent during
implementation; schema inspection and validation used the runner and fixtures,
not live payment evidence. Pending USDC policy/proposal #2 is not evidence of an
active policy or payment and is never attached to records by default.

## Produce evidence

```sh
npm run evidence:export -- \
  --journal "$HOME/payguard-agent-journal" \
  --output /absolute/existing/export-directory/payment-evidence.json
```

Both arguments are required absolute paths. The journal must exist; absence is an
error, not an empty history. The output parent must exist and output must end in
`.json`, outside the journal. Existing regular single-link output files may be
replaced. Journal directory symlinks, entry symlinks/hardlinks, output symlinks and
hardlinks are refused. Use operator-controlled local directories: this is not a
defense against a hostile process concurrently replacing ancestor directories.
The exporter never opens journal files for writing or acquires a runner lock.
Runner dotfiles (locks/incomplete atomic snapshots) are ignored. Other files must
be JSON version-1 runner entries. Invalid entries, unsupported versions, duplicate
request IDs, oversized files (>16 MiB), or unsafe paths fail the entire export.
The CLI withholds raw errors. Previous output remains intact on input/validation
failure. Output uses an exclusive temporary file, mode 0600, file fsync, atomic
rename and directory fsync; failure after rename can mean output was published
but durability could not be confirmed. Interrupted writes can leave `.evidence-*`
temporary files in the output directory.

No RPC calls, credentials, SDK signing, broadcasts or key/policy changes occur.
To refresh evidence, separately reconcile using authorized operational tooling;
this exporter does not invoke the payment runner. Same journal snapshots produce
byte-identical output. There is no wall-clock export timestamp. A concurrent
runner can replace individual snapshots during the scan: each file is atomic,
but the export is not a transactionally consistent snapshot of the directory.

## JSON and frontend consumption

The file is an object `{ "schema_version": 1, "records": [...] }`. Records are
sorted by request ID using code-unit order. Each record contains:

| Field | Type and meaning |
| --- | --- |
| request_id | String; business ID, unique within this export |
| network | `testnet` or `mainnet` |
| guard_id, agent_id, recipient_id, token_id | Validated account ID strings from persisted intent |
| amount | Canonical positive u128 integer string in base units; never a JS number |
| status | One of the five statuses below |
| reason | Fixed safe classification code or null; never raw exceptions |
| tx_hash | Persisted base58 hash or null |
| explorer_url | Network-specific NearBlocks transaction URL derived from validated hash, or null |
| settlement_receipt_id | Verified successful FT receipt ID or null |
| source | `runner_journal` |
| verified_at | Timestamp of persisted evidence observation, or null; not export time |
| note | Fixed description of uncertainty or verification limits |
| scenario, token_symbol, token_decimals | Currently null; runner does not persist authoritative scenario/metadata |
| block_height, block_timestamp_ns | Currently null; no verified block header enrichment |
| recipient_balance_before, recipient_balance_after | Currently null; no historical balance evidence |
| policy_id, proposal_id | Currently null; runner does not persist policy/proposal identity |

Do not infer symbols/decimals from account names, USDC assumptions or UI defaults.
Display unknown metadata as unknown and amount as a base-unit string. Future
enrichment needs a versioned evidence source with explicit provenance; arbitrary
extra fields in a journal are not trusted by this exporter. No sample records are
injected. Do not seed Attack Lab outcomes from this export.

Load the generated JSON via the frontend's configured read-only data endpoint or
bundled asset; the exporter itself does not serve HTTP or copy files into the
frontend. Validate `schema_version === 1`, array shape and unique request IDs before
rendering. Replace the displayed snapshot atomically, rather than appending rows
on every refresh. Treat request IDs as scoped to this configured journal; a future
multi-journal integration needs a network/guard/request composite identity.
Render strings as text, never HTML. Missing/null fields display “Unknown” or “—”.
`records: []` means “No persisted payment evidence available”; it does not prove
there have been no on-chain payments. A failed fetch, invalid JSON, unsupported
version or exporter error is a data error, not an empty history. If retaining a
previous snapshot after refresh failure, visibly label it stale. Do not show a
success badge for null, pending, reserved, or a runner's `succeeded` label.

## Status rules and verification limits

Classification requires a persisted reconciliation/broadcast outcome with matching
transaction hash, signer and guard and `final_execution_status: FINAL`. The latest
such outcome event is examined. The transaction outcome must link to the guard
receipt by `receipt_ids`; the guard receipt executor must match the guard.

| Status | Required evidence |
| --- | --- |
| rejected | Linked guard receipt has explicit `Failure`; reason `guard_execution_failed`. This includes guard execution errors, not necessarily a specific policy rejection. |
| reserved | Successful guard receipt links to an exact single `ft_transfer` action from guard to configured token, with matching receiver and base-unit amount. FT completion is unverified. |
| pending | Default for prepared, signed, uncertain, missing, nonfinal, mismatched or insufficient evidence, including runner `succeeded`/`failed` without sufficient receipts. Never relabel an unknown outcome as rejected. |
| settled | Reserved evidence plus matching token executor's FT receipt has `SuccessValue`, no child receipts, and a valid receipt ID in the persisted FINAL outcome. Guard success or budget reservation alone is insufficient. |
| settlement_failed | Reserved evidence plus matching token executor's FT receipt has explicit `Failure`; reason `ft_transfer_failed`. Reservation may remain consumed. |

Settlement is independently checked at the FT receipt level rather than inferred
from the guard transaction's result. This is an offline check of recorded RPC
evidence, not independent RPC-provider consensus, cryptographic proof validation,
token code auditing or balance reconciliation. It trusts the journal provenance,
RPC finality reporting and token semantics. Tokens that spawn further receipts
remain reserved until a future verifier supports their execution graph. Current
runner RPC responses may omit action-bearing `receipts`; such entries stay pending
even if the runner records success. Raw logs and failure text are never exported.

## Frontend partner confirmation needed

- Confirm the versioned envelope, null handling, fixed statuses and the distinction
  between `reserved` (unverified FT completion) and `pending` (insufficient evidence).
- Confirm how to supply/host the generated asset and refresh/stale-state behavior.
- Confirm scenario vocabulary for transaction history and Attack Lab; the runner
  has no authoritative scenario field and the exporter will not guess one.
- Confirm the provenance contract for future token metadata, block headers,
  historical balances and active policy/proposal IDs. Proposal #2 alone must not
  be displayed as an active payment policy.
