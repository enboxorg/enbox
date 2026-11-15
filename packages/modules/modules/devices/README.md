# Devices

Personal device identity, configuration metadata, service history, and ownership/account references.

Module URI: `https://enbox.id/modules/devices/v1`

Import `DevicesModule`, `DevicesDefinition`, `DevicesCodecs`, and `DevicesSchemas` from `@enbox/modules/devices`. `DevicesCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `item/device` | [JSON Schema](schemas/device.json) | Encrypted | Mutable |
| `item/device/configuration` | [JSON Schema](schemas/configuration.json) | Encrypted | Mutable |
| `item/device/service` | [JSON Schema](schemas/service.json) | Encrypted | Immutable |

## Dependencies and ownership

- `belongings`: [Belongings](../belongings/README.md) — `https://enbox.id/modules/belongings/v1`

Only concrete local child paths are writable through this module; attachment aliases remain owned by their providers.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. An editor can change shared content; a viewer can read the paths explicitly granting that role. Record-specific action lists remain authoritative.

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

Supply the existing direct parent record's `contextId` as `parentContextId`.

```ts
import { DevicesModule } from '@enbox/modules/devices';

const records = enbox.using(DevicesModule).records;
await records.create('item/device', {
  parentContextId,
  data: {
  "kind": "computer",
  "state": "active",
  "model": "Example Laptop"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
