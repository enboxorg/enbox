# Personal data module catalog

**Status: proposal for selection and design.** The candidates below describe
personal data that an application could organize into DWN records. They are not
installable definitions, finalized module boundaries, or exports from
`@enbox/modules`. There is no target number of modules.

## Purpose

A person chats with an AI about groceries, investments, appointments, purchases,
or other everyday matters. The application identifies relevant information,
finds an appropriate module, and organizes the information into structured data
under the person's applicable permissions and save preferences.

The catalog needs recognizable domains with useful schemas. Groceries carry
quantities, units, substitutions, and purchase state; a watchlist records interest
in an instrument; an investment holding records reported ownership. These
distinctions help applications interpret conversation consistently.

The focus is individual users, including deliberate sharing with family and
friends. Personal receipts, policies, or reservations belong here. Operating a
merchant, clinic, or other business is outside this catalog's primary scope.

## Candidate metadata

[`candidates.json`](candidates.json) contains the machine-readable selection
menu. Every entry has:

| Field | Meaning |
| --- | --- |
| `id` | A draft catalog key, not a module URI. |
| `name` | A recognizable candidate name. |
| `category` | A browsing and discovery group. |
| `description` | The information the candidate would organize. |
| `example` | A hypothetical chat message illustrating the domain. |
| `recordKinds` | Illustrative record concepts, not finalized DWN paths. |
| `status` | `candidate`; inclusion does not approve implementation. |

Descriptions and capture examples are directory metadata alongside module
artifacts. They are not additional fields in the DWN `ModuleDefinition` wire
format. An application must obtain an actual definition, permitted record paths,
and payload schemas before preparing a write.

Some candidates may merge, share schema fragments, or become concrete extensions
after their use cases and ownership boundaries are reviewed.

## Selection menu

### Food and shopping

| Candidate | Data it represents |
| --- | --- |
| **Groceries** | Shopping lists, items, quantities, units, stores, substitutions, and purchased state. |
| **Pantry** | Food on hand, quantities, storage locations, expiry dates, and stock changes. |
| **Recipes** | Ingredients, quantities, servings, preparation steps, and personal variations. |
| **Meal Plans** | Meals planned for dates, eaters, portions, and recipe references. |
| **Food Diary** | Meals actually eaten, portions, times, and observations. |
| **Shopping Wishlists** | Desired products, variants, quantity, priority, budget, and retailer links. |
| **Purchases** | Consumer orders and items, merchant, cost, delivery progress, and personal return/refund tracking. |
| **Gifts** | Recipients, occasions, gift ideas, budget, and purchase/wrapping/giving state. |

### Money and investing

| Candidate | Data it represents |
| --- | --- |
| **Stock Watchlists** | Instruments being watched, reasons, user-stated targets, and research references. |
| **Investment Holdings** | Accounts, owned positions, lots, quantities, acquisition costs, and investment transactions. |
| **Transactions** | Personal income, expenses, transfers, amounts, currencies, dates, and counterparties. |
| **Budgets** | Period-based spending plans, category allocations, and planned limits. |
| **Bills** | Amounts owed, payees, due dates, recurrence, and payment state. |
| **Subscriptions** | Services, plans, recurring charges, trials, renewal dates, and cancellation state. |
| **Debts and Loans** | Money borrowed or lent, counterparties, agreed terms, balances, and repayments. |
| **Shared Expenses** | Participants, shared costs, allocation shares, and settlements. |
| **Receipts** | Structured purchase evidence: merchant, date, line items, totals, and source-file references. |

### Home and belongings

| Candidate | Data it represents |
| --- | --- |
| **Belongings** | Owned physical items, serial/model details, locations, acquisition records, and manuals. |
| **Warranties** | Coverage terms, covered items, dates, providers, claim references, and evidence. |
| **Maintenance** | Service plans, repairs, inspections, replaced parts, costs, and history linked to belongings or vehicles. |
| **Housing** | Homes, address history, occupancy, leases, rent/deposit details, and document references. |
| **Utilities** | Household service accounts, meters, readings, usage, and bill references. |
| **Plants** | Plants, locations, care needs, watering/repotting history, and observations. |
| **Pet Care** | Pets, care routines, vet visits, and health-document references. |
| **Vehicles** | Cars/bikes, identifiers, mileage, fuel or charging logs, and document/service references. |

### Health and fitness

| Candidate | Data it represents |
| --- | --- |
| **Health Profile** | Explicitly supplied conditions, allergies, relevant history, and emergency information with provenance. |
| **Medical Records** | Visit documents, test reports, immunizations, clinician details, and source evidence. |
| **Medications** | Medication and prescription details, supplied regimens, dose logs, and changes. |
| **Symptoms** | User-reported symptom episodes, onset, duration, severity, and context. |
| **Measurements** | Personal measurements with values, units, timestamps, and measurement sources. |
| **Workouts** | Exercise sessions, routines, sets/reps, distance, duration, and performance. |
| **Sleep** | Sleep sessions, bedtime/wake times, interruptions, and reported quality. |
| **Mood** | Explicitly reported mood, energy, stress, and contextual observations. |
| **Cycle Tracking** | User-reported menstrual cycles, dates, symptoms, and related observations. |

### Travel and outdoors

| Candidate | Data it represents |
| --- | --- |
| **Trips** | Destinations, travellers, dates, itinerary items, and links to reservations and resources. |
| **Reservations** | Personal flight, rail, lodging, rental, and activity confirmations and changes. |
| **Packing** | Packing lists with items, quantities, travellers, bags, and packed state. |
| **Routes** | Planned routes or recorded tracks, waypoints, travel mode, and relevant geometry. |
| **Cards and Passes** | Membership/loyalty cards and personal access/transit passes, identifiers, validity, and issuer references. |
| **Places** | Saved locations, addresses, coordinates, and personal annotations. |

### Media and learning

| Candidate | Data it represents |
| --- | --- |
| **Books** | Books/editions, reading state, progress, highlights, and personal reviews. |
| **Movies and TV** | Films/series, watch intentions, episode progress, viewing history, and ratings. |
| **Music** | Artists/albums/tracks, music-library references, favourites, and listening history. |
| **Podcasts** | Shows, followed feeds, episodes, queues, and playback progress. |
| **Games** | Owned/wanted games, platforms, play sessions, progress, and personal notes. |
| **Learning Plans** | Learning objectives, resources/courses, planned study, and progress evidence. |
| **Flashcards** | Study cards, decks or grouping references, and private review state/history. |

### People and personal life

| Candidate | Data it represents |
| --- | --- |
| **Contacts** | Address-book entries, communication details, and private information supplied about contacts. |
| **Relationships** | Explicit social connections, follows, requests/acceptances, blocks, and mutes. |
| **Conversations** | Human/AI conversation records, messages, participants, and source references. |
| **Events** | Scheduled activities, recurrence, participants, location links, and native alert preferences. |
| **Personal Projects** | A project's purpose, outcomes, milestones, and links to tasks/resources. |
| **Goals** | Explicit personal targets, measures, deadlines, and progress observations. |
| **Habits** | Repeated routines, schedules/targets, and actual check-ins. |

### Identity and digital life

| Candidate | Data it represents |
| --- | --- |
| **Identity Documents** | Structured ID/passport/licence fields, scan references, extraction provenance, and reviewed corrections. |
| **Credentials** | Issuer-secured credential artifacts, local verification observations, and approved presentation history. |
| **Profiles** | The user's self-authored display identity, biography, images, and links. |
| **Preferences** | Explicit locale, accessibility, appearance, communication, and selected domain preferences. |
| **Devices** | Personal device identity, configuration metadata, service history, and ownership/account references. |
| **Online Accounts** | Service accounts, usernames, linked identities, plan/status metadata, and recovery references. |
| **Insurance** | Personal policies, providers, covered subjects, supplied coverage details, dates, and claim/document references. |

### General personal records

| Candidate | Data it represents |
| --- | --- |
| **Notes** | Personal writing, drafts, journal entries, and research notes. |
| **Files** | File identity, metadata, content, and independently managed attachments. |
| **Bookmarks** | Saved web/DID-relative references, annotations, folders, and ordered entries. |
| **Tasks** | Actions, deadlines, completion state, and native alert/checklist data. |
| **Time Entries** | Actual time spent on activities, with durations and project/task references. |

## Organizing conversation data

| Example | Candidate | Information to capture |
| --- | --- | --- |
| "Add NVDA to my watchlist." | Stock Watchlists | A watched instrument; any supplied rationale or targets. |
| "I own ten shares of NVDA." | Investment Holdings | Reported ownership and quantity; acquisition cost remains unknown unless supplied. |
| "We need milk, oats, and two lemons." | Groceries | Three needed items and the supplied quantity for lemons. |
| "We have three cans of chickpeas." | Pantry | Reported stock on hand, quantity, and unit. |
| "Let's cook lentil soup on Tuesday." | Meal Plans | An intended meal, date, and recipe reference when known. |
| "I spent £42 on groceries." | Transactions | Reported expenditure, currency, and category. |
| "I stopped the podcast at 18 minutes." | Podcasts | A playback position associated with an identified episode. |
| "Here is my passport." | Identity Documents | Source-file references and extracted fields that retain their provenance and review state. |

A capture flow should:

1. Identify relevant candidate domains and inspect the selected modules' actual
   schemas and allowed paths.
2. Distinguish observations, intentions, requests, negations, corrections, and
   hypothetical statements. Mentioning a possible purchase does not establish
   ownership.
3. Match existing records and choose whether to create, update, link, or take no
   action. Repeating a fact should not automatically create another record.
4. Extract supported values. Missing quantities, units, currencies, or required
   fields need an explicit outcome rather than invented defaults. Resolve
   relative dates against the source message time and the relevant timezone.
5. Retain source message/file references and distinguish supplied information
   from inference or external evidence.
6. Validate the payload through its schema/codec and apply the user's permissions
   and save preferences before writing.

One message can concern several modules. Each fact still needs a clear owner:
Groceries records buying intent, Pantry records reported stock, Bills records
amounts due, Transactions records money movements, Events records planned time,
and Time Entries records time actually spent.

## Module boundaries and composition

The [composition guide](../MODULE-COMPOSITION.md) defines the current runtime
model. The main design choices are:

| Need | Mechanism | Example |
| --- | --- | --- |
| Reuse a data shape | Shared schemas, codecs, or authoring helpers | Names, addresses, quantities, or alert settings. |
| Group closely related features | Local types and children in one module | Bookmark folders/entries or document extraction/review. |
| Add independently optional child data | An explicit `uses` dependency and root `$ref` attachment | The existing Notes/Discussion composition fixture. |
| Associate independent records | A payload reference, including DID-relative references | A bookmark target, a document's scan, or a presentation's credentials. |

A `$ref` attachment adds child records owned by the consuming module. It does
not add fields to the provider's JSON payload, replace its schema, import its
children, or inherit its permissions. Targets are concrete module URIs and
paths; there is no wildcard attachment to every module or payload subtype.

Each physical tree belongs to one tenant. Structural descendants participate in
pruning across module boundaries; data links retain independent authority and
lifecycle. Cross-owner associations use links. A payload link alone does not
require a `uses` alias, and referencing data does not grant access to it.

`defineModule({ definition, codecs, dependencies })` preserves the authored
definition. Optional invitations and follow state use explicit companion modules
from [`@enbox/contexts`](https://github.com/enboxorg/enbox-contexts). Personal
owner-only modules do not need a mandatory shared workspace parent.

The following boundary decisions guide further review:

- **Bookmarks includes saved-reference organization.** Bookmarks can target web
  URLs or DID-relative resources. Generic folders and ordered entries can live
  within Bookmarks; a separate Collections module is not currently proposed.
  Domain-native containers can remain inside their own modules when useful.
- **Reminders are features initially.** Tasks and Events can share an alert
  schema. Private per-user settings for shared records can live in local state
  records within the corresponding module. Scheduling and delivery are app
  capabilities, not consequences of installing a definition.
- **Sensitive content needs explicit record policies.** A definition's
  `published` flag controls definition discovery. Record access rules and
  `encryptionRequired` determine the data policy separately.
- **Stable references need deliberate lifecycle rules.** Existing imported
  representations, roles, and parent bindings cannot be silently retargeted by
  a same-URI update. Breaking contracts may require new module/schema URIs.

Open questions include whether Devices should specialize Belongings, how much
purchase aftercare belongs with Purchases, whether Packing is native Trip data,
and how media modules share representation and progress schemas. Goals, Habits,
and Learning Plans should reuse common fragments without duplicating authoritative
facts. These questions are reasons for review, not a quota to fill.

## Identity wallet example

Identity Documents and Credentials serve different forms of personal evidence:

```text
IdentityDocuments.document
├── extraction
├── review
└── source references -> Files.file (one or more)

Credentials.credential
├── artifact — original issuer-secured data
├── verificationCheck
└── optional association -> IdentityDocuments.document

Credentials.presentationReceipt
└── references -> presented credentials
```

An identity document keeps its own identity while front/back images or
replacement scans change. Extraction records preserve their source, normalized
fields, and reviewed corrections. Passport, national-ID, and licence profiles
can share a module with explicit document-specific schemas.

A credential can arrive without a scan. Its original secured artifact remains
separate from editable local metadata. Importing it into a DID's DWN does not
establish its subject or holder binding, and reviewing OCR output does not make
it an assertion signed by the document's issuing authority. A presentation
involving several credentials uses references rather than several physical
parents.

Relevant design inputs include the [OpenID identity assurance schema](https://openid.net/specs/openid-ida-verified-claims-1_0.html),
[W3C Verifiable Credentials Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/),
[OpenID4VCI](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0-final.html),
and [OpenID4VP](https://openid.net/specs/openid-4-verifiable-presentations-1_0-final.html).
These inform the design; supported profiles, securing formats, verification, and
presentation integrations still need to be selected and implemented. Selective
disclosure depends on the credential's format and securing mechanism.

## Publication model

[`@enbox/modules`](../../packages/modules/README.md) is the existing home for
released definitions, schemas, and typed artifacts. Its package publication
uses the repository's Changesets and release workflow.

For selected modules, keep the definition, schemas, and discovery metadata
together as the source of truth. A release can then provide:

- Typed module exports, codecs, and bundled schemas for applications.
- A generated machine-readable catalog for AI directory search, including
  descriptions, capture examples, actual paths/schemas, dependencies, and
  release identity.
- Human-readable documentation derived from the same inputs.

Directory ingestion, version selection, and update policy need an explicit
integration. This proposal does not establish a submission endpoint or automatic
synchronization between npm exports and a directory. Configuring a definition
in a user's DWN is also separate from publishing a package or directory entry.

This draft menu remains under `docs/`; it is not shipped as an installable
catalog or treated as a set of available runtime definitions.

## From candidate to standard module

Before promoting a candidate, define its record identities and paths, concrete
data schemas, source/reference model, access/encryption policy, and update/prune
behavior. Explain each structural dependency and any shared schema fragments.

Provide complete typed artifacts with codecs for reachable local types and
dependency bindings that match `uses`. Current
[`@enbox/module-codegen`](../../packages/module-codegen/README.md) expects local
schemas with matching IDs and in-document fragment references; shared fragments
must be embedded or bundled rather than fetched from arbitrary URLs at generation
time.

Verify representative valid and invalid payloads, typed usage, and the module's
actual ownership/composition behavior. Only then should the directory advertise
the module's supported write paths and installation artifacts.
