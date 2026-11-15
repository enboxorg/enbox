# Belongings

Owned physical items, serial/model details, locations, acquisition records, and manuals.

Module URI: `https://enbox.id/modules/belongings/v1`

Import `BelongingsModule`, `BelongingsDefinition`, `BelongingsCodecs`, and `BelongingsSchemas` from `@enbox/modules/belongings`. `BelongingsCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `item` | [JSON Schema](schemas/item.json) | Encrypted | Mutable |
| `item/editor` | [JSON Schema](schemas/editor.json) | Plaintext | Membership |
| `item/viewer` | [JSON Schema](schemas/viewer.json) | Plaintext | Membership |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. An editor can change shared content; a viewer can read the paths explicitly granting that role. Record-specific action lists remain authoritative.

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { BelongingsModule } from '@enbox/modules/belongings';

const records = enbox.using(BelongingsModule).records;
await records.create('item', {
  data: {
  "name": "Washing machine",
  "manufacturer": "Example Appliances",
  "serialNumber": "ABC123",
  "state": "owned"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
