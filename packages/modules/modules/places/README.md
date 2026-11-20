# Places

Saved locations, addresses, coordinates, and personal annotations.

Module URI: `https://enbox.id/modules/places/v1`

Import `PlacesModule`, `PlacesDefinition`, `PlacesCodecs`, and `PlacesSchemas` from `@enbox/modules/places`. `PlacesCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `place` | [JSON Schema](schemas/place.json) | Encrypted | Mutable |
| `place/editor` | [JSON Schema](schemas/editor.json) | Plaintext | Membership |
| `place/viewer` | [JSON Schema](schemas/viewer.json) | Plaintext | Membership |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `place` | role place/editor: read, co-update<br>role place/viewer: read |
| `place/editor` | recipient of place/editor: read<br>recipient of this record: co-delete |
| `place/viewer` | recipient of place/viewer: read<br>recipient of this record: co-delete |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Capture contract

**Identity:** Match coordinates, address or a qualified external place identifier.

**Workflow:** Maintain place metadata and links; keep events and route observations in their own records.

**Exclude:** A planned visit as proof of being at a place.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { PlacesModule } from '@enbox/modules/places';

const records = enbox.using(PlacesModule).records;
await records.create('place', {
  data: {
  "name": "Riverside cafe",
  "coordinates": {
    "latitude": 38.7223,
    "longitude": -9.1393
  }
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
