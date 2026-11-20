# Credentials

Issuer-secured credential artifacts, local verification observations, and approved presentation history.

Module URI: `https://enbox.id/modules/credentials/v1`

Import `CredentialsModule`, `CredentialsDefinition`, `CredentialsCodecs`, and `CredentialsSchemas` from `@enbox/modules/credentials`. `CredentialsCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `credential` | [JSON Schema](schemas/credential.json) | Encrypted | Mutable |
| `credential/artifact` | application/octet-stream | Encrypted | Immutable |
| `credential/verification` | [JSON Schema](schemas/verification.json) | Encrypted | Immutable |
| `presentation` | [JSON Schema](schemas/presentation.json) | Encrypted | Mutable |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `credential` | Owner only |
| `credential/artifact` | Owner only |
| `credential/verification` | Owner only |
| `presentation` | Owner only |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Capture contract

**Identity:** Match native credential identifier, issuer, format and the selected immutable artifact.

**Workflow:** Preserve issuer-secured bytes; record verification and disclosure decisions separately from editable metadata.

**Exclude:** Creating a verifiable credential from OCR fields or a user assertion.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { CredentialsModule } from '@enbox/modules/credentials';

const records = enbox.using(CredentialsModule).records;
await records.create('credential', {
  data: {
  "label": "Self-issued demonstration membership",
  "format": "vc-jwt",
  "formatVersion": "2.0",
  "issuer": "did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6InhhLW01RjU1MU93LVFHRV9keXlsRjVGdUpDQkc4Y1VveDJsemF6VGd3ME0iLCJraWQiOiJSZFFfUThhbW1xUWw2Y0NPTnpLd1o2ajVoUUZodlZZNG52ZVRsRGdoWnRzIiwiYWxnIjoiRWREU0EifQ",
  "subjectIds": [
    "did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6InJNcERlUEM1NTBQT1ZYT2QtamlsQzVGVWZoeUhTLWlld01HZ3Z6TnlwRkEiLCJraWQiOiJRb0swZWg2UFdfa2JUcUdsdmNCalZPZHMzWmdQalJaVDVSRUN2Mm83Wlg0IiwiYWxnIjoiRWREU0EifQ"
  ],
  "credentialTypes": [
    "VerifiableCredential"
  ],
  "validFrom": "2026-01-01T00:00:00Z"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
