# payguard

Payment guard for AI agents on NEAR: checks every payment before it goes out and blocks bad ones, with a reason.

```
npm test   # node 22.6+
```

`src/checkPayment.ts` returns `{ allow, reason }` for every payment. Plan in `ROADMAP.md`.
