# PayGuard dashboard

This Next.js dashboard is the local frontend for the Testnet guard
guard.myvirusmy.testnet. It reads live contract state and a configured evidence
feed; it does not hold the agent payment key.

## Run locally

\`\`\`sh
cd frontend
npm install
npm run dev
\`\`\`

Open http://localhost:3000. Use npm run build and npm run start for a
production check. npm test runs transaction-safety and evidence compatibility
regressions (134 tests).

## Screens

- / — overview of guard, policy, spending and evidence state.
- /payments — token metadata, policy controls and evidence-backed history.
- /guardian — guardian changes, owner recovery and cooldown state.
- /sweep — emergency sweep to the immutable exit account.
- /attack-lab — experimental evidence scenarios; it creates no transactions.

## Data and safety

Configure NEXT_PUBLIC_GUARD_CONTRACT, NEXT_PUBLIC_NEAR_NETWORK,
NEXT_PUBLIC_NEAR_RPC, NEXT_PUBLIC_GUARD_TOKENS and NEXT_PUBLIC_EVIDENCE_URL
as needed. Token symbol and decimals come from ft_metadata; historical
verification falls back to the archival RPC.

Settlement is never inferred from the feed alone. Each record is matched to
the exact zero-deposit agent pay call and re-verified through read-only RPC.
Only the exact successful linked NEP-141 ft_transfer receipt receives a
settled badge. Missing, contradictory, failed or non-final evidence remains
unverified or failed, never settled.

The browser signs owner, guardian and exit operations through NEAR Wallet
Selector. pay belongs to the external payment runner. Verification retry only
reads RPC; it never signs or resends. The dashboard is local, not hosted, and
does not implement Intents, Chain Signatures, NEAR AI Cloud, TEEs or the
1-Click Swap SDK.
