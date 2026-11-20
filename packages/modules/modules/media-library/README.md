# Media Library

A private library of books, films, series, podcast episodes, music and games with per-edition intent, observed activity and annotations.

Module URI: `https://enbox.id/modules/media-library/v1`

Import `MediaLibraryModule`, `MediaLibraryDefinition`, `MediaLibraryCodecs`, and `MediaLibrarySchemas` from `@enbox/modules/media-library`. `MediaLibraryCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `work` | [JSON Schema](schemas/work.json) | Encrypted | Mutable |
| `work/activity` | [JSON Schema](schemas/activity.json) | Encrypted | Immutable |
| `work/annotation` | [JSON Schema](schemas/annotation.json) | Encrypted | Mutable |
| `series` | [JSON Schema](schemas/series.json) | Encrypted | Mutable |
| `series/episode` | [JSON Schema](schemas/episode.json) | Encrypted | Mutable |
| `series/episode/activity` | [JSON Schema](schemas/activity.json) | Encrypted | Immutable |
| `series/episode/annotation` | [JSON Schema](schemas/annotation.json) | Encrypted | Mutable |
| `series/annotation` | [JSON Schema](schemas/annotation.json) | Encrypted | Mutable |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `work` | Owner only |
| `work/activity` | Owner only |
| `work/annotation` | Owner only |
| `series` | Owner only |
| `series/episode` | Owner only |
| `series/episode/activity` | Owner only |
| `series/episode/annotation` | Owner only |
| `series/annotation` | Owner only |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Contract notes

- A work record identifies a specific Book, Movie, MusicAlbum, MusicRecording or VideoGame edition/release. One series record identifies a TVSeries or PodcastSeries. Each episode is a physical child of that series. Verify that an episode’s @type matches its series when writing or importing. Use the series context and a feed GUID or season/episode identity to match an episode.
- Selection intent, following and favorites describe the owner’s choices. Activity records capture observed reading, listening, viewing and play with an explicit time. A queued book or film can exist without a session or completion record. Attach a quote, personal note, or scaled review to its source edition or episode.
- The @type, name, identifier, creator and publisher fields use a scoped [Schema.org CreativeWork](https://schema.org/CreativeWork) vocabulary. Book adds isbn, bookEdition and numberOfPages. Music recordings may refer to the album record, games use gamePlatform, and PodcastSeries carries feedUrl. The compact DWN payloads include private library state and DWN references. JSON-LD exchange needs an explicit projection.
- Use separate position units for page, seconds, percent, chapter and level. A reading app and a player can log the same audiobook edition with different clocks. Preserve source identifiers for imported sessions; choose the user’s intended edition if several match.
- Files, purchases and physical belongings keep their own identity and access. Link existing records when the user has evidence for them. Specialist distribution workflows such as playlist sharing, audio streaming and game storefront inventory belong to their own applications.

## Capture contract

**Identity:** Resolve the selected edition or release using its type and qualified identifiers. A title can denote a book, movie, soundtrack or game. Scope a podcast GUID or TV episode number to its actual series.

**Workflow:** Capture a stated library choice on the selected work, series or episode. Append observed consumption and dated progress to that item. Attach personal notes, quotes and reviews to their source.

**Exclude:** A web article saved by URL belongs in Bookmarks. A purchase or physical copy has independent evidence in Purchases and Belongings. A discussion of a book or a recommendation question alone establishes no intent, consumption session or rating.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { MediaLibraryModule } from '@enbox/modules/media-library';

const records = enbox.using(MediaLibraryModule).records;
await records.create('work', {
  data: {
  "@type": "Book",
  "name": "The Dispossessed",
  "creator": [
    {
      "name": "Ursula K. Le Guin"
    }
  ],
  "intent": "queued"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
