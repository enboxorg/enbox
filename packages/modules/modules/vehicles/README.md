# Vehicles

Cars/bikes, identifiers, mileage, fuel or charging logs, and document/service references.

Module URI: `https://enbox.id/modules/vehicles/v1`

Import `VehiclesModule`, `VehiclesDefinition`, `VehiclesCodecs`, and `VehiclesSchemas` from `@enbox/modules/vehicles`. `VehiclesCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `item/vehicle` | [JSON Schema](schemas/vehicle.json) | Encrypted | Mutable |
| `item/vehicle/odometer` | [JSON Schema](schemas/odometer.json) | Encrypted | Immutable |
| `item/vehicle/energy` | [JSON Schema](schemas/energy.json) | Encrypted | Immutable |

## Dependencies and ownership

- `belongings`: [Belongings](../belongings/README.md) — `https://enbox.id/modules/belongings/v1`

Only concrete local child paths are writable through this module; attachment aliases remain owned by their providers.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `item/vehicle` | role belongings:item/editor: create, read, co-update<br>role belongings:item/viewer: read |
| `item/vehicle/odometer` | role belongings:item/editor: create, read, delete<br>role belongings:item/viewer: read |
| `item/vehicle/energy` | role belongings:item/editor: create, read, delete<br>role belongings:item/viewer: read |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

Supply the existing direct parent record's `contextId` as `parentContextId`.

```ts
import { VehiclesModule } from '@enbox/modules/vehicles';

const records = enbox.using(VehiclesModule).records;
await records.create('item/vehicle', {
  parentContextId,
  data: {
  "kind": "car",
  "make": "Example Motors",
  "model": "City"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
