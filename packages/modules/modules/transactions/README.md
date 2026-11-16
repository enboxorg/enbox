# Transactions

Personal income, expenses, transfers, amounts, currencies, dates, and counterparties.

Module URI: `https://enbox.id/modules/transactions/v1`

Import `TransactionsModule`, `TransactionsDefinition`, `TransactionsCodecs`, and `TransactionsSchemas` from `@enbox/modules/transactions`. `TransactionsCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `account/transaction` | [JSON Schema](schemas/transaction.json) | Encrypted | Mutable |

## Dependencies and ownership

- `accounts`: [Financial Accounts](../financial-accounts/README.md) — `https://enbox.id/modules/financial-accounts/v1`

Only concrete local child paths are writable through this module; attachment aliases remain owned by their providers.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `account/transaction` | Owner only |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Contract notes

- Create the account with Financial Accounts, then append ledger entries using its contextId. Portfolio apps can use the same account without installing this ledger module.

## Capture contract

**Identity:** Match the Financial Accounts parent and imported transaction identifier or selected ledger entry.

**Workflow:** Record actual ledger facts and link supporting receipts; do not create a second account identity.

**Exclude:** A bill, budget target, wishlist interest or position snapshot as a completed movement of money.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

Supply the existing direct parent record's `contextId` as `parentContextId`.

```ts
import { TransactionsModule } from '@enbox/modules/transactions';

const records = enbox.using(TransactionsModule).records;
await records.create('account/transaction', {
  parentContextId,
  data: {
  "kind": "expense",
  "amount": {
    "amount": "42",
    "currency": "GBP"
  },
  "occurredAt": "2026-01-15T12:00:00Z",
  "category": "groceries"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
