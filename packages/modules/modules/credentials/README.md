# Credentials

Issuer-secured credential artifacts, local verification observations, and approved presentation history.

Module URI: `https://enbox.id/modules/credentials/v1`

Import `CredentialsModule`, `CredentialsDefinition`, `CredentialsCodecs`, and `CredentialsSchemas` from `@enbox/modules/credentials`. `CredentialsCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
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

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. An editor can change shared content; a viewer can read the paths explicitly granting that role. Record-specific action lists remain authoritative.

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

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
