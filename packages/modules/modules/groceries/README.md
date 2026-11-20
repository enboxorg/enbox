# Groceries

Shopping lists, items, quantities, units, stores, substitutions, and purchased state.

Module URI: `https://enbox.id/modules/groceries/v1`

Import `GroceriesModule`, `GroceriesDefinition`, `GroceriesCodecs`, and `GroceriesSchemas` from `@enbox/modules/groceries`. `GroceriesCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `list` | [JSON Schema](schemas/list.json) | Encrypted | Mutable |
| `list/item` | [JSON Schema](schemas/item.json) | Encrypted | Mutable |
| `list/editor` | [JSON Schema](schemas/editor.json) | Plaintext | Membership |
| `list/viewer` | [JSON Schema](schemas/viewer.json) | Plaintext | Membership |
| `space/list` | [JSON Schema](schemas/list.json) | Encrypted | Mutable |
| `space/list/item` | [JSON Schema](schemas/item.json) | Encrypted | Mutable |

## Dependencies and ownership

- `collaboration`: [Collaboration](../collaboration/README.md) — `https://enbox.id/modules/collaboration/v1`

Only concrete local child paths are writable through this module; attachment aliases remain owned by their providers.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `list` | role list/editor: read, co-update<br>role list/viewer: read |
| `list/item` | role list/editor: create, read, co-update, co-delete<br>role list/viewer: read |
| `list/editor` | recipient of list/editor: read<br>recipient of this record: co-delete |
| `list/viewer` | recipient of list/viewer: read<br>recipient of this record: co-delete |
| `space/list` | role collaboration:space/admin: create, read, co-update, co-delete<br>role collaboration:space/editor: create, read, co-update, delete<br>role collaboration:space/viewer: read |
| `space/list/item` | role collaboration:space/admin: create, read, co-update, co-delete<br>role collaboration:space/editor: create, read, co-update, co-delete<br>role collaboration:space/viewer: read |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Contract notes

- The same module and payload schemas support two ownership choices. Use list for an independent record or space/list when the user selects an existing Collaboration space. The selected space supplies its membership.

## Capture contract

**Identity:** Match the selected list and item, including quantity/variant distinctions.

**Workflow:** Record shopping intent, then update purchase state when known; link purchases and pantry items instead of copying their histories.

**Exclude:** Existing pantry inventory or an aspirational gift wishlist.

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
