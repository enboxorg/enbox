# Financial Accounts

Financial account identity shared by ledger and portfolio applications.

Module URI: `https://enbox.id/modules/financial-accounts/v1`

Import `FinancialAccountsModule`, `FinancialAccountsDefinition`, `FinancialAccountsCodecs`, and `FinancialAccountsSchemas` from `@enbox/modules/financial-accounts`. `FinancialAccountsCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `account` | [JSON Schema](schemas/account.json) | Encrypted | Mutable |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `account` | Owner only |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Contract notes

- This module owns account identity and metadata. Transactions and Investment Holdings attach their own records; installing either does not require the other.
- A bank or brokerage account is distinct from a utility-service or online-login account.

## Capture contract

**Identity:** Use the selected account record; institution and lastFour narrow candidates but are not globally unique.

**Workflow:** Own financial account identity once; attach Transactions and Investment Holdings independently.

**Exclude:** Utility accounts, login accounts, or a duplicate account created separately for a portfolio.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { FinancialAccountsModule } from '@enbox/modules/financial-accounts';

const records = enbox.using(FinancialAccountsModule).records;
await records.create('account', {
  data: {
  "name": "Personal account",
  "kind": "bank",
  "currency": "USD"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
