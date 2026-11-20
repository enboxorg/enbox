# Profiles

The user's self-authored display identity, biography, images, and links.

Module URI: `https://identity.foundation/modules/profile`

Import `ProfileModule`, `ProfileDefinition`, `ProfileCodecs`, and `ProfileSchemas` from `@enbox/modules/profile`. `ProfileCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `profile` | [JSON Schema](schemas/profile.json) | Plaintext | Mutable |
| `profile/link` | [JSON Schema](schemas/link.json) | Plaintext | Mutable |
| `profile/avatar` | image/png, image/jpeg, image/gif, image/webp | Plaintext | Mutable |
| `profile/hero` | image/png, image/jpeg, image/gif, image/webp | Plaintext | Mutable |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `profile` | anyone: read |
| `profile/link` | anyone: read |
| `profile/avatar` | anyone: read |
| `profile/hero` | anyone: read |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Capture contract

**Identity:** Match the owner's self-published profile and selected profile links.

**Workflow:** Publish deliberate profile fields and media using the established public profile paths.

**Exclude:** Private contact-book annotations about other people.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { ProfileModule } from '@enbox/modules/profile';

const records = enbox.using(ProfileModule).records;
await records.create('profile', {
  data: {
  "displayName": "Alex Example",
  "bio": "Personal data, owned by people."
},
});
```

Profile retains the public definition and plain JSON/blob codecs shipped in @enbox/modules@0.2.124. The JSON Schemas describe the released fields; the codecs preserve existing records with extension fields. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
