# Payguard UI

Frontend for Payguard (the contract lives in `../contract`), a NEAR spending guard for AI agents.
Next.js (app router) + Tailwind + shadcn/ui, static export.

## Screens

| Route | Screen | Contract methods |
|---|---|---|
| `/` | Overview (initialised guard): what is protected, what the agent can spend, what was blocked, what owner/guardian can do, pending items. Init flow only when the guard reads as deployed-but-uninitialised | `get_config`, `get_policy`, `get_spending`, `get_pending_*`, `ft_balance_of`, `init` |
| `/payments` | Token picker (verified ft_metadata), ACTIVE vs PENDING policy, countdown, cancel/veto, activate, allowlist-preserving rule editor, disable policy, evidence-backed payment history | `get_policy`, `get_spending`, `get_pending_policy`, `set_policy`, `cancel_policy`, `activate_policy`, `disable_policy` |
| `/guardian` | Normal vs cold-key guardian change with the correct veto account, owner recovery, cooldown, all three propose flows, permission matrix | `get_pending_guardian_change`, `get_pending_owner_recovery`, `get_recovery_cooldown`, `propose_guardian_change`, `propose_cold_key_guardian_change`, `propose_owner_recovery`, `cancel_guardian_change`, `cancel_owner_recovery`, `activate_*` |
| `/sweep` | Emergency sweep: immutable exit, guard/exit balances, typed SWEEP confirm, lifecycle filled from the tx's on-chain events | `emergency_sweep` (200 Tgas), `ft_balance_of` |
| `/attack-lab` | Proposed: scenarios A-E (legit, over cap, non-allowlisted, daily limit, replay), each waiting for verified testnet evidence | evidence feed + `EXPERIMENTAL_tx_status` |

## Data

- `lib/guard.ts` = every `@view` from `contract/guard.ts`, same names and shapes, plus role detection.
  - no env: live testnet guard `guard.myvirusmy.testnet` (real NEAR RPC view calls, default RPC `https://test.rpc.fastnear.com`)
  - `NEXT_PUBLIC_GUARD_CONTRACT=mock`: mock data, always badged "mock data", signing disabled
  - `NEXT_PUBLIC_GUARD_CONTRACT=<other-guard>.testnet`: that guard (`NEXT_PUBLIC_NEAR_NETWORK=mainnet` to switch network, `NEXT_PUBLIC_NEAR_RPC` to override the RPC)
  - `NEXT_PUBLIC_GUARD_TOKENS=<token>,...`: tokens to show. Symbol and decimals are read from each token's own `ft_metadata`, never hard-coded.
- `lib/wallet.tsx` = NEAR Wallet Selector (MyNearWallet, Meteor). Signs owner, guardian and exit methods only. `pay` is not in the browser: the agent key stays with the payment runner.
- `lib/use-tx.ts` = transaction states (awaiting signature, submitted, pending, confirmed, rejected, failed). Success is shown only after the final outcome is re-read from RPC (`lib/tx-outcome.ts`).
- `lib/amount.ts` = exact BigInt base units; over-precise, negative or malformed amounts are refused, never rounded.
- Payment history and the Attack Lab read the payment runner's evidence feed (`NEXT_PUBLIC_EVIDENCE_URL`, format proposed in `docs/EVIDENCE_FORMAT.md`) and re-verify each tx on chain. No feed = an explicit empty state, never sample data.

## Run

```
cd frontend
npm install
npm run dev     # local
npm run build   # static export to out/
```
