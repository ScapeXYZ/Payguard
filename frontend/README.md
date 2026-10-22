# Payguard UI

Frontend for Payguard (the contract lives in `../contract`), a NEAR spending guard for AI agents.
Next.js (app router) + Tailwind + shadcn/ui, static export.

## Screens

| Route | Screen | Contract methods |
|---|---|---|
| `/` | Setup: owner, agent, guardian, exit (permanent), review + sign | `init`, `get_config` |
| `/payments` | Caps, spent today, pending policy w/ 24h countdown, allowlist, change rules (instant vs 24h preview) | `get_policy`, `get_spending`, `get_pending_policy`, `set_policy`, `cancel_policy`, `activate_policy` |
| `/guardian` | Guardian change + owner recovery with live countdowns, cancel/veto, who-can-do-what matrix | `get_pending_guardian_change`, `get_pending_owner_recovery`, `get_recovery_cooldown`, `propose_guardian_change`, `cancel_guardian_change`, `cancel_owner_recovery`, `activate_*` |
| `/sweep` | Emergency sweep: fixed exit destination, typed SWEEP confirm, step-by-step flow | `emergency_sweep` (180-250 Tgas) |

## Data

- `lib/guard.ts` = every `@view` from `contract/guard.ts`, same names and shapes.
  - no env → live testnet guard `guard.myvirusmy.testnet` (real NEAR RPC view calls)
  - `NEXT_PUBLIC_GUARD_CONTRACT=mock` → mock data
  - `NEXT_PUBLIC_GUARD_CONTRACT=<other-guard>.testnet` → that guard (testnet by default; `NEXT_PUBLIC_NEAR_NETWORK=mainnet` to switch)
  - `NEXT_PUBLIC_GUARD_TOKENS=usdc.fakes.testnet,...` → tokens to show (add decimals in `TOKEN_META`)
- `lib/wallet.ts` = every write call, typed with the exact args. Simulated until NEAR Wallet Selector is wired in `signAndSend`.
- Payment history on `/payments` is sample data; the contract has no history view, use an indexer (NearBlocks) later.

## Run

```
cd frontend
npm install
npm run dev     # local
npm run build   # static export to out/
```
