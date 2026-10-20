# payguard

Payment guard for AI agents on NEAR: checks every payment before it goes out and blocks bad ones, with a reason.

```
npm test   # node 22.6+
```

`src/checkPayment.ts` returns `{ allow, reason }` for every payment. Plan in `ROADMAP.md`.

Spending is recorded **on authorization**: every allowed `checkPayment` call
reserves its amount, including repeated checks of the same payment. Rejections
consume no budget. There is no settlement callback or automatic refund for failed
or abandoned payments.

`checkPayment(payment, policy, spentToday?)` keeps its existing call signature.
Its module-level ledger groups all callers by lowercase token identifier and UTC
date, independently of policy object identity. Both token limits must be present;
policy and legacy spending keys match case-insensitively. Legacy `spentToday`
totals can only raise the spending floor; an empty object cannot reset the ledger.

`createPaymentGuard(now?: () => Date)` is an additive export for an isolated
scope or a deterministic clock. Create it once in trusted application code and
reuse it for every authorization in that scope. Letting an agent create a fresh
guard would let it start a new budget. The default clock is the system clock.
Validation is pure internally; ledger validation and reservation run synchronously
without an await point, preventing interleaving within one guard instance.

The ledger is in memory only. Restarting the process clears it; separate instances,
module copies, workers, and processes do not share spending. It provides neither
persistent nor distributed enforcement. Previous UTC dates remain in memory for
the instance lifetime. Production enforcement across restarts or processes needs
a trusted persistent store with atomic reservations; none is included here.
