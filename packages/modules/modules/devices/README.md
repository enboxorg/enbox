# Devices

Personal device identity, configuration metadata, service history, and ownership/account references.

Module URI: `https://enbox.id/modules/devices/v1`

Import `DevicesModule`, `DevicesDefinition`, `DevicesCodecs`, and `DevicesSchemas` from `@enbox/modules/devices`. `DevicesCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `item/device` | [JSON Schema](schemas/device.json) | Encrypted | Mutable |
| `item/device/configuration` | [JSON Schema](schemas/configuration.json) | Encrypted | Mutable |

## Dependencies and ownership

- `belongings`: [Belongings](../belongings/README.md) — `https://enbox.id/modules/belongings/v1`

Only concrete local child paths are writable through this module; attachment aliases remain owned by their providers.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `item/device` | role belongings:item/editor: create, read, co-update<br>role belongings:item/viewer: read |
| `item/device/configuration` | role belongings:item/editor: create, read, co-update, co-delete<br>role belongings:item/viewer: read |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Contract notes

- The parent Belongings item owns name, manufacturer, model, serial number, and ownership state. Device data describes computing capabilities and operational state.
- Use Maintenance item/service records on that same Belongings item for repairs. Configuration records are timestamped snapshots; device fields describe current configuration.

## Capture contract

**Identity:** Resolve the existing Belongings item first.

**Workflow:** Store operational device details and dated configuration snapshots; use Belongings for identity and Maintenance for repairs.

**Exclude:** Duplicating manufacturer, model, serial number, ownership state, or maintenance history.

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
  "operatingState": "active"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
