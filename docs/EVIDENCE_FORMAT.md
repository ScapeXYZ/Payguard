# Payment evidence v2 contract

The exporter (offline by default) emits `payguard.evidence.v2` for the frontend partner.
Pending policy/proposal IDs are never attached to payments without evidence.

## Produce evidence

```sh
npm run evidence:export -- \
  --network testnet \
  --guard guard.testnet \
  --journal "$HOME/payguard-agent-journal" \
  --output /absolute/existing/export-directory/payment-evidence.json
```

`--network` (`testnet` or `mainnet`) and `--guard` (canonical account ID) are
required deployment identifiers, even for an empty journal. Every entry must
match both; mixed deployments fail the entire export before replacing output.
These identifiers scope evidence; they do not independently verify the chain.
`--journal` and `--output` are required absolute paths. The journal must exist; absence is an
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

Without `--rpc`, no RPC calls occur. With `--rpc https://trusted-endpoint`, the
exporter checks `status.chain_id`, requests `tx_status` at `FINAL` by saved hash
and signer, and fetches missing linked bodies via `EXPERIMENTAL_receipt`. It checks
matching transaction identity and complete terminal outcome links before projection.
Missing/contradictory RPC evidence aborts export and preserves previous output.
No credentials, signing, broadcasts, journal writes or key/policy changes occur.
This exporter never invokes the payment runner. Enrichment is held in memory;
no journal append is needed. RPC exports use `runner_journal_rpc` as envelope and
record source, and `verified_at` is the completed RPC observation time. Offline
exports retain `runner_journal` and persisted event timestamps. Offline records from the same journal snapshots have deterministic content and request-ID
ordering. `generated_at` is the UTC ISO-8601 export time, so exports may differ
in that field. It is not evidence time and never proves on-chain verification. A concurrent
runner can replace individual snapshots during the scan: each file is atomic,
but the export is not a transactionally consistent snapshot of the directory.

## JSON and frontend consumption

The file is an object:

```json
{
  "schema": "payguard.evidence.v2",
  "network": "testnet",
  "guard_id": "guard.testnet",
  "generated_at": "2026-10-23T10:00:00.000Z",
  "source": "runner_journal",
  "records": []
}
```

This empty example is illustrative, not live evidence. Network and guard appear
only in the envelope. `source` is required both in the envelope and every record.
Records are
sorted by request ID using code-unit order. Each record contains:

| Field | Type and meaning |
| --- | --- |
| request_id | String; business ID, unique within this export |
| agent_id, recipient_id, token_id | Validated account ID strings from persisted intent |
| amount | Canonical positive u128 integer string in base units; never a JS number |
| status | One of the five statuses below |
| reason | Fixed safe classification code or null; never raw exceptions |
| tx_hash | Persisted base58 hash or null |
| explorer_url | Network-specific NearBlocks transaction URL derived from validated hash, or null |
| settlement_receipt_id | Verified successful FT receipt ID or null |
| source | `runner_journal` or `runner_journal_rpc` |
| verified_at | Required key: UTC ISO timestamp of persisted classified observation (offline) or completed RPC observation, or null when absent/invalid/unclassified; not export time or block time |
| note | Fixed description of uncertainty or verification limits |
| scenario, token_symbol, token_decimals | Currently null; scenario may only be A–E or null. Runner has no authoritative scenario/token metadata |
| block_height, block_timestamp_ns | Currently null; no verified block header enrichment |
| recipient_balance_before, recipient_balance_after | Currently null; no historical balance evidence |
| policy_id, proposal_id | Currently null; policy_id needs independent contract evidence; proposal_id must be a decimal string or null, never a number |

Do not infer symbols/decimals from account names, USDC assumptions or UI defaults.
Display unknown metadata as unknown and amount as a base-unit string. Future
enrichment needs a versioned evidence source with explicit provenance; arbitrary
extra fields in a journal are not trusted by this exporter. No sample records are
injected. Do not seed Attack Lab outcomes from this export.

Load the generated JSON via the frontend's configured read-only data endpoint or
bundled asset; the exporter itself does not serve HTTP or copy files into the
frontend. Validate `schema === "payguard.evidence.v2"`, expected network/guard, all required
record keys (including nullable keys), array shape and unique request IDs before
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

Offline classification requires a persisted reconciliation/broadcast outcome with matching
transaction hash, signer and guard and `final_execution_status: FINAL`. The latest
such outcome event is examined. The transaction outcome must link to the guard
receipt by `receipt_ids`; the guard receipt executor must match the guard.

| Status | Required evidence |
| --- | --- |
| rejected | Linked guard receipt has explicit `Failure`; reason `guard_execution_failed`. This includes guard execution errors, not necessarily a specific policy rejection. |
| reserved | Successful guard receipt links to an exact single `ft_transfer` action from guard to configured token, with matching receiver and base-unit amount. FT completion is unverified. |
| pending | Default for prepared, signed, uncertain, missing, nonfinal, mismatched or insufficient evidence, including runner `succeeded`/`failed` without sufficient receipts. Never relabel an unknown outcome as rejected. |
| settled | Reserved evidence plus matching token executor's FT receipt has `SuccessValue`, no child receipts except verified successful system refunds, and a valid receipt ID in the persisted FINAL outcome. Guard success or budget reservation alone is insufficient. |
| settlement_failed | Reserved evidence plus matching token executor's FT receipt has explicit `Failure`; reason `ft_transfer_failed`. Reservation may remain consumed. |

Settlement is independently checked at the FT receipt level rather than inferred
from the guard transaction's result. This checks recorded or freshly fetched RPC evidence, not independent RPC-provider consensus, cryptographic proof validation,
token code auditing or balance reconciliation. It trusts the journal provenance,
RPC finality reporting and token semantics. Tokens that spawn contract continuations remain reserved. Protocol refunds are
accepted only with a real linked body: `system` predecessor, zero gas price,
single native Transfer to the agent, and a matching successful leaf outcome.
Missing refund bodies never count as proof. Submission RPC responses may omit action-bearing `receipts`; offline exports stay
pending even if the runner records success. Opt-in read-only RPC verification can
supply real bodies without changing the journal. See
[payment-runner.md](payment-runner.md#read-only-payment-evidence-export) for the command
and the [NEAR RPC method reference](https://docs.near.org/api/rpc/transactions). Raw logs and failure text are never exported.

## Frontend partner confirmation needed

- Confirm how to supply/host the generated asset and refresh/stale-state behavior.
- Confirm how authoritative A–E scenario evidence will be supplied for transaction history and Attack Lab; the runner
  has no authoritative scenario field and the exporter will not guess one.
- Confirm the provenance contract for future token metadata, block headers,
  historical balances and active policy/proposal IDs. Proposal #2 alone must not
  be displayed as an active payment policy.
