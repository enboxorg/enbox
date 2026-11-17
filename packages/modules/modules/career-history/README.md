# Career History

Jobs held and education attended, captured from the owner’s career timeline or résumé. Each work or education entry is a separately editable encrypted record.

Module URI: `https://enbox.id/modules/career-history/v1`

Import `CareerHistoryModule`, `CareerHistoryDefinition`, `CareerHistoryCodecs`, and `CareerHistorySchemas` from `@enbox/modules/career-history`. `CareerHistoryCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `work` | [JSON Schema](schemas/work.json) | Encrypted | Mutable |
| `education` | [JSON Schema](schemas/education.json) | Encrypted | Mutable |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `work` | Owner only |
| `education` | Owner only |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Contract notes

- Each work record maps to one work[] item and each education record to one education[] item in [JSON Resume v1.0.0](https://github.com/jsonresume/resume-schema/blob/v1.0.0/schema.json). Export selected records in the user’s preferred order.
- Work fields are name (employer), position, location, description (employer description), url, startDate, endDate, summary and highlights. Education fields are institution, area, studyType, url, startDate, endDate, score (text, preserving the grading scale) and courses.
- This profile requires the employer or institution name and accepts the standard named fields. An importer should surface extension fields or unsupported résumé sections for review and retain the source file if the user wants the original.
- An absent endDate means the user supplied no end date. Render current employment or a completed degree only when the user confirms it. Preserve year-only and month-only dates without guessing a day.

## Capture contract

**Identity:** Use the selected role or study record. Otherwise compare employer and position, or institution and program, together with the supplied period. Two roles at one employer and two programs at one school may be separate records. Ask when several match.

**Workflow:** Create one record for each stated role or period of study. Apply corrections to the matched entry, keeping dates at the precision given. Keep course lists and highlights inside their JSON Resume entry.

**Exclude:** “I hope to study geography” is a learning goal. “Remind me to apply” is a task. A question about a career path establishes neither work experience nor enrollment. A coworker’s biography belongs to their contact only with a separate explicit request. A signed qualification belongs in Credentials.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { CareerHistoryModule } from '@enbox/modules/career-history';

const records = enbox.using(CareerHistoryModule).records;
await records.create('work', {
  data: {
  "name": "Cedar Maps",
  "position": "Cartographer",
  "location": "Portland, Oregon",
  "startDate": "2020-09",
  "endDate": "2023",
  "summary": "Maintained walking maps and trail signage.",
  "highlights": [
    "Mapped 42 accessible trail entrances."
  ]
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
