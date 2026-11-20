# Debts and Loans

Money borrowed or lent, counterparties, agreed terms, balances, and repayments.

Module URI: `https://enbox.id/modules/debts-loans/v1`

Import `DebtsLoansModule`, `DebtsLoansDefinition`, `DebtsLoansCodecs`, and `DebtsLoansSchemas` from `@enbox/modules/debts-loans`. `DebtsLoansCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `loan` | [JSON Schema](schemas/loan.json) | Encrypted | Mutable |
| `loan/repayment` | [JSON Schema](schemas/repayment.json) | Encrypted | Immutable |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `loan` | Owner only |
| `loan/repayment` | Owner only |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Capture contract

**Identity:** Match the agreement and counterparties; similar amounts do not identify the same loan.

**Workflow:** Maintain terms and repayment evidence, linking actual transactions.

**Exclude:** Treating a planned repayment as a completed transfer.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { DebtsLoansModule } from '@enbox/modules/debts-loans';

const records = enbox.using(DebtsLoansModule).records;
await records.create('loan', {
  data: {
  "direction": "lent",
  "counterparty": "Alex",
  "principal": {
    "amount": "40",
    "currency": "GBP"
  },
  "state": "active"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
