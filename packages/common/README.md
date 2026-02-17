# Enbox Common

> **Research Preview** — Enbox is under active development. APIs may change without notice.

Shared utilities used across the Enbox monorepo — data conversion, key-value stores, caching, streams, and type helpers.

## Installation

```bash
bun add @enbox/common
```

## Exports

### `Convert`

Fluent data-format conversion between ArrayBuffer, Base32Z, Base58Btc, Base64Url, Hex, Multibase, JSON objects, strings, and Uint8Array.

```typescript
import { Convert } from '@enbox/common';

const bytes = Convert.string('hello').toUint8Array();
const hex = Convert.uint8Array(bytes).toHex();
const b64 = Convert.hex(hex).toBase64Url();
```

### `LevelStore` / `MemoryStore`

Implementations of the `KeyValueStore<K, V>` interface — LevelDB-backed (persistent) and Map-backed (in-memory).

```typescript
import { LevelStore, MemoryStore } from '@enbox/common';

const persistent = new LevelStore({ location: './data' });
const ephemeral = new MemoryStore();

await persistent.set('key', 'value');
const value = await persistent.get('key');
```

### `TtlCache`

Time-to-live in-memory cache (re-export of `@isaacs/ttlcache`).

### `Stream`

Utilities for Web Streams API — create streams from blobs/bytes, consume to various formats, type guards.

### `Multicodec`

Multicodec-prefixed binary data utilities. Pre-registers Ed25519, X25519, and secp256k1 key codecs.

### Type Utilities

- `universalTypeOf()` — Cross-context type detection
- `isDefined()` / `isAsyncIterable()` / `isArrayBufferSlice()` — Type guards
- `isEmptyObject()` / `removeEmptyObjects()` / `removeUndefinedProperties()` — Object helpers

## Development

```bash
bun run build
bun run test:node
bun run lint
```

## License

Apache-2.0
