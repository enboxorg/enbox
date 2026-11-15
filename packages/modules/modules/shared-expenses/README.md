# Shared Expenses

Participants, shared costs, allocation shares, and settlements.

Module URI: `https://enbox.id/modules/shared-expenses/v1`

Import `SharedExpensesModule`, `SharedExpensesDefinition`, `SharedExpensesCodecs`, and `SharedExpensesSchemas` from `@enbox/modules/shared-expenses`. `SharedExpensesCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `group` | [JSON Schema](schemas/group.json) | Encrypted | Mutable |
| `group/expense` | [JSON Schema](schemas/expense.json) | Encrypted | Mutable |
| `group/settlement` | [JSON Schema](schemas/settlement.json) | Encrypted | Immutable |
| `group/editor` | [JSON Schema](schemas/editor.json) | Plaintext | Membership |
| `group/viewer` | [JSON Schema](schemas/viewer.json) | Plaintext | Membership |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `group` | role group/editor: read<br>role group/viewer: read |
| `group/expense` | role group/editor: create, read, update, delete<br>role group/viewer: read |
| `group/settlement` | role group/editor: create, read, delete<br>role group/viewer: read |
| `group/editor` | recipient of group/editor: read<br>recipient of this record: co-delete |
| `group/viewer` | recipient of group/viewer: read<br>recipient of this record: co-delete |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Contract notes

- The owner maintains the group participant roster. Editors record, update, and delete expenses they authored; settlements are immutable and only their author or the owner may delete them.
- Payer and participant IDs are claims within an authored expense, not signatures by those participants. Applications reconcile shares, currencies, totals, and participant membership before treating a record as an agreed balance.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { SharedExpensesModule } from '@enbox/modules/shared-expenses';

const records = enbox.using(SharedExpensesModule).records;
await records.create('group', {
  data: {
  "name": "Weekend trip",
  "participants": [
    {
      "id": "alex",
      "name": "Alex"
    },
    {
      "id": "sam",
      "name": "Sam"
    }
  ]
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
