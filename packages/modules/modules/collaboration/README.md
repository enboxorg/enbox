# Collaboration

An optional shared context and membership roster for independently installed feature modules.

Module URI: `https://enbox.id/modules/collaboration/v1`

Import `CollaborationModule`, `CollaborationDefinition`, `CollaborationCodecs`, and `CollaborationSchemas` from `@enbox/modules/collaboration`. `CollaborationCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `space` | [JSON Schema](schemas/space.json) | Encrypted | Mutable |
| `space/admin` | [JSON Schema](schemas/admin.json) | Plaintext | Membership |
| `space/editor` | [JSON Schema](schemas/editor.json) | Plaintext | Membership |
| `space/viewer` | [JSON Schema](schemas/viewer.json) | Plaintext | Membership |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `space` | role space/admin: read, co-update<br>role space/editor: read<br>role space/viewer: read |
| `space/admin` | recipient of space/admin: read<br>recipient of this record: co-delete |
| `space/editor` | recipient of space/editor: read<br>recipient of this record: co-delete |
| `space/viewer` | recipient of space/viewer: read<br>recipient of this record: co-delete |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Contract notes

- A space is a membership and lifecycle boundary, not a folder or bookmark collection. Use it only when attached features should share the same roster.
- The owner issues and revokes membership and prunes spaces. An admin can update space metadata; feature modules explicitly declare any additional content authority. Admin does not inherit editor permissions.
- Roles are plaintext empty assignments; recipients may leave their own role. The encrypted space metadata is readable by its contextual admin, editor, and viewer roles.
- Use @enbox/contexts defineContextModule(CollaborationModule) for invitations and follow journals; those companions are not duplicated here.

## Capture contract

**Identity:** Use the explicitly selected shared space record; its name alone is not unique.

**Workflow:** Create a deliberate membership/lifecycle boundary; the owner manages roles and each feature declares its own access.

**Exclude:** A bookmark folder or a request to grant membership inferred from conversation text.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { CollaborationModule } from '@enbox/modules/collaboration';

const records = enbox.using(CollaborationModule).records;
await records.create('space', {
  data: {
  "name": "Our household"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
