# Bookmarks

Saved web/DID-relative references, annotations, folders, and ordered entries.

Module URI: `https://enbox.id/modules/bookmarks/v1`

Import `BookmarksModule`, `BookmarksDefinition`, `BookmarksCodecs`, and `BookmarksSchemas` from `@enbox/modules/bookmarks`. `BookmarksCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `bookmark` | [JSON Schema](schemas/bookmark.json) | Encrypted | Mutable |
| `folder` | [JSON Schema](schemas/folder.json) | Encrypted | Mutable |
| `folder/entry` | [JSON Schema](schemas/entry.json) | Encrypted | Mutable |
| `bookmark/editor` | [JSON Schema](schemas/editor.json) | Plaintext | Membership |
| `bookmark/viewer` | [JSON Schema](schemas/viewer.json) | Plaintext | Membership |
| `folder/editor` | [JSON Schema](schemas/editor.json) | Plaintext | Membership |
| `folder/viewer` | [JSON Schema](schemas/viewer.json) | Plaintext | Membership |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. An editor can change shared content; a viewer can read the paths explicitly granting that role. Record-specific action lists remain authoritative.

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { BookmarksModule } from '@enbox/modules/bookmarks';

const records = enbox.using(BookmarksModule).records;
await records.create('bookmark', {
  data: {
  "title": "Example saved resource",
  "url": "https://example.com/article"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
