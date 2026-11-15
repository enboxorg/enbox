# Stock Watchlists

Instruments being watched, reasons, user-stated targets, and research references.

Module URI: `https://enbox.id/modules/stock-watchlists/v1`

Import `StockWatchlistsModule`, `StockWatchlistsDefinition`, `StockWatchlistsCodecs`, and `StockWatchlistsSchemas` from `@enbox/modules/stock-watchlists`. `StockWatchlistsCatalog` includes the actual writable paths, bundled schemas, and examples.

## Artifacts

- [Raw definition](definition.json)
- [Directory metadata](catalog.json)
- [Complete record examples](examples.json)

| Path | Representation | Data policy | Record policy |
| --- | --- | --- | --- |
| `watchlist` | [JSON Schema](schemas/watchlist.json) | Encrypted | Mutable |
| `watchlist/instrument` | [JSON Schema](schemas/instrument.json) | Encrypted | Mutable |
| `watchlist/instrument/note` | [JSON Schema](schemas/note.json) | Encrypted | Mutable |
| `watchlist/editor` | [JSON Schema](schemas/editor.json) | Plaintext | Membership |
| `watchlist/viewer` | [JSON Schema](schemas/viewer.json) | Plaintext | Membership |

## Dependencies and ownership

This module has no structural module dependencies. Payload links retain their targets' ownership and permissions.

The definition's `published` flag describes definition discovery. Record access is governed by the definition's explicit actions. Roles are assigned by the owner; a role's recipient is in the signed DWN descriptor, and its data is `{}`. Without assigned roles or grants, private paths remain owner-only. Record-specific action lists remain authoritative.

## Actions

The owner retains tenant authority. These rules describe additional authority. `update`, `delete`, and `prune` act on the signer's own authored records; their `co-` variants allow acting on other authors' records. A `who: recipient` rule is scoped to that record's recipient: `co-delete` on a role assignment allows self-removal, never removal of another recipient. Self-removal uses the actor rule without invoking `moduleRole`. Viewers are read-only apart from leaving their own membership.

| Path | Additional authority |
| --- | --- |
| `watchlist` | role watchlist/editor: read, co-update<br>role watchlist/viewer: read |
| `watchlist/instrument` | role watchlist/editor: create, read, co-update<br>role watchlist/viewer: read |
| `watchlist/instrument/note` | role watchlist/editor: create, read, update, delete<br>role watchlist/viewer: read |
| `watchlist/editor` | recipient of watchlist/editor: read<br>recipient of this record: co-delete |
| `watchlist/viewer` | recipient of watchlist/viewer: read<br>recipient of this record: co-delete |

Immutable records reject updates. A singleton uses `$recordLimit` projection semantics; it does not reject every competing create. Pruning follows actual descendants, including composed descendants; data links do not cascade.

## Use

Start with an authenticated Enbox session and include this module in the application's module manifest. Dependency artifacts are carried by the typed module and installed before consumers.

```ts
import { StockWatchlistsModule } from '@enbox/modules/stock-watchlists';

const records = enbox.using(StockWatchlistsModule).records;
await records.create('watchlist', {
  data: {
  "name": "Technology watchlist"
},
});
```

The JSON codecs validate on encode and decode. Examples are illustrative data; imported claims remain subject to their original provenance. See the [package guide](../../README.md) for shared reference, money, source, and access semantics.
