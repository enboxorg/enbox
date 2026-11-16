# Contacts

Address-book entries, communication details, and private information supplied about contacts.

Module URI: `https://enbox.id/modules/contacts/v1`

Import `ContactsModule`, `ContactsDefinition`, `ContactsCodecs`, and `ContactsSchemas` from `@enbox/modules/contacts`. `ContactsCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `contact` | [JSON Schema](schemas/contact.json) | Encrypted | Mutable |
| `contact/endpoint` | [JSON Schema](schemas/endpoint.json) | Encrypted | Mutable |
| `contact/interaction` | [JSON Schema](schemas/interaction.json) | Encrypted | Mutable |
| `group` | [JSON Schema](schemas/group.json) | Encrypted | Mutable |
| `group/entry` | [JSON Schema](schemas/entry.json) | Encrypted | Mutable |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `contact` | Owner only |
| `contact/endpoint` | Owner only |
| `contact/interaction` | Owner only |
| `group` | Owner only |
| `group/entry` | Owner only |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Capture contract

**Identity:** Match an existing selected contact or verified external identifier; names alone are not unique.

**Workflow:** Maintain private contact details and endpoints; link interactions to their actual event, conversation, or note.

**Exclude:** Replacing another person's self-published Profile with local address-book claims.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { ContactsModule } from '@enbox/modules/contacts';

const records = enbox.using(ContactsModule).records;
await records.create('contact', {
  data: {
  "displayName": "Alex Example"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
