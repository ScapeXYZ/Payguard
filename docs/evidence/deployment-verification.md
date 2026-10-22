# PayGuard Testnet Deployment Verification

Verified: October 23, 2026

## Deployment

- Network: NEAR Testnet
- Contract: guard.myvirusmy.testnet
- Deployed code SHA-256: 08bfbbb60672204aa5d6029b5492ce6932c75b92dfe262f903049984071b9b58
- Local artifact: build/guard.wasm
- Local artifact SHA-256: 08bfbbb60672204aa5d6029b5492ce6932c75b92dfe262f903049984071b9b58
- Result: SHA-256 checksums match

## Access Key Verification

- Public key: ed25519:5Urjqwgf2fCcoiv5Kt6Kr7CrCn1Zx7kueQf4mv2SgGh
- Permission: FullAccess
- Guard restricted keys: 0

## Verified Contract Methods

- pay
- activate_policy
- emergency_sweep
- get_policy
- get_pending_policy
- get_spending
- get_config

## Limitations

- Contract retains one FullAccess key.
- Source-to-WASM reproducible build has not been independently verified.
- No successful live agent payment has been verified yet.
- Pending USDC policy #2 must be activated before payment testing.
- Verification represents the observed deployment, not a guarantee against future upgrades.
