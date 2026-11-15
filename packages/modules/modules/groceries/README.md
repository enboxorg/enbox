# Groceries

Shopping lists, items, quantities, units, stores, substitutions, and purchased state.

Module URI: `https://enbox.id/modules/groceries/v1`

Import `GroceriesModule`, `GroceriesDefinition`, `GroceriesCodecs`, and `GroceriesSchemas` from `@enbox/modules/groceries`. `GroceriesCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `list` | [JSON Schema](schemas/list.json) | Encrypted | Mutable |
| `list/item` | [JSON Schema](schemas/item.json) | Encrypted | Mutable |
| `list/editor` | [JSON Schema](schemas/editor.json) | Plaintext | Membership |
| `list/viewer` | [JSON Schema](schemas/viewer.json) | Plaintext | Membership |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `list` | role list/editor: read, co-update<br>role list/viewer: read |
| `list/item` | role list/editor: create, read, co-update, co-delete<br>role list/viewer: read |
| `list/editor` | recipient of list/editor: read<br>recipient of this record: co-delete |
| `list/viewer` | recipient of list/viewer: read<br>recipient of this record: co-delete |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { GroceriesModule } from '@enbox/modules/groceries';

const records = enbox.using(GroceriesModule).records;
await records.create('list', {
  data: {
  "name": "Weekly groceries"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
