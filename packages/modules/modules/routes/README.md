# Routes

Planned routes or recorded tracks, waypoints, travel mode, and relevant geometry.

Module URI: `https://enbox.id/modules/routes/v1`

Import `RoutesModule`, `RoutesDefinition`, `RoutesCodecs`, and `RoutesSchemas` from `@enbox/modules/routes`. `RoutesCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `route` | [JSON Schema](schemas/route.json) | Encrypted | Mutable |
| `route/waypoint` | [JSON Schema](schemas/waypoint.json) | Encrypted | Mutable |
| `route/track` | [JSON Schema](schemas/track.json) | Encrypted | Immutable |
| `route/editor` | [JSON Schema](schemas/editor.json) | Plaintext | Membership |
| `route/viewer` | [JSON Schema](schemas/viewer.json) | Plaintext | Membership |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `route` | role route/editor: read, co-update<br>role route/viewer: read |
| `route/waypoint` | role route/editor: create, read, co-update, co-delete<br>role route/viewer: read |
| `route/track` | role route/editor: create, read, delete<br>role route/viewer: read |
| `route/editor` | recipient of route/editor: read<br>recipient of this record: co-delete |
| `route/viewer` | recipient of route/viewer: read<br>recipient of this record: co-delete |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { RoutesModule } from '@enbox/modules/routes';

const records = enbox.using(RoutesModule).records;
await records.create('route', {
  data: {
  "name": "Station to hotel",
  "mode": "walk"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
