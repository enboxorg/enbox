# @enbox/modules

> **Research Preview** — Enbox is under active development. Module contracts are versioned; APIs may change.

Complete reusable modules for personal DWN data. Each module has its own
[artifact directory](modules/index.json), containing a raw definition, strict
JSON Schemas, capture metadata, valid examples, and usage documentation. Typed
exports include literal definitions, data types, validating codecs, and explicit
dependency artifacts.

## Installation and use

```bash
bun add @enbox/modules
```

Prefer individual subpaths for applications using a small subset:

```ts
import { defineApplicationManifest } from '@enbox/api';
import { GroceriesModule } from '@enbox/modules/groceries';

const application = defineApplicationManifest({ modules: [GroceriesModule] });
// Register application in your connection store and obtain a connected enbox.
const groceries = enbox.using(GroceriesModule);
const list = await groceries.records.create('list', {
  data: { name: 'Weekly groceries' },
});
const item = await groceries.records.create('list/item', {
  parentContextId: list.contextId,
  data: {
    name: 'Lemons',
    state: 'needed',
    quantity: { value: '2', unit: 'piece' },
  },
});
await item.update({ data: { name: 'Lemons', state: 'purchased' } });
```

Named module exports are also available from the package root. Data-type aliases
at the root are prefixed by the module name, such as `GroceriesItemData`; the
individual subpath exports the local `ItemData` name.

```ts
import { GroceriesModule, type GroceriesItemData } from '@enbox/modules';
import type { ItemData } from '@enbox/modules/groceries';
```

## Module library

### Optional shared contexts

| Module | Import subpath | Records |
| --- | --- | --- |
| [Collaboration](modules/collaboration/README.md) | `@enbox/modules/collaboration` | `space` and contextual membership |
| [Shared Groceries](modules/shared-groceries/README.md) | `@enbox/modules/shared-groceries` | `space/list`, `space/list/item` |
| [Shared Meal Plans](modules/shared-meal-plans/README.md) | `@enbox/modules/shared-meal-plans` | `space/plan`, `space/plan/meal` |
| [Shared Tasks](modules/shared-tasks/README.md) | `@enbox/modules/shared-tasks` | `space/task`, `space/task/checklistItem` |

Use these variants when the user selects a common membership boundary. Standalone
Groceries, Meal Plans and Tasks keep their independent contextual roles. A fact
belongs in the selected variant; applications should not write both copies.

### Home and belongings

| Module | Import subpath | Records |
| --- | --- | --- |
| [Belongings](modules/belongings/README.md) | `@enbox/modules/belongings` | `item` |
| [Housing](modules/housing/README.md) | `@enbox/modules/housing` | `residence`, `residence/occupancy`, `residence/lease` |
| [Maintenance](modules/maintenance/README.md) | `@enbox/modules/maintenance` | `item/plan`, `item/service` |
| [Pet Care](modules/pet-care/README.md) | `@enbox/modules/pet-care` | `pet`, `pet/care`, `pet/vetRecord` |
| [Plants](modules/plants/README.md) | `@enbox/modules/plants` | `plant`, `plant/care` |
| [Utilities](modules/utilities/README.md) | `@enbox/modules/utilities` | `account`, `account/meter`, `account/meter/reading` |
| [Vehicles](modules/vehicles/README.md) | `@enbox/modules/vehicles` | `item/vehicle`, `item/vehicle/odometer`, `item/vehicle/energy` |
| [Warranties](modules/warranties/README.md) | `@enbox/modules/warranties` | `item/warranty`, `item/warranty/claim` |

### Money and investing

| Module | Import subpath | Records |
| --- | --- | --- |
| [Bills](modules/bills/README.md) | `@enbox/modules/bills` | `bill`, `bill/payment` |
| [Budgets](modules/budgets/README.md) | `@enbox/modules/budgets` | `budget`, `budget/allocation` |
| [Debts and Loans](modules/debts-loans/README.md) | `@enbox/modules/debts-loans` | `loan`, `loan/repayment` |
| [Financial Accounts](modules/financial-accounts/README.md) | `@enbox/modules/financial-accounts` | `account` |
| [Investment Holdings](modules/investment-holdings/README.md) | `@enbox/modules/investment-holdings` | `account/position`, `account/position/lot`, `account/position/trade` |
| [Receipts](modules/receipts/README.md) | `@enbox/modules/receipts` | `receipt`, `receipt/item`, `receipt/extraction` |
| [Shared Expenses](modules/shared-expenses/README.md) | `@enbox/modules/shared-expenses` | `group`, `group/expense`, `group/settlement` |
| [Stock Watchlists](modules/stock-watchlists/README.md) | `@enbox/modules/stock-watchlists` | `watchlist`, `watchlist/instrument`, `watchlist/instrument/note` |
| [Subscriptions](modules/subscriptions/README.md) | `@enbox/modules/subscriptions` | `subscription`, `subscription/change` |
| [Transactions](modules/transactions/README.md) | `@enbox/modules/transactions` | `account/transaction` |

### General personal records

| Module | Import subpath | Records |
| --- | --- | --- |
| [Bookmarks](modules/bookmarks/README.md) | `@enbox/modules/bookmarks` | `bookmark`, `folder`, `folder/entry` |
| [Files](modules/files/README.md) | `@enbox/modules/files` | `file`, `file/content` |
| [Notebook](modules/notebook/README.md) | `@enbox/modules/notebook` | `notebook`, `notebook/page`, `notebook/page/delta`, `notebook/page/attachment` |
| [Notebook Realtime](modules/notebook-realtime/README.md) | `@enbox/modules/notebook-realtime` | `page/live`, `page/live/session` |
| [Tasks](modules/tasks/README.md) | `@enbox/modules/tasks` | `task`, `task/checklistItem`, `state` |
| [Time Entries](modules/time-entries/README.md) | `@enbox/modules/time-entries` | `entry` |

### Media and learning

| Module | Import subpath | Records |
| --- | --- | --- |
| [Books](modules/books/README.md) | `@enbox/modules/books` | `book`, `book/reading`, `book/highlight`, `book/review` |
| [Flashcards](modules/flashcards/README.md) | `@enbox/modules/flashcards` | `card`, `deck`, `deck/entry`, `studySet`, `studySet/cardState`, `studySet/cardState/review` |
| [Games](modules/games/README.md) | `@enbox/modules/games` | `game`, `game/session`, `game/progress` |
| [Learning Plans](modules/learning-plans/README.md) | `@enbox/modules/learning-plans` | `goal/plan`, `goal/plan/activity`, `goal/plan/activity/progress` |
| [Movies and TV](modules/movies-tv/README.md) | `@enbox/modules/movies-tv` | `title`, `title/viewing`, `title/rating` |
| [Music](modules/music/README.md) | `@enbox/modules/music` | `item`, `item/listening` |
| [Podcasts](modules/podcasts/README.md) | `@enbox/modules/podcasts` | `show`, `show/episode`, `show/episode/playback` |

### Travel and outdoors

| Module | Import subpath | Records |
| --- | --- | --- |
| [Cards and Passes](modules/cards-passes/README.md) | `@enbox/modules/cards-passes` | `pass` |
| [Packing](modules/packing/README.md) | `@enbox/modules/packing` | `list`, `list/bag`, `list/item` |
| [Places](modules/places/README.md) | `@enbox/modules/places` | `place` |
| [Reservations](modules/reservations/README.md) | `@enbox/modules/reservations` | `reservation`, `reservation/change` |
| [Routes](modules/routes/README.md) | `@enbox/modules/routes` | `route`, `route/waypoint`, `route/track` |
| [Trips](modules/trips/README.md) | `@enbox/modules/trips` | `trip`, `trip/item` |

### Identity and digital life

| Module | Import subpath | Records |
| --- | --- | --- |
| [Connect](modules/connect/README.md) | `@enbox/modules/connect` | `wallet` |
| [Credentials](modules/credentials/README.md) | `@enbox/modules/credentials` | `credential`, `credential/artifact`, `credential/verification`, `presentation` |
| [Devices](modules/devices/README.md) | `@enbox/modules/devices` | `item/device`, `item/device/configuration` |
| [Identity Documents](modules/identity-documents/README.md) | `@enbox/modules/identity-documents` | `document`, `document/extraction`, `document/review` |
| [Insurance](modules/insurance/README.md) | `@enbox/modules/insurance` | `policy`, `policy/subject`, `policy/claim` |
| [Online Accounts](modules/online-accounts/README.md) | `@enbox/modules/online-accounts` | `account`, `account/identityLink` |
| [Preferences](modules/preferences/README.md) | `@enbox/modules/preferences` | `theme`, `locale`, `privacy`, `notification`, `accessibility`, `food`, `travel`, `communication` |
| [Profiles](modules/profile/README.md) | `@enbox/modules/profile` | `profile`, `profile/link`, `profile/avatar`, `profile/hero` |

### People and personal life

| Module | Import subpath | Records |
| --- | --- | --- |
| [Contacts](modules/contacts/README.md) | `@enbox/modules/contacts` | `contact`, `contact/endpoint`, `contact/interaction`, `group`, `group/entry` |
| [Conversations](modules/conversations/README.md) | `@enbox/modules/conversations` | `conversation`, `conversation/message`, `conversation/message/reaction`, `state` |
| [Events](modules/events/README.md) | `@enbox/modules/events` | `event`, `event/exception`, `event/response`, `state` |
| [Goals](modules/goals/README.md) | `@enbox/modules/goals` | `goal`, `goal/progress` |
| [Habits](modules/habits/README.md) | `@enbox/modules/habits` | `habit`, `habit/checkIn` |
| [Personal Projects](modules/personal-projects/README.md) | `@enbox/modules/personal-projects` | `project`, `project/milestone` |
| [Relationships](modules/relationships/README.md) | `@enbox/modules/relationships` | `follow`, `connection`, `restriction` |

### Health and fitness

| Module | Import subpath | Records |
| --- | --- | --- |
| [Cycle Tracking](modules/cycle-tracking/README.md) | `@enbox/modules/cycle-tracking` | `cycle`, `cycle/observation` |
| [Health Profile](modules/health-profile/README.md) | `@enbox/modules/health-profile` | `profile`, `profile/condition`, `profile/allergy` |
| [Measurements](modules/measurements/README.md) | `@enbox/modules/measurements` | `measurement` |
| [Medical Records](modules/medical-records/README.md) | `@enbox/modules/medical-records` | `document`, `visit`, `immunization` |
| [Medications](modules/medications/README.md) | `@enbox/modules/medications` | `medication`, `medication/regimen`, `medication/dose` |
| [Mood](modules/mood/README.md) | `@enbox/modules/mood` | `checkIn` |
| [Sleep](modules/sleep/README.md) | `@enbox/modules/sleep` | `session` |
| [Symptoms](modules/symptoms/README.md) | `@enbox/modules/symptoms` | `episode` |
| [Workouts](modules/workouts/README.md) | `@enbox/modules/workouts` | `routine`, `workout`, `workout/exercise` |

### Food and shopping

| Module | Import subpath | Records |
| --- | --- | --- |
| [Food Diary](modules/food-diary/README.md) | `@enbox/modules/food-diary` | `entry` |
| [Gifts](modules/gifts/README.md) | `@enbox/modules/gifts` | `plan`, `plan/idea` |
| [Groceries](modules/groceries/README.md) | `@enbox/modules/groceries` | `list`, `list/item` |
| [Meal Plans](modules/meal-plans/README.md) | `@enbox/modules/meal-plans` | `plan`, `plan/meal` |
| [Pantry](modules/pantry/README.md) | `@enbox/modules/pantry` | `pantry`, `pantry/item`, `pantry/item/change` |
| [Purchases](modules/purchases/README.md) | `@enbox/modules/purchases` | `purchase`, `purchase/item`, `purchase/return` |
| [Recipes](modules/recipes/README.md) | `@enbox/modules/recipes` | `recipe`, `recipe/variation` |
| [Shopping Wishlists](modules/shopping-wishlists/README.md) | `@enbox/modules/shopping-wishlists` | `list`, `list/item` |

## Discovery and raw artifacts

```ts
import { getModuleCatalogEntry, searchModuleCatalog } from '@enbox/modules/catalog';

const matches = searchModuleCatalog('groceries');
const entry = getModuleCatalogEntry('groceries');
// entry.definition: complete authored ModuleDefinition
// entry.records: actual local paths, payload schemas, formats, and policies
// entry.examples: structured examples for every path (including required tags)
// entry.capture: identity matching, excluded concepts, and write workflow
```

Discovery searches metadata, not personal records. Loading a catalog entry does
not grant permission or write data. An AI can inspect the actual schema, match an
existing record, validate a proposed value, and apply the user's save policy.
Facts, intentions, corrections, and hypothetical statements must remain distinct.
Each entry's `capture` contract explains identity matching, excluded neighboring
concepts, and its write workflow. This guidance confers no authority; actual
access still comes from the selected context, role, and grants.

Raw artifacts are also public package subpaths:

```ts
import definition from '@enbox/modules/artifacts/groceries/definition.json' with { type: 'json' };
import schema from '@enbox/modules/artifacts/groceries/schemas/item.json' with { type: 'json' };
```

`@enbox/modules/artifacts/index.json` lists individual artifact locations. Each
module's `catalog.json` names its definition, schemas, actual paths, dependencies,
and examples. No aggregate file is the sole source of module definitions.

## Composition

Warranties, Maintenance, Vehicles, and Devices attach local children to a
Belongings `item`. Transactions and Investment Holdings attach independently to a Financial Accounts
`account`. Learning Plans attaches a plan to a Goals `goal`. Notebook Realtime
attaches live collaboration records to a Notebook `notebook/page`.

```ts
import { BelongingsModule } from '@enbox/modules/belongings';
import { WarrantiesModule } from '@enbox/modules/warranties';

const item = await enbox.using(BelongingsModule).records.create('item', {
  data: { name: 'Washing machine', state: 'owned' },
});
await enbox.using(WarrantiesModule).records.create('item/warranty', {
  parentContextId: item.contextId,
  data: { provider: 'Example Appliances', expiresOn: '2029-01-15' },
});
```

The base item remains owned by Belongings; the warranty belongs to Warranties.
`item` is a virtual attachment in the consumer and cannot be created or queried
as a consumer record. Dependencies are supplied by the typed artifact and
installed in provider order. Reads, queries, and observations stay scoped to the
owning module. See [module composition](../../docs/MODULE-COMPOSITION.md).

Composition attaches new owned children; it does not copy or override a provider's
definition. A consumer declares `uses`, attaches with a DWN structure reference
such as `$ref: "notebook:notebook/page"`, and explicitly authorizes provider roles
such as `notebook:notebook/page/editor`. Provider roles retain their original
context scope. A role on one page does not grant access to a sibling page or its
realtime records.

Bookmarks, document scans, purchase evidence, and presentation credentials use
payload links when the target's identity and lifecycle are independent. A link
with an omitted `tenantDid` is relative to the DID owning the referring record,
including when another user reads a replica. Copying a relative link to another
owner requires preserving or explicitly rebinding that meaning.

## Access, encryption, and lifecycle

Personal content paths require DWN encryption. They are owner-only unless
explicit role actions or delegated grants authorize another principal. Public
Profile/Connect behavior and the existing owner-only plaintext preference paths
are retained; privacy and the new preference profiles are encrypted.

Shared modules declare contextual `editor` and `viewer` roles. The owner issues
role records with the member's DID in the record descriptor's `recipient`, an
empty `{}` payload, and the direct parent's `contextId`. Membership records are
immutable and the recipient can read or remove their own assignment. Each data
path's action list specifies the member's powers. `update`, `delete`, and `prune`
require authorship; `co-update`, `co-delete`, and `co-prune` can affect another
author's records when an applicable action rule permits it. The
`who: "recipient", can: ["co-delete"]` rule on a role record permits only its
recipient to leave that assignment, without invoking `moduleRole`. It does not
let viewers remove other viewers. The owner may revoke any assignment.

Viewers cannot create or change shared content. Events uses a distinct `attendee`
role for author-managed RSVP responses. Editors can jointly edit shared list
state, such as grocery items, but authored contributions and immutable history
do not grant deletion of other writers' records. Parent contexts do not grant
pruning that would bypass those protections. Shared Expenses keeps the group
roster owner-managed and each expense author-managed. Individual module guides
and `entry.records[].actions` expose every path's additional authority.

Notebook Realtime sessions intentionally store plaintext ephemeral public peer
keys so members can authenticate live writers. They never contain private keys.

For managed invitations and following, use the optional
[`@enbox/contexts`](https://github.com/enboxorg/enbox-contexts) companion API.
A structural dependency does not implicitly grant provider-data access, and a
payload link never transfers its target's permissions.

`published` controls discovery of the definition, not publication of records.
Private information belongs in encrypted payloads, not unencrypted tags. The
Preferences notification path retains its required `channel` tag, supplied in
its example.

Immutable records cannot be updated, including by the owner. Deletion still
follows the action rules. `$recordLimit` provides a deterministic visible
population; it does not guarantee that competing creates are rejected. Pruning
follows structural children across modules, while linked records remain
independent. Root sharing contexts remain under owner lifecycle control.

## Data conventions

- Money is `{ amount: string, currency: string }`. Decimal strings preserve the
  supplied amount; transaction direction is explicit instead of inferred from a
  floating-point sign. Currency conversion and reconciliation are application work.
- Quantities include an explicit decimal string and unit. Missing quantities stay
  absent rather than silently becoming zero or one.
- Dates use `YYYY-MM-DD`; instants use validated RFC 3339 date-time strings. Source
  time and user timezone matter when resolving relative chat expressions.
- JSON objects reject unknown fields, invalid enum values, malformed dates/URLs,
  and other declared constraints on both encode and decode. Codecs do not coerce
  types, insert defaults, or strip invalid fields.
- JSON Schemas are bundled Draft-07 documents with local references. A reference
  such as `#/definitions/fileRecordReference` correctly resolves inside the same
  schema document. The document's `$id` and DWN type's `schema` are full URI
  identities; the local fragment need not become a full URL. These schema
  references are independent of DWN composition references such as
  `notebook:notebook/page`. See [JSON Schema reference resolution](https://json-schema.org/understanding-json-schema/structuring).
- JSON payload validation runs in the codecs. The DWN enforces descriptor schema
  identity, formats, size, encryption, lifecycle, and authorization; it cannot
  inspect encrypted JSON to validate payload fields. A record link's syntax does
  not prove that its target exists, has the expected parent/type, or is readable.
- Source metadata is provenance information, not an authorization grant or proof
  that an assertion is true. Financial totals, references to other records, and
  clinical interpretations need their application's appropriate reconciliation.
- Tasks and Events store alert preferences, including private state for shared
  records. Applications schedule/deliver alerts; installing a module does not run
  a scheduler.

## Notebook interoperability

Notebook and Notebook Realtime preserve the executable definitions in
[notesd](https://github.com/enboxorg/notesd/blob/377645c881b0d1a86710130957cc5d583b249c8f/src/features/notebooks/module.ts)
and its [realtime extension](https://github.com/enboxorg/notesd/blob/377645c881b0d1a86710130957cc5d583b249c8f/src/features/notebooks/realtime-module.ts).
The owner manages notebook and page metadata. Editors append immutable
`@enbox/crdt` yjs1 frames; administrators can also squash the log. Page members
can inspect writer assignments, while the viewer roster remains private.

Page attachments use `recordCodecs.fileEnvelope({ formatId: 'notesd',
maxContentBytes: 50_000_000 })`: filename, MIME type, and bytes are encrypted
together. The attachment schema URI identifies this binary contract; there is
no JSON Schema for its bytes. The catalog's `codec` metadata and `file-envelope`
examples describe the representation. Delta examples contain real CRDT frames,
which applications materialize into text with `@enbox/crdt`.

Realtime imports the existing page and its roles. The owner advertises the live
session; editors and administrators create and delete their own session records.
Installing this extension adds no page-writing or membership-management powers.

## Identity documents and credentials

Identity Documents stores document-specific fields, scan references, extraction
results, and review/correction history. Front/back or replacement scans can refer
to independent Files records. OCR execution is an application integration; the
module provides its structured storage contract.

Credentials preserves native issuer-secured bytes in immutable artifact records
and separates them from editable local metadata. Verification records identify
which artifact was checked and when. Presentations can reference multiple
credentials and record requested/approved disclosures. The bundled credential
example is a signed, self-issued demonstration, not a government assertion.

Payload/schema validation does not perform issuer-signature verification, establish
holder binding, or certify extracted ID fields. Credential verification and
presentation integrations must evaluate the native artifact, its status, issuer
policy, holder binding, and request context. Selective disclosure depends on the
credential's securing format. Private signing keys remain in the agent's key
management boundary, not account/device/credential metadata fields.

## Reusable authoring and functional examples

Use `@enbox/modules/authoring` for reusable source while publishing complete,
concrete contracts:

- `roleDefinition(path, options)` emits immutable empty membership assignments.
  Recipients can leave their own role. Owner-only issuance/revocation is the
  default; roster readers and any other issuers/revokers are explicit options.
- `attachModuleDefinition(options)` selects one concrete source root, substitutes
  explicit provider-role bindings, rebinds local actor paths, and excludes local
  memberships and private sibling state. Root creation/deletion actions are
  supplied explicitly. Conflicting aliases, unknown roles, dependency cycles,
  and invalid ancestry fail validation.
- `realtimeDefinition(options)` binds the owner-managed advertisement and
  writer-owned sessions to an explicit provider, parent path, and ordered role set.
  Notebook Realtime uses it while preserving the notesd wire definition exactly.
- `bundleSchema(source, sharedSchemas)` expands registered value contracts into
  local Draft-07 definitions. Local aliases remain stable; unknown references,
  contract overrides, naming collisions and cycles are rejected.

These are authoring helpers. Run codegen to obtain literal-preserving typed
module exports, then have applications import the published standard module.
A template does not make independently chosen module URIs share records.

```ts
import { roleDefinition, bundleSchema, sharedSchemas } from '@enbox/modules/authoring';

const viewer = roleDefinition('document/viewer');
const schema = bundleSchema({
  $id: 'https://example.com/schemas/item/v1',
  type: 'object',
  additionalProperties: false,
  properties: {
    price: { $ref: 'https://enbox.id/schemas/common/money/v1' },
  },
}, sharedSchemas);
```

The [executable application examples](examples/README.md) exercise household,
notebook, and portfolio workflows. The household adds `@enbox/contexts` through
its existing `defineContextModule` API; no invitation or follow-journal paths
are hidden inside the domain definitions. A space admin can maintain metadata
and moderate feature content as explicitly authorized; the owner manages the
membership roster and space pruning.

Device manufacturer, model, serial number and ownership state belong to the
parent Belongings item. Devices keeps operational state and dated configuration
snapshots; all asset repairs use Maintenance. Vehicles likewise reads common
manufacturer/model identity from Belongings. Financial Accounts owns the account
identity used by both Transactions and Investment Holdings.

## Development

Author each module in its own `modules/<id>/source/definition.ts` and
`source/schemas/*.json`, alongside its `catalog.json` and `examples.json`.
A source module may export a `schemas` map to reuse another module's source
schemas, as the shared household variants do. Common value schemas live in
`src/schema-values/` and are exported at `@enbox/modules/schemas/*.json`.

Generation emits the complete `definition.json`, self-contained `schemas/*.json`,
validating codecs, literal TypeScript declarations and README for each module.
Edit authoring inputs rather than generated artifacts. Record paths use the DWN's
alphabetic segments (including camelCase); schema filenames use kebab-case.

From a monorepo checkout, build workspace prerequisites, then:

```bash
cd packages/modules
bun run generate
bun run build
bun run test:node
```

Generation uses `@enbox/module-codegen` to produce literal typed definitions,
CSP-safe standalone validators, and codecs in `src/generated/`, along with
individual entrypoints and documentation. `bun run check:generated` verifies
freshness without changing repository artifacts. Shared schema URIs resolve
only against the supplied local registry; generation never fetches arbitrary URLs. Schema examples, invalid payloads, type contracts,
real encrypted DWN round-trips, authorization, and composition/lifecycle behavior
are exercised by the test suite.

The build-time generator uses the workspace codegen source; adding a direct
codegen package dependency here would introduce a workspace cycle through its
browser development dependency. Runtime consumers need neither the generator,
Ajv, Prettier, nor a runtime schema compiler.

Releasable changes use a patch changeset. The existing release workflow publishes
`@enbox/modules`; a hosted directory can consume the packaged individual catalog
artifacts. Publishing to npm does not automatically register an unrelated hosted
service.

## Profile reader

`createProfileReader` remains available from the package root and
`@enbox/modules/profile-reader` for reading public profile data through connected
or anonymous Enbox record surfaces.

## License

Apache-2.0
