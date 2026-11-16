# Flashcards

Study cards, decks or grouping references, and private review state/history.

Module URI: `https://enbox.id/modules/flashcards/v1`

Import `FlashcardsModule`, `FlashcardsDefinition`, `FlashcardsCodecs`, and `FlashcardsSchemas` from `@enbox/modules/flashcards`. `FlashcardsCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Complete raw definition](definition.json)
- [Authoring source](source/definition.ts)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `card` | [JSON Schema](schemas/card.json) | Encrypted | Mutable |
| `deck` | [JSON Schema](schemas/deck.json) | Encrypted | Mutable |
| `deck/entry` | [JSON Schema](schemas/entry.json) | Encrypted | Mutable |
| `studySet` | [JSON Schema](schemas/study-set.json) | Encrypted | Mutable |
| `studySet/cardState` | [JSON Schema](schemas/card-state.json) | Encrypted | Mutable |
| `studySet/cardState/review` | [JSON Schema](schemas/review.json) | Encrypted | Immutable |
| `card/editor` | [JSON Schema](schemas/editor.json) | Plaintext | Membership |
| `card/viewer` | [JSON Schema](schemas/viewer.json) | Plaintext | Membership |
| `deck/editor` | [JSON Schema](schemas/editor.json) | Plaintext | Membership |
| `deck/viewer` | [JSON Schema](schemas/viewer.json) | Plaintext | Membership |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `card` | role card/editor: read, co-update<br>role card/viewer: read |
| `deck` | role deck/editor: read, co-update<br>role deck/viewer: read |
| `deck/entry` | role deck/editor: create, read, co-update, co-delete<br>role deck/viewer: read |
| `studySet` | Owner only |
| `studySet/cardState` | Owner only |
| `studySet/cardState/review` | Owner only |
| `card/editor` | recipient of card/editor: read<br>recipient of this record: co-delete |
| `card/viewer` | recipient of card/viewer: read<br>recipient of this record: co-delete |
| `deck/editor` | recipient of deck/editor: read<br>recipient of this record: co-delete |
| `deck/viewer` | recipient of deck/viewer: read<br>recipient of this record: co-delete |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Capture contract

**Identity:** Match the selected card and deck membership; text alone need not identify a unique card.

**Workflow:** Maintain cards and deck references; append study reviews under the user's private study state.

**Exclude:** Duplicating learning goals or converting a review attempt into a new card.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { FlashcardsModule } from '@enbox/modules/flashcards';

const records = enbox.using(FlashcardsModule).records;
await records.create('card', {
  data: {
  "front": "hola",
  "back": "hello",
  "language": "es"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
