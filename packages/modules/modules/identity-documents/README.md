# Identity Documents

Structured ID/passport/licence fields, scan references, extraction provenance, and reviewed corrections.

Module URI: `https://enbox.id/modules/identity-documents/v1`

Import `IdentityDocumentsModule`, `IdentityDocumentsDefinition`, `IdentityDocumentsCodecs`, and `IdentityDocumentsSchemas` from `@enbox/modules/identity-documents`. `IdentityDocumentsCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `document` | [JSON Schema](schemas/document.json) | Encrypted | Mutable |
| `document/extraction` | [JSON Schema](schemas/extraction.json) | Encrypted | Immutable |
| `document/review` | [JSON Schema](schemas/review.json) | Encrypted | Immutable |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `document` | Owner only |
| `document/extraction` | Owner only |
| `document/review` | Owner only |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { IdentityDocumentsModule } from '@enbox/modules/identity-documents';

const records = enbox.using(IdentityDocumentsModule).records;
await records.create('document', {
  data: {
  "label": "Personal passport",
  "documentType": "passport",
  "reviewState": "unreviewed",
  "fields": {
    "fullName": "Alex Example",
    "documentNumber": "EXAMPLE123",
    "issuingCountry": "GBR"
  }
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
