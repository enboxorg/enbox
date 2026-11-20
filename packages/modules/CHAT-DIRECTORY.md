# One module catalogue for Enbox and Briand

The typed registry, [raw module index](modules/index.json), [conversation index](src/generated/chat-index.json) and [Briand bundles](directory/briand.json) publish the same modules. A user's intended operation determines the record path or application workflow. The package [module library](README.md#module-library) lists every record and role, including private roots and paths attached to an existing parent.

Each bundle ships its full DWN definition, all of its JSON payload schemas keyed by URI, its capture hints, and an explicit `capturePaths` list. A module with an empty allowlist supplies a `workflow` describing the required application operation. Such a module remains discoverable and installable. For example, a wallet can present a credential, a notebook editor can materialize a CRDT page, and an authorized user can publish a Profile.

## Choosing a destination

| What the user means | Destination and record structure |
| --- | --- |
| “Extract the expiry from my driver's licence.” | Identity Documents. Select the issued document, retain document-type-specific fields, attach extraction evidence, and record reviews against the same document. The same workflow applies to passports and national IDs. |
| “Save my vehicle registration.” | Vehicles. Resolve the Belongings item and vehicle. Each registration issuance records its jurisdiction and identifiers beneath that vehicle. A scan can live in Files. |
| “Watch XYZ.” / “I own ten shares of XYZ.” | Stock Watchlists holds research interest under a selected watchlist. Investment Holdings requires the selected financial account, instrument and observation time. |
| “Get milk.” / “I have milk.” / “I drank milk.” | Groceries records shopping intent, Pantry records stock, and Food Diary records consumption. Ask which fact the user is asserting when the wording is ambiguous. |
| “Add milk to our household list.” | Use Groceries at `space/list/item` when the selected list is inside a Collaboration space, or `list/item` for an independent list. The same module and payload schema serve both. Meal Plans and Tasks also support independent and shared-space roots. |
| “I want these headphones.” / “Keep a birthday gift idea for Sam.” | Shopping Wishlists owns the desired product. Gifts owns the private recipient, occasion and gifting state and can link the wishlist item. Each audience sees the records it is authorized to read. |
| “Remind me to book the dentist.” / “My appointment is Tuesday.” / “I visited the clinic.” | Tasks owns an action, Events owns a scheduled occurrence, and Medical Records owns a reported completed visit. Private alerts refer to the selected task or event. |
| “I want to speak Italian.” / “Build a study plan for that goal.” | Goals owns the desired outcome. Learning Plans attaches the learning plan, activities and progress to the selected goal. Actual past education can be recorded in Career History. |
| “Save this link.” / “I want to watch this film.” | Bookmarks owns a saved URL or DID-relative record link. Media Library owns an identified work and its tracking or progress records, across books, films, games, music and podcasts. |
| “File my receipt.” / “Track my order.” / “Record this posted debit.” | Receipts preserves merchant evidence. Purchases tracks fulfillment and returns. Transactions records actual movements on a Financial Accounts record. Link the records when the user supplies evidence for each. |
| “I follow this person.” / “Give this person access to our space.” | Relationships holds an explicit social relationship. Membership management uses Collaboration, the selected context, and the owner's authority. |
| “Archive this conversation.” | Use the selected Conversations workflow for the authorized conversation. Existing assistant transcripts remain in Briand's managed workspace history. |

The [routing cases](directory/routing-examples.json) include multi-intent utterances, ambiguous requests, quoted speech, hypotheticals and questions. They provide labeled examples for evaluating an extractor.

## Consumer contract

1. Load summaries from the conversation index. Use the candidate's examples, identity guidance and exclusions to select the user's intended module and operation. A question or a mention can yield zero proposals.
2. Load the module bundle. Resolve its `definition.uses` dependencies and verify the install and write authority. For generic capture, check `capturePaths` when presenting choices **and** when validating the selected candidate. For operations with a named application workflow, route the user to that workflow.
3. For root capture, provide the paths returned by `chatTargetsFor(moduleUri)`. For a child, pass its selected parent's verified owning module URI and path. A write requires the actual parent record's `contextId` and tenant. If several records match, let the user choose. An independent shopping list and a list in a shared space can have the same display name.
4. Validate against the exact schema or codec and apply the user's review policy. Preserve evidence and source date precision. Contact and calendar UIDs can match repeat imports. Names, tickers and last-four digits can match several records.

```ts
import { chatDirectory, chatTargetsFor } from '@enbox/modules/chat-directory';
import bundles from '@enbox/modules/directory/briand.json' with { type: 'json' };

const uri = 'https://enbox.id/modules/investment-holdings/v1';
const entry = chatDirectory.find(module => module.module === uri)!;
const bundle = bundles.find(module => module.definition.module === uri)!;
const targets = chatTargetsFor(entry.module, {
  module: 'https://enbox.id/modules/financial-accounts/v1',
  path: 'account',
});
// The bundle's schemas are keyed by each target.schemaUri.
```

The index and bundle array are versioned npm package exports. A publishing service can serve the same JSON. Person-specific values belong in authorized records. The directory contains public definitions, examples and capture hints. `sensitive` and `sensitiveFields` signal review. Authorize installation, access, and automatic saving separately.

## Replacing the proof-of-concept catalogue

Use the package directory as the single source for new module discovery in site and MCP flows. Keep a separate legacy lookup for reading existing records when needed. A previously installed broker-envelope record requires an explicit schema and payload mapping before it can be imported as a native record.

| Earlier PoC choice | Canonical destination |
| --- | --- |
| Identity Profile | Profile publication through its explicit workflow. Contacts for the user's private address book. |
| Preferences & Locale | Preferences. Use its allowed encrypted settings paths for capture and the settings UI for locale/theme. |
| Stock Watchlist & Holdings | Stock Watchlists for research interest and Investment Holdings for confirmed positions. Map the old stock shortcut to the selected watchlist and instrument payload. |
| Watchlist Market Briefings | Briand's generated briefing workflow. Save an actual user-authored research note only on explicit request. |
| Tasks & Action Items | Tasks. Attach to a selected Collaboration space for household tasks. |
| Bookmarks & Reading List | Bookmarks for resource links and Media Library for tracking an identified work. |
| Project Briefs | Personal Projects for the undertaking and Tasks for independently actionable work. |
| Government ID & Passport, Driver's License | One Identity Documents module. A wallet's issuer-secured artifacts use Credentials. |
| Contact | Contacts. Store endpoint children under the chosen person. |
| Purchase Receipt | Receipts. Link actual orders and transactions when available. |
| Vehicle Registration | Vehicles with a registration child of the selected vehicle. |
| Appointment | Events for a scheduled occurrence and Medical Records for a reported visit. |

## Import and export

Scoped converters preserve contact and calendar UIDs across DWN storage. JSON Resume maps work and education arrays to individual records. GeoJSON maps a named Point Feature in longitude/latitude order. Recipe imports preserve quoted ingredient lines and ordered instructions. [Supported interchange profiles](INTERCHANGE.md)

The [field crosswalks](directory/crosswalks.json) document additional mappings with their source fields, target fields, units, and required context.
