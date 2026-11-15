# Flashcards

Study cards, decks or grouping references, and private review state/history.

Module URI: `https://enbox.id/modules/flashcards/v1`

Import `FlashcardsModule`, `FlashcardsDefinition`, `FlashcardsCodecs`, and `FlashcardsSchemas` from `@enbox/modules/flashcards`. `FlashcardsCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
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

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. An editor can change shared content; a viewer can read the paths explicitly granting that role. Record-specific action lists remain authoritative.

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

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
