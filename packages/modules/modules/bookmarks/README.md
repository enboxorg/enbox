# Bookmarks

Saved web/DID-relative references, annotations, folders, and ordered entries.

Module URI: `https://enbox.id/modules/bookmarks/v1`

Import `BookmarksModule`, `BookmarksDefinition`, `BookmarksCodecs`, and `BookmarksSchemas` from `@enbox/modules/bookmarks`. `BookmarksCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
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

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `bookmark` | role bookmark/editor: read, co-update<br>role bookmark/viewer: read |
| `folder` | role folder/editor: read, co-update<br>role folder/viewer: read |
| `folder/entry` | role folder/editor: create, read, co-update, co-delete<br>role folder/viewer: read |
| `bookmark/editor` | recipient of bookmark/editor: read<br>recipient of this record: co-delete |
| `bookmark/viewer` | recipient of bookmark/viewer: read<br>recipient of this record: co-delete |
| `folder/editor` | recipient of folder/editor: read<br>recipient of this record: co-delete |
| `folder/viewer` | recipient of folder/viewer: read<br>recipient of this record: co-delete |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Capture contract

**Identity:** Match the saved URL or tenant-relative record target and the user's selected bookmark.

**Workflow:** Save references and reading intent; organize existing bookmarks with folder entries.

**Exclude:** The contents of the linked document or an authorization grant to it.

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
