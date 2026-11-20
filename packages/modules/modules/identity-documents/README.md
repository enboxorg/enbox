# Identity Documents

Identity documents issued to a person, including driving licences, passports, national IDs and state IDs. One record per issuance holds normalized fields and links to scans, extraction attempts and reviews.

Module URI: `https://enbox.id/modules/identity-documents/v1`

Import `IdentityDocumentsModule`, `IdentityDocumentsDefinition`, `IdentityDocumentsCodecs`, and `IdentityDocumentsSchemas` from `@enbox/modules/identity-documents`. `IdentityDocumentsCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
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

## Contract notes

- Use document for every government ID held by a person. documentType distinguishes passports, driving licences, national IDs and state IDs. fields.documentNumber is the printed identifier. fields.holder and fields.issuer describe the person and issuing body. Keep identifiers as strings.
- Only a driving licence may carry fields.drivingPrivileges, with the category, dates and restrictions as issued. Only a passport may carry fields.passportTypeCode. Country-specific details stay optional, enabling partial capture from chat.
- The holder, issuer, document number and dates can be mapped from the corresponding claims and document_details in the [OpenID Identity Assurance Schema Definition](https://openid.net/specs/openid-ida-verified-claims-1_0.html). This field mapping conveys no verification or trust-framework result.
- An extraction stores the original input references, time, extractor and observed fields. A review records the user’s decision and corrections. Apply approved changes to the document separately. Keep each attempt and decision so other apps can explain where a field came from.

## Capture contract

**Identity:** Match a selected issuance using kind, issuer and the reviewed document number. A renewal can have a new number or validity period. Ask before replacing a prior issuance when the match is ambiguous.

**Workflow:** Link source scans, retain extraction attempts, and record review/corrections before treating fields as reviewed.

**Exclude:** Vehicle plate and registration details describe the vehicle. Signed credentials and presentations belong in Credentials. A photo alone supplies evidence. Record user review separately from issuer verification.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { IdentityDocumentsModule } from '@enbox/modules/identity-documents';

const records = enbox.using(IdentityDocumentsModule).records;
await records.create('document', {
  data: {
  "label": "Driving licence",
  "documentType": "drivers-licence",
  "reviewState": "reviewed",
  "fields": {
    "holder": {
      "fullName": "Alex Example"
    },
    "issuer": {
      "name": "Example licensing authority",
      "region": "Example region"
    },
    "documentNumber": "000DEMO123",
    "expiryDate": "2031-04-15",
    "drivingPrivileges": [
      {
        "category": "B",
        "restrictions": [
          "Corrective lenses"
        ]
      }
    ]
  },
  "sources": [
    {
      "recordId": "example-scan"
    }
  ]
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
