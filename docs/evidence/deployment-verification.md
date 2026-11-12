# PayGuard Testnet deployment verification

This records the current verified state of guard.myvirusmy.testnet. The checks
were read-only archival RPC queries.

## Identities and policy

- Guard: guard.myvirusmy.testnet
- Owner: myvirusmy.testnet
- Agent: agent.myvirusmy.testnet
- Guardian: guardian.myvirusmy.testnet
- Immutable exit: exit.myvirusmy.testnet
- Token: usdc.fakes.testnet (USDC.e, 6 decimals)
- Merchant: merchant.myvirusmy.testnet
- Active policy: 1,000,000 base units per payment and 3,000,000 per UTC day

## Finalized key check

At finalized block 277286373, checked 2026-11-12 00:04:44.625 UTC:

- guard.myvirusmy.testnet had zero access keys.
- agent.myvirusmy.testnet had exactly one FunctionCall key, restricted to
  receiver guard.myvirusmy.testnet, method pay, with finite allowance.

The agent FullAccess key was deleted in transaction
84y2S4oAcNgCFKej6y8denrCpKpvbJRrQXQarznt6KqF; the guard keys were deleted in
transaction 6y54ZqtfZ9xSpESUZnsu3TD6zycTnScfkhoUY78KsUZ8.

Exact settled and rejected records, hashes and settlement receipt IDs are in
[payment-evidence-testnet.json](payment-evidence-testnet.json). Historical
lookups require the archival RPC because the default public node prunes old
transactions.

This is an observed deployment check, not a formal audit or a guarantee about
future account activity, token semantics or RPC availability.
