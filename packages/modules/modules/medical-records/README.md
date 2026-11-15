# Medical Records

Visit documents, test reports, immunizations, clinician details, and source evidence.

Module URI: `https://enbox.id/modules/medical-records/v1`

Import `MedicalRecordsModule`, `MedicalRecordsDefinition`, `MedicalRecordsCodecs`, and `MedicalRecordsSchemas` from `@enbox/modules/medical-records`. `MedicalRecordsCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `document` | [JSON Schema](schemas/document.json) | Encrypted | Mutable |
| `visit` | [JSON Schema](schemas/visit.json) | Encrypted | Mutable |
| `immunization` | [JSON Schema](schemas/immunization.json) | Encrypted | Mutable |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. An editor can change shared content; a viewer can read the paths explicitly granting that role. Record-specific action lists remain authoritative.

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { MedicalRecordsModule } from '@enbox/modules/medical-records';

const records = enbox.using(MedicalRecordsModule).records;
await records.create('document', {
  data: {
  "title": "Annual laboratory report",
  "kind": "lab-report"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
