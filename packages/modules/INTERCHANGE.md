# Personal data interchange

## Contacts and calendars

The `@enbox/modules/interchange` entry point converts parsed JSON into validated
DWN payloads and back. Import is a pure preparation step. Review the result,
match the external identity to an existing record, and submit any writes with
the user's selected authority. For a contact, write each endpoint beneath the
matching contact's `contextId`.

| JSON document | Standard fields | Enbox destination |
| --- | --- | --- |
| jCard 4.0 | UID, FN, N (family and given names), single-component ORG, full-date BDAY, NOTE | `contacts/contact` |
| jCard 4.0 | Repeated EMAIL, TEL and URL with a single TYPE and optional PREF=1 | One `contact/endpoint` per property |
| jCal 2.0 | VEVENT UID, DTSTAMP, SUMMARY, DTSTART, DTEND, LOCATION, DESCRIPTION | One `events/event` per VEVENT |

```ts
import { importJCard, exportJCard, importJCal, exportJCal } from '@enbox/modules/interchange';

const { contact, endpoints, uid } = await importJCard(JSON.parse(addressBookJson));
const cardJson = JSON.stringify(await exportJCard({ contact, endpoints, uid }));

const calendar = await importJCal(JSON.parse(calendarJson));
const { event, uid: eventUid, dtstamp } = calendar.events[0];
const resultJson = JSON.stringify(await exportJCal(calendar));
```

Contact payloads retain `vcardUid`; event payloads retain `calendarUid` and
`calendarDtstamp`. After reading the stored root and any endpoint children,
`exportJCard({contact, endpoints})` and `exportJCal({productId, events: [{event}]})`
use those persisted identifiers. Select the import source and match its UID
when updating an existing record. The caller supplies the calendar-level PRODID.
For contacts without a UID, match the intended record before a repeat import.
Local roles, sharing and object IDs never come from the imported UID.

The calendar profile handles whole-second UTC instants and all-day dates.
`endsOn` is the exclusive DTEND date. A Friday-through-Sunday event ends on
Monday. A single-day event may omit DTEND. For a new event the caller supplies a new UID and DTSTAMP. The exporter checks
explicit overrides against the stored metadata. GREGORIAN is the
default scale and the exporter omits a redundant explicit CALSCALE.

The adapters reject extra properties and unsupported values so callers can
surface a specific import error and retain the original file. Recurrence,
floating or TZID-based times, alarms, participant records, partial birthdays,
multiple endpoint preference ranks, and enriched contact addresses require a
broader mapping. Exporters accept explicitly selected fields for this profile.
Independent DWN records such as event responses and contact interactions remain
under application control. Property ordering, empty structured name components,
and an absent preference can normalize on export.

The property arrays and value types follow [jCard (RFC 7095)](https://www.rfc-editor.org/rfc/rfc7095.html)
and [jCal (RFC 7265)](https://www.rfc-editor.org/rfc/rfc7265.html). The underlying
identity, preference and event duration rules come from [vCard 4.0 (RFC 6350)](https://www.rfc-editor.org/rfc/rfc6350.html)
and [iCalendar (RFC 5545)](https://www.rfc-editor.org/rfc/rfc5545.html).

## Places

`importPlaceFeature` maps one named GeoJSON Feature with Point geometry to
`places/place`. Coordinates are ordered longitude, latitude, and optional
altitude in meters. Feature properties must be representable place fields and
include the name. `exportPlaceFeature` requires coordinates and preserves supplied
place metadata in properties. Extra feature members, alternate geometry and
out-of-range positions raise errors. [GeoJSON (RFC 7946)](https://www.rfc-editor.org/rfc/rfc7946.html)

## Career history

`importJsonResume` validates each named employer or institution in the
`work[]` and `education[]` sections, preserving partial dates as supplied.
Keep its returned `otherSections` with the imported document and pass them to
`exportJsonResume` to preserve unrelated sections. The caller selects the
order of records in the exported arrays. Unknown fields inside either supported
entry are reported with the offending index. [JSON Resume v1.0.0](https://github.com/jsonresume/resume-schema/blob/v1.0.0/schema.json)

## Recipes

`importRecipeJsonLd` and `exportRecipeJsonLd` convert ingredient lines, structured
quantities, ordered instructions, durations and yields. Both return the paths
of omitted fields for review. [Recipe interchange profile](RECIPE-INTERCHANGE.md)

The [additional field crosswalks](directory/crosswalks.json) cover Schema.org, iCalendar VTODO and HL7 FHIR R4. Each entry documents the value conversions and missing context an integration must handle.
