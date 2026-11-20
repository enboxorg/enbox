# Files

File identity, metadata, content, and independently managed attachments.

Module URI: `https://enbox.id/modules/files/v1`

Import `FilesModule`, `FilesDefinition`, `FilesCodecs`, and `FilesSchemas` from `@enbox/modules/files`. `FilesCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `file` | [JSON Schema](schemas/file.json) | Encrypted | Mutable |
| `file/content` | application/octet-stream | Encrypted | Immutable |
| `file/editor` | [JSON Schema](schemas/editor.json) | Plaintext | Membership |
| `file/viewer` | [JSON Schema](schemas/viewer.json) | Plaintext | Membership |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `file` | role file/editor: read, co-update<br>role file/viewer: read |
| `file/content` | role file/editor: create, read, delete<br>role file/viewer: read |
| `file/editor` | recipient of file/editor: read<br>recipient of this record: co-delete |
| `file/viewer` | recipient of file/viewer: read<br>recipient of this record: co-delete |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Contract notes

- A viewer may read file metadata and content, or leave their own viewer assignment. Role recipients cannot remove other members; the owner controls membership.
- Editors may update shared file metadata, append immutable content revisions, and delete only their own revisions. They cannot delete or prune the file context and thereby erase other writers' revisions.
- currentContent is a link to the selected file/content revision. Clients verify the target type and parent context when resolving it; JSON Schema validates the link shape, not the existence or authority of its target.

## Capture contract

**Identity:** Match the selected file identity and known content digest; filenames alone are not unique.

**Workflow:** Store encrypted content revisions and update currentContent deliberately; verify its target and parent when resolving it.

**Exclude:** Copying a linked file merely because another module references it.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { FilesModule } from '@enbox/modules/files';

const records = enbox.using(FilesModule).records;
await records.create('file', {
  data: {
  "name": "example.txt",
  "mediaType": "text/plain",
  "byteLength": 5
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
