# Pantry

Food on hand, quantities, storage locations, expiry dates, and stock changes.

Module URI: `https://enbox.id/modules/pantry/v1`

Import `PantryModule`, `PantryDefinition`, `PantryCodecs`, and `PantrySchemas` from `@enbox/modules/pantry`. `PantryCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `pantry` | [JSON Schema](schemas/pantry.json) | Encrypted | Mutable |
| `pantry/item` | [JSON Schema](schemas/item.json) | Encrypted | Mutable |
| `pantry/item/change` | [JSON Schema](schemas/change.json) | Encrypted | Immutable |
| `pantry/editor` | [JSON Schema](schemas/editor.json) | Plaintext | Membership |
| `pantry/viewer` | [JSON Schema](schemas/viewer.json) | Plaintext | Membership |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `pantry` | role pantry/editor: read, co-update<br>role pantry/viewer: read |
| `pantry/item` | role pantry/editor: create, read, co-update<br>role pantry/viewer: read |
| `pantry/item/change` | role pantry/editor: create, read, delete<br>role pantry/viewer: read |
| `pantry/editor` | recipient of pantry/editor: read<br>recipient of this record: co-delete |
| `pantry/viewer` | recipient of pantry/viewer: read<br>recipient of this record: co-delete |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { PantryModule } from '@enbox/modules/pantry';

const records = enbox.using(PantryModule).records;
await records.create('pantry', {
  data: {
  "name": "Kitchen pantry"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
