# Books

Books/editions, reading state, progress, highlights, and personal reviews.

Module URI: `https://enbox.id/modules/books/v1`

Import `BooksModule`, `BooksDefinition`, `BooksCodecs`, and `BooksSchemas` from `@enbox/modules/books`. `BooksCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `book` | [JSON Schema](schemas/book.json) | Encrypted | Mutable |
| `book/reading` | [JSON Schema](schemas/reading.json) | Encrypted | Mutable |
| `book/highlight` | [JSON Schema](schemas/highlight.json) | Encrypted | Mutable |
| `book/review` | [JSON Schema](schemas/review.json) | Encrypted | Mutable |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. An editor can change shared content; a viewer can read the paths explicitly granting that role. Record-specific action lists remain authoritative.

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { BooksModule } from '@enbox/modules/books';

const records = enbox.using(BooksModule).records;
await records.create('book', {
  data: {
  "title": "Dune",
  "authors": [
    "Frank Herbert"
  ],
  "state": "reading"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
