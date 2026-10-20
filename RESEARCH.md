# payguard research (Oct 20 2026)

Rules, judging, prior art and where payguard stands out. Re-read the official sources before submitting; rules can change.

## 1. NEAR hackathon (first, submit by Nov 14)

Source: https://nearhackathon.com/HACKATHON.md

- No signup. One submission per team. It can't be edited, so submit only when final.
- Submission window: Nov 1 00:00 UTC to Nov 14 23:59 UTC. Judging starts Nov 16.
- Repo can stay private while building, MUST be public by Nov 14 23:59 UTC.
- A public X post with the demo: says "built at NEAR HACKATHON" + demo video or screenshots.
- Submission fields: project name, lead name, email, team size, tracks, mainnet NEAR address (we create it), repo URL, demo URL (the X post), idea, consent. Leave the `website` field empty (spam trap).
- Some judges are AI: the README must be plain for a machine reader too (what it is, the problem, "do X, see Y" steps, no marketing).
- No keys in the repo.
- Tracks: `security` = "spending limits, policy engines, sandboxed wallets, reputation and scam detection. Give AI money without giving it the keys to everything." Hints: agent security, function call keys, TEE attestation. We enter `security` + `agents` (several tracks allowed on one submission).
- No scoring rubric is published in HACKATHON.md.

## 2. X Layer TapeOut Accelerate (second, after NEAR)

Source: https://web3.okx.com/xlayer/build-x-series

- Oct 16 to Dec 7 2026 23:59 UTC (provisional). Online; shortlisted teams go to an offline demo day.
- Prizes 100,000 USDT: 1st 20k (1 team), 2nd 10k (5 teams), 3rd 6k (5 teams).
- HARD REQUIREMENT: build inside the TapeOut ecosystem: use TapeOut circuits, contracts or onchain data on X Layer, or run on X Layer DeWEB, and give the addresses. Existing processors are fine, no need to deploy your own.
- Description must cover: product, target users and how to reach them, revenue model, why users pay and keep using it. Tools: access link + which TapeOut features are used.
- Existing projects are allowed, but only new work done during the event is judged. So the X Layer/TapeOut part must be the new work.
- Submit via their Google Form by Dec 7.
- Judging: user value + commercial potential, innovation, ecosystem integration (DeWEB, FabX, TapeCode, TapeKit, TapeSend), product readiness + UX, demo video of max 3 min (problem, core features, users + business model, how TapeOut is used).
- TapeOut: https://www.tapeout.net/ , TapeCode: https://tape4fun.com/en/tapecode.html
- So "same guard, different chain" is not enough: the X Layer entry has to run the check as, or read it from, a TapeOut circuit on X Layer, plus a revenue model.

## 3. What already exists

Fixed rules at the wallet/signing layer (caps, allowlists, rate limits):
- Coinbase CDP Policy Engine + Spend Permissions: https://docs.cdp.coinbase.com/wallets/security-and-policies/policy-engine/overview , https://docs.cdp.coinbase.com/wallets/using-wallets/spend-permissions
- Privy policies: https://docs.privy.io/controls/policies/overview
- Turnkey agentic wallets: https://docs.turnkey.com/solutions/company-wallets/agentic-wallets
- Safe allowance module for agents: https://docs.safe.global/home/ai-agent-quickstarts/agent-with-spending-limit , Zodiac Roles: https://docs.zodiac.eco/developers/roles/ai-agents
- NEAR function-call access keys (limit contract, methods, gas allowance): https://docs.near.org/protocol/accounts-contracts/access-keys

Agent "transaction firewalls" (mostly 2026 hackathon repos on Base/Solana):
- github.com/sukrutkrdg/warden402.xyz
- github.com/countersignai/countersign-firewall
- github.com/mashcthomson/presign
- github.com/Jiangw2718i/frisk
- github.com/kaditang/agent-payment-guard , github.com/lukekwan/agent-payment-guard
- github.com/razel369/intentfence
- github.com/IntentGuardLabs/intentguard-agent

Gap: nothing NEAR-native or NEAR Intents-aware. Wallet engines only do fixed caps and allowlists. The firewall repos are EVM/Solana, check one tx at a time, and sit in an SDK the agent can skip.

## 4. Where payguard stands out

Before an agent's payment settles, payguard checks it against what the agent was asked to do (right recipient, right chain, fair price, not expired, within limits) and blocks it with a plain reason. It's enforced on NEAR: the agent only holds a function-call key that can pay through the guard, so it can't go around it. That hits the security track's "function call keys" hint directly.

X Layer phase: the same check as a TapeOut circuit on X Layer, so anyone can call and verify it, with a fee per check.
