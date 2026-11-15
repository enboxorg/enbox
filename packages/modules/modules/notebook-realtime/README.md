# Notebook Realtime

Optional live collaboration attached to an existing notebook page. Owner-managed encrypted rendezvous metadata and writer-authored session records reuse notebook page roles.

Module URI: `https://enbox.id/modules/notebook-realtime/v1`

Import `NotebookRealtimeModule`, `NotebookRealtimeDefinition`, `NotebookRealtimeCodecs`, and `NotebookRealtimeSchemas` from `@enbox/modules/notebook-realtime`. `NotebookRealtimeCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `page/live` | [JSON Schema](schemas/live.json) | Encrypted | Mutable |
| `page/live/session` | [JSON Schema](schemas/session.json) | Plaintext | Immutable |

## Dependencies and ownership

- `notebook`: [Notebook](../notebook/README.md) — `https://enbox.id/modules/notebook/v1`

Only concrete local child paths are writable through this module; attachment aliases remain owned by their providers.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `page/live` | role notebook:notebook/page/admin: read<br>role notebook:notebook/page/editor: read<br>role notebook:notebook/page/viewer: read |
| `page/live/session` | role notebook:notebook/page/admin: create, delete, read<br>role notebook:notebook/page/editor: create, delete, read<br>role notebook:notebook/page/viewer: read |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Contract notes

- This module owns page/live and page/live/session only. page is an attachment to notebook:notebook/page, not a copied page record.
- The page owner maintains the singleton encrypted live advertisement. Editors and administrators create/delete their own plaintext session records; viewers only read. Session peerKey is public descriptor-adjacent routing metadata and must never contain a private key.
- Rendezvous fields are transport-neutral strings. Clients validate their chosen transport and generate fresh keys and topics; example values are illustrative, not usable secrets.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

Supply the existing direct parent record's `contextId` as `parentContextId`.

```ts
import { NotebookRealtimeModule } from '@enbox/modules/notebook-realtime';

const records = enbox.using(NotebookRealtimeModule).records;
await records.create('page/live', {
  parentContextId,
  data: {
  "transport": "nostr",
  "endpoint": "wss://relay.example.com",
  "topic": "demo-page-topic",
  "topicKey": "ZGVtby1vbmx5LW5vdC1hLXJlYWwtc2VjcmV0",
  "peerKey": "demo-owner-peer"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
