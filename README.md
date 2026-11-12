# PayGuard

> AI proposes. PayGuard checks. The authorized executor pays.

**Track:** AI Security & Defense

PayGuard is a NEAR on-chain spending guard for AI-agent payments. The guard
owns the configured NEP-141 test token and authorizes bounded transfers from a
restricted agent key. The runner and local dashboard preserve and independently
verify transaction evidence.

## Judge quick path

Install and prepare tools:

\`\`\`sh
npm install --ignore-scripts
npm run setup:tools
\`\`\`

Expected: dependencies install without lifecycle scripts and the NEAR SDK and
local Sandbox tools are installed.

Run the main suite:

\`\`\`sh
npm test
\`\`\`

Expected: 135 tests pass. The command includes read-only Testnet deployment
checks; it does not deploy.

View the three committed Testnet records:

- [payguard-live-001](https://testnet.nearblocks.io/txns/3AsqcEjmfCBgfUNVcNNA3BHuRJSfQwQEW9QEVr9wdReV)
- [payguard-demo-001](https://testnet.nearblocks.io/txns/2wryjMdUUbByym5HNqyfwHQqzZ9zunZU1EgCy5FxVUGL)
- [payguard-demo-overcap-001](https://testnet.nearblocks.io/txns/Bykgci7m289krVR2HSJAj6yh46pUJorYv6Hj4ghvCAgv)
- [committed evidence](docs/evidence/payment-evidence-testnet.json)

Expected: two settled records and one guard-rejected over-cap record. The
committed file is authoritative for exact statuses and receipt IDs. Nearblocks
returned HTTP 403 when one sample URL was fetched from this environment, so
external resolution was not independently confirmed.

Run the dashboard:

\`\`\`sh
cd frontend
npm install
npm run dev
\`\`\`

Open http://localhost:3000. Expected: live guard policy, spending state and
evidence-backed payment history. The dashboard re-verifies transactions through
read-only RPC.

The complete suite is npm run test:all: 145 tests, and slow because Sandbox
takes roughly 15 minutes. Root commands also include npm run check,
npm run build, npm run test:sandbox, npm run test:runner and
npm run test:evidence. The frontend suite has 134 tests:
cd frontend && npm test.

## The problem

AI systems can propose useful payments without needing unrestricted control of
a funded account. PayGuard constrains recipients, amounts, frequency and
retries while preserving a reviewable record of what the chain executed.

## What is shipped

Recipient allowlists; a per-payment cap; a UTC-calendar-day daily cap; replay
protection by stable request ID; a restricted FunctionCall agent key; a
24-hour policy timelock; guardian veto; delayed owner recovery; emergency
sweep to the immutable exit; receipt-verified evidence export; and a local
dashboard.

The active Testnet policy is 1 USDC.e per payment and 3 USDC.e per UTC day,
with merchant.myvirusmy.testnet allowlisted. The token is
usdc.fakes.testnet, metadata symbol USDC.e and six decimals, and is a valueless
test token.

## Architecture and roles

\`\`\`
AI proposal -> payment runner -- restricted pay key --> guard
                                                       |
                                      policy + replay + UTC-day reservation
                                                       |
                                                       v
                              usdc.fakes.testnet::ft_transfer
                                                       |
                                                       v
                                      merchant.myvirusmy.testnet

owner myvirusmy.testnet       policy administration and recovery
guardian guardian.myvirusmy.testnet  veto and recovery
exit exit.myvirusmy.testnet  immutable emergency-sweep destination
\`\`\`

Only the configured agent predecessor may call pay; its key is restricted to
the guard's pay method. The guard owns the NEP-141 tokens. The browser signs
owner, guardian and exit operations; the runner keeps the agent key outside the
browser.

## Live Testnet proof

| Request | Status | Transaction | Settlement receipt |
|---|---|---|---|
| payguard-live-001 | settled | [3AsqcEjmfCBgfUNVcNNA3BHuRJSfQwQEW9QEVr9wdReV](https://testnet.nearblocks.io/txns/3AsqcEjmfCBgfUNVcNNA3BHuRJSfQwQEW9QEVr9wdReV) | AKpNHoTaCXMNX8cjKbw5qHre54pEpBMFthTPvri3SCme |
| payguard-demo-001 | settled | [2wryjMdUUbByym5HNqyfwHQqzZ9zunZU1EgCy5FxVUGL](https://testnet.nearblocks.io/txns/2wryjMdUUbByym5HNqyfwHQqzZ9zunZU1EgCy5FxVUGL) | 5omkdRLY1urz635smU3g5W7SDnK3EPoPgAqDhQwVdWKF |
| payguard-demo-overcap-001 | rejected by guard | [Bykgci7m289krVR2HSJAj6yh46pUJorYv6Hj4ghvCAgv](https://testnet.nearblocks.io/txns/Bykgci7m289krVR2HSJAj6yh46pUJorYv6Hj4ghvCAgv) | none |

Token contracts in the evidence are record-specific: payguard-live-001 used
token contract ID 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
under the earlier policy, while payguard-demo-001 and
payguard-demo-overcap-001 used usdc.fakes.testnet. The current active policy
covers usdc.fakes.testnet.

See [the evidence file](docs/evidence/payment-evidence-testnet.json). Historical
lookups require https://archival-rpc.testnet.fastnear.com/ because the default
public node prunes old transactions.

At finalized block 277286373, checked 2026-11-12 00:04:44.625 UTC, the archival
RPC returned zero guard access keys. The guard lock transaction was
[6y54ZqtfZ9xSpESUZnsu3TD6zycTnScfkhoUY78KsUZ8](https://testnet.nearblocks.io/txns/6y54ZqtfZ9xSpESUZnsu3TD6zycTnScfkhoUY78KsUZ8).
The agent FullAccess key was deleted in
[84y2S4oAcNgCFKej6y8denrCpKpvbJRrQXQarznt6KqF](https://testnet.nearblocks.io/txns/84y2S4oAcNgCFKej6y8denrCpKpvbJRrQXQarznt6KqF).
The agent then had exactly one FunctionCall key: receiver guard, method
pay, finite allowance.

## NEAR tools used

The repository uses near-sdk-js, near-api-js, near-workspaces, NEAR JSON-RPC,
FunctionCall access keys, NEP-141 token calls, and NEAR Wallet Selector in the
frontend. It does not use NEAR Intents, Chain Signatures, NEAR AI Cloud, TEEs,
or the 1-Click Swap SDK.

## Not implemented / roadmap

- Intents quote and chain validation.
- Wrong-chain detection beyond configured network/RPC checks.
- Rolling 24-hour limits; the shipped limit is a UTC calendar day.
- A hosted dashboard; the dashboard runs locally.
- Formal third-party audit.

## Security status and limitations

Failed downstream token transfers keep their reservation and request marker.
The token contract is trusted because the owner configures it. Stable request
IDs are the caller's job. Evidence relies on RPC receipts, not multi-provider
proof or independent balance reconciliation. The zero-key guard cannot be
upgraded or re-keyed. Owner, guardian and exit remain ordinary keyed accounts
and are the recovery path. This is a focused security review, not a formal
third-party audit.

The dependency snapshot says the 12 high entries are affected packages, not 12
independent advisories, and trace to the build-time braces
GHSA-vfj7-8cjw-p6xm / CVE-2026-93687 path through SDK globbing. Normal builds
use literal paths, but untrusted build inputs remain a denial-of-service risk.
tar is overridden to 7.5.22; lower-severity URI-decoding and legacy elliptic
crypto findings remain. No dependency upgrade or npm audit fix --force was run.
As of November 12, 2026, GitHub Dependabot reported 10 open alerts (5 high,
2 moderate, 3 low) on the default branch. The existing dependency review
snapshot predates the current live alert count.

## Repository map

- [contract](contract/) — guard contract.
- [payment runner](scripts/pay-agent.mjs) and [evidence exporter](scripts/export-payment-evidence.mjs).
- [frontend](frontend/) — local dashboard.
- [evidence format](docs/EVIDENCE_FORMAT.md) and [committed evidence](docs/evidence/payment-evidence-testnet.json).
- [runner guide](docs/payment-runner.md), [key management](docs/key-management.md),
  [security review](docs/security-review.md), and [dependency snapshot](docs/dependency-audit.json).
