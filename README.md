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

Initialize once in trusted application code with policy from trusted configuration:

```ts
import { createPaymentGuard } from "./src/checkPayment.ts";

const checkPayment = createPaymentGuard({
  maxPerPayment: { USDC: 50 },
  dailyLimit: { USDC: 100 },
  knownAddresses: ["alice.near"],
});

// Expose only this operation to the agent, using the same guard each time.
const decision = checkPayment({ to: "alice.near", amount: 10, token: "USDC" });
```

`createPaymentGuard(policy, clock?)` copies and freezes the policy, including both
limit objects and the address allowlist. Later caller mutations cannot change it.
The optional clock defaults to the system clock and must also be trusted.
Checks always use this bound policy. Do not let an agent choose initialization
configuration or create replacement guards: a new guard starts a new budget.

This is a breaking API change: the module-level `checkPayment` export is removed,
and the factory now requires a policy before its optional clock. Migrate
`checkPayment(payment, policy, spentToday?)` to a reused initialized guard and
`checkPayment(payment, spentToday?)`. There is no payment-time policy parameter.
Both token limits must be present; policy and spending keys match
case-insensitively. Optional `spentToday` totals can only raise the spending floor;
an empty object cannot reset the internal ledger. Validation and reservation run
synchronously without an await point within one guard instance.

The application must enforce every actual transfer through the guard and keep
signing credentials and execution authority outside agent control. This library
returns a decision; it does not execute or enforce blockchain transfers.

The ledger is in memory only. Restarting the process clears it; separate instances,
module copies, workers, and processes do not share spending. It provides neither
persistent nor distributed enforcement. Previous UTC dates remain in memory for
the instance lifetime. Production enforcement across restarts or processes needs
a trusted persistent store with atomic reservations; none is included here.
