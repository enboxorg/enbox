# Notebook

Notes, drafts, and research using the notesd notebook/page hierarchy, immutable CRDT updates, encrypted attachment envelopes, and page-scoped roles.

Module URI: `https://enbox.id/modules/notebook/v1`

Import `NotebookModule`, `NotebookDefinition`, `NotebookCodecs`, and `NotebookSchemas` from `@enbox/modules/notebook`. `NotebookCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `notebook` | [JSON Schema](schemas/notebook.json) | Encrypted | Mutable |
| `notebook/page` | [JSON Schema](schemas/page.json) | Encrypted | Mutable |
| `notebook/page/delta` | application/octet-stream | Encrypted | Immutable |
| `notebook/page/attachment` | file-envelope | Encrypted | Immutable |
| `notebook/page/admin` | [JSON Schema](schemas/admin.json) | Plaintext | Membership |
| `notebook/page/editor` | [JSON Schema](schemas/editor.json) | Plaintext | Membership |
| `notebook/page/viewer` | [JSON Schema](schemas/viewer.json) | Plaintext | Membership |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `notebook` | Owner only |
| `notebook/page` | role notebook/page/admin: read<br>role notebook/page/editor: read<br>role notebook/page/viewer: read |
| `notebook/page/delta` | role notebook/page/admin: create, squash, read<br>role notebook/page/editor: create, read<br>role notebook/page/viewer: read |
| `notebook/page/attachment` | role notebook/page/admin: create, delete, read<br>role notebook/page/editor: create, delete, read<br>role notebook/page/viewer: read |
| `notebook/page/admin` | recipient of this record: co-delete<br>role notebook/page/admin: read<br>role notebook/page/editor: read<br>role notebook/page/viewer: read |
| `notebook/page/editor` | recipient of this record: co-delete<br>role notebook/page/admin: read<br>role notebook/page/editor: read<br>role notebook/page/viewer: read |
| `notebook/page/viewer` | recipient of this record: co-delete |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Contract notes

- Wire definition matches notesd commit 377645c881b0d1a86710130957cc5d583b249c8f. Schema identities, paths, size limits, actions, and binary representations are preserved.
- The page record holds stable metadata; its owner changes the title and page state. Editors append CRDT updates; administrators may additionally squash the log. Notebook metadata is owner-only.
- Delta bytes are @enbox/crdt yjs1 frames, not Markdown or raw Yjs updates. Use @enbox/crdt to apply, materialize, and compact them.
- Attachment values are { filename, mimeType, blob }. The notesd file envelope packages metadata with the bytes in one encrypted record, with a 50,000,000-byte content limit. Its schema URI identifies a binary contract; it is not a JSON Schema.
- Page members can read administrator/editor assignments to authenticate live writers. The viewer roster remains private. The recipient may leave an assignment without invoking a moduleRole; the owner manages membership.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { NotebookModule } from '@enbox/modules/notebook';

const records = enbox.using(NotebookModule).records;
await records.create('notebook', {
  data: {
  "name": "Personal notes"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
