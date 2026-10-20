# payguard roadmap

Team: Temi (backend, checks + break-it tests) and Lauki (agent side, demo).

1. **Oct 20:** `checkPayment` with 3 rules: max per payment, daily limit, only known addresses (scaffold in `src/`).
2. **By Oct 25:** lock exactly what it blocks; hook the agent up to it.
3. **Oct 26-31:** fake bad payments to test; Temi tries to break it.
4. **Nov 1-10:** small real payments on NEAR, fix what breaks.
5. **Nov 11-13:** demo page + video.
6. **By Nov 14:** submit to the NEAR hackathon (earlier if solid). One submission per team.

Scope: NEAR only.

Current milestone: funded NEP-141 guard contract with owner-only policy,
configured-agent authorization, persistent UTC-day integer accounting and
restricted function-call key Sandbox regression tests. On-chain state is
authoritative; the original TypeScript guard is reference-only. Testnet setup
remains an operator step; no mainnet deployment or real funds are part of this work.
