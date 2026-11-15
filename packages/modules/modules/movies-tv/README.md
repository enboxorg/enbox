# Movies and TV

Films/series, watch intentions, episode progress, viewing history, and ratings.

Module URI: `https://enbox.id/modules/movies-tv/v1`

Import `MoviesTvModule`, `MoviesTvDefinition`, `MoviesTvCodecs`, and `MoviesTvSchemas` from `@enbox/modules/movies-tv`. `MoviesTvCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `title` | [JSON Schema](schemas/title.json) | Encrypted | Mutable |
| `title/viewing` | [JSON Schema](schemas/viewing.json) | Encrypted | Mutable |
| `title/rating` | [JSON Schema](schemas/rating.json) | Encrypted | Mutable |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. An editor can change shared content; a viewer can read the paths explicitly granting that role. Record-specific action lists remain authoritative.

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { MoviesTvModule } from '@enbox/modules/movies-tv';

const records = enbox.using(MoviesTvModule).records;
await records.create('title', {
  data: {
  "name": "Example series",
  "kind": "series",
  "state": "watching"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
