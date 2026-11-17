# Conversation capture directory

A chat client can recommend 36 modules covering 59 specific kinds of record. The directory is a selection from the full application library. Its entries describe what the user meant, which path owns that fact, what evidence distinguishes a neighboring intent, and which parent an application must resolve. A user can keep independent records for a grocery item they intend to buy, an ingredient already in their pantry, and a meal they ate.

| Conversation | Modules to suggest |
| --- | --- |
| People, settings and plans | Contacts, Preferences, Events, Tasks, Personal Projects, Goals, Habits |
| Things to revisit and experiences to remember | Bookmarks, Books, Places, Career History |
| Cooking and shopping | Groceries, Pantry, Recipes, Meal Plans, Food Diary, Shopping Wishlists |
| Orders and money | Purchases, Receipts, Bills, Subscriptions, Financial Accounts, Transactions, Stock Watchlists, Investment Holdings |
| Home, paperwork and travel | Belongings, Maintenance, Vehicles, Identity Documents, Trips, Reservations |
| Personal health and activity | Health Profile, Medical Records, Medications, Measurements, Workouts |

The [routing examples](directory/routing-examples.json) are labeled inputs for evaluating an extractor. They include multi-intent requests, clarifications, quoted speech, hypotheticals, and questions that should produce zero records. Extractor accuracy requires evaluating the actual model against these cases.

## Consumer contract

1. Give the selector the small [directory index](src/generated/chat-index.json). Present the summaries first. When it selects an entry, use its target paths, utterances, identity guidance and exclusions. A ticker, name, book title, or product reference on its own can occur in many conversations.
2. Load the selected complete bundle from [the Briand projection](directory/briand.json). The schema map uses the exact DWN schema URI as its key. Check availability of every module named in `definition.uses` before installation. Metadata and examples are public, while install and write decisions belong to the user's application.
3. For extraction without a selected parent, provide only the paths from `chatTargetsFor(uri)`. For a selected parent, pass its verified **owning** module URI and path. A child write also needs the parent record's actual `contextId`, the correct tenant, and appropriate grants. If the intended path needs a parent, ask the user to select one or explicitly create it. An empty set means there is no matching destination at that parent.
4. Validate the proposed fields with the path's exact codec or bundled JSON Schema, then apply the user's capture and review policy. Preserve source evidence and date precision. Use external UIDs supplied by the original contact or calendar record for repeat imports. Common names, titles, tickers and institution names can identify multiple records.

```ts
import { chatDirectory, chatTargetsFor } from '@enbox/modules/chat-directory';
import bundles from '@enbox/modules/directory/briand.json' with { type: 'json' };

const suggestions = chatDirectory.map(({ module, label, summary }) => ({ module, label, summary }));
const holdings = chatDirectory.find(entry => entry.id === 'investment-holdings')!;
const destinations = chatTargetsFor(holdings.module, {
  module: 'https://enbox.id/modules/financial-accounts/v1',
  path: 'account',
});
const portfolioBundle = bundles.find(bundle => bundle.id === holdings.id)!;
// Each destination.schemaUri is a key in portfolioBundle.schemas.
```

The package publishes these artifacts at versioned npm package subpaths. A static directory service can serve the same JSON. The full library and its per-module artifacts are available through [the application catalogue](README.md#module-library). A client with an explicit shared household can use Shared Groceries, Shared Meal Plans and Shared Tasks from that library with its selected space. Keeping these shared variants outside the initial menu gives each intent one suggestion before a sharing context is chosen.

## Moving from Briand's starter directory

Use the curated entries as the discovery list for new capture. Keep legacy URIs resolvable for reading prior records. Appending the curated entries to the PoC's eight starter packs and five broker schemas would retain overlapping suggestions under different URIs. Replacing the list requires handling the following decisions in the consumer.

| Existing PoC entry | Destination in a conversation |
| --- | --- |
| Identity Profile | Public profile editor when the user explicitly requests publication. Personal contacts use Contacts. |
| Preferences & Locale | Preferences for the curated encrypted personal settings. Locale and theme remain in the settings UI. Review the actual schemas for the shared URI during adoption. |
| Stock Watchlist & Holdings | “Watch NVDA” → Stock Watchlists, under a selected watchlist. “I own ten shares” → Investment Holdings, under the selected financial account, with the observation time. |
| Watchlist Market Briefings | Generated worker output belongs to the briefing workflow. A user-authored research note can reference a watchlist entry in the specialist application. |
| Tasks & Action Items | Tasks for a requested action, Events for a booked time. |
| Bookmarks & Reading List | Bookmarks for a link or DID-relative record, Books for an identified publication and its reading progress. |
| Project Briefs | Personal Projects for the undertaking, Tasks for independently actionable work. |
| Government ID & Passport and Driver’s License | Identity Documents owns a single reviewed document record and its extraction/review history. Signed credential bytes belong to the Credentials wallet workflow. |
| Contact | Contacts for one person. Imported email/phone endpoints live beneath the same contact. |
| Purchase Receipt | Receipts for the merchant's evidence. An order and a posted payment have distinct identities in Purchases and Transactions. |
| Vehicle Registration | Vehicles owns a registration issuance beneath the selected vehicle. Identity Documents covers driver identity. A separate scan can be linked from Files. |
| Appointment | Events for the scheduled occurrence. Medical Records captures an actual reported visit. |

Briand's current background extractor offers only encrypted JSON roots, and its explicit-save route accepts a selected parent context. Four curated modules have only contextual targets: Investment Holdings, Maintenance, Transactions and Vehicles. The 59 selected paths include 36 roots and 23 children. Consumers should use this allowlist rather than feeding every structurally writable path to the model. In particular, the stock fast path in Briand's PoC still emits its legacy `holding` record. It must supply the selected watchlist and the new instrument payload before targeting the published directory.

Each bundle includes the sidecar shape understood by the PoC. `sensitive` and `sensitiveFields` are review signals. `identityFields` is supplied only for stable interchange identities. The current projection does not authorize external lookup of personal information. Apps should retain version/fingerprint-scoped consent and review ambiguous matches. An earlier broker-envelope record needs an explicit import and mapping before a client can write its native DWN successor.

## Data model and interchange

The contact and event modules retain external UIDs in the record. Career History follows the JSON Resume work and education arrays. A named place maps to a GeoJSON Point Feature with longitude first. Recipe imports preserve the author's ingredient text and ordered instructions. See [supported mappings and round trips](INTERCHANGE.md) for supported values, exported metadata and handling of fields outside each profile. The [field crosswalks](directory/crosswalks.json) document 17 additional mappings across 16 modules. They identify source fields, target fields, required context, units and precision for each mapping.

The directory keeps other specialist and infrastructure modules available through explicit workflows. A notebook page needs its CRDT codec, a signed credential needs its issuer-secured artifact, and a file needs its binary upload. Chat history, permissions, membership, key delivery, public profile publication, invitations and realtime sessions use their respective application APIs. The complete library remains the place for specialist tracking, including packing, warranties, gardening, pets, media playback, private gift plans and household sharing.
