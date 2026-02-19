# Web Streams Migration Plan

## Background

When the DWN SDK was originally written, the Web Streams API (`ReadableStream`, `WritableStream`,
`TransformStream`) was not yet standardized across runtimes. The codebase adopted
`readable-stream` (a Node.js `Readable`/`Writable`/etc. polyfill that works in browsers) as its
canonical stream primitive.

Today, the Web Streams API is natively available in:
- **Node.js 18+** (LTS, full support since Node 16.5 behind flag)
- **Bun** (full support)
- **Deno** (full support)
- **All modern browsers** (Chrome 43+, Firefox 65+, Safari 14.5+)

This makes `readable-stream` largely unnecessary overhead. The migration replaces Node-style
streams with standard Web `ReadableStream` throughout the stack, simplifying cross-platform
support and reducing the dependency footprint.

---

## Current Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  @enbox/api  (Record class)                                     │
│  - Stores data as Node Readable internally                      │
│  - data.stream() returns Node Readable                          │
│  - Converts Web ReadableStream -> Node Readable on input        │
├─────────────────────────────────────────────────────────────────┤
│  @enbox/agent  (AgentDwnApi)                                    │
│  - ProcessDwnRequest accepts Blob | ReadableStream | Readable   │
│  - Uses `readable-web-to-node-stream` (REDUNDANT dep)           │
│  - Also uses NodeStream.fromWebReadable from @enbox/common      │
├─────────────────────────────────────────────────────────────────┤
│  @enbox/common  (Stream utilities)                              │
│  - Stream class (Web ReadableStream utilities)                  │
│  - NodeStream class (Node Readable utilities + conversion)      │
│  - Re-exports Readable from readable-stream                     │
├─────────────────────────────────────────────────────────────────┤
│  @enbox/dwn-sdk-js  (DWN core)                                  │
│  - ALL interfaces use Readable from readable-stream             │
│  - DataStore.put/get, MethodHandler, Dwn.processMessage()       │
│  - DataStream utility, encryption, CID computation              │
│  - data-store-level uses ipfs-unixfs-importer (AsyncIterable)   │
├─────────────────────────────────────────────────────────────────┤
│  @enbox/dwn-sql-store                                           │
│  - DataStoreSql uses Readable from readable-stream              │
├─────────────────────────────────────────────────────────────────┤
│  @enbox/dwn-server                                              │
│  - HTTP handler uses Bun.serve() (Request body is ReadableStream│
│    natively — no Express, no Node Readable)                     │
└─────────────────────────────────────────────────────────────────┘
```

### Dependencies involved:
| Package           | Dep                          | Purpose                        |
|-------------------|------------------------------|--------------------------------|
| dwn-sdk-js        | `readable-stream` 4.5.2     | Core stream primitive          |
| common            | `readable-stream` 4.5.2     | NodeStream utilities           |
| dwn-sql-store     | `readable-stream` 4.4.2     | DataStoreSql                   |
| dwn-server        | N/A (uses `Bun.serve()`)    | HTTP handler uses native Web Request/Response |
| agent             | `readable-web-to-node-stream`| Web->Node conversion (REDUNDANT)|

---

## Phase 1: Simplify Outer Layers (THIS PR)

**Goal:** Remove redundant dependencies, unify Web<->Node conversion paths, and begin
exposing Web ReadableStream as the public-facing API.

### 1.1 Remove `readable-web-to-node-stream` from `@enbox/agent`

**Files changed:**
- `packages/agent/package.json` - Remove `readable-web-to-node-stream` dependency
- `packages/agent/src/utils.ts` - Replace `blobToIsomorphicNodeReadable()` and
  `webReadableToIsomorphicNodeReadable()` with `NodeStream.fromWebReadable()` from `@enbox/common`
- `packages/agent/src/dwn-api.ts` - Update imports and call sites

**Rationale:** `@enbox/common` already provides `NodeStream.fromWebReadable()` which does the
same thing. Having two mechanisms for the same conversion is confusing and adds an unnecessary
third-party dependency.

### 1.2 Add Web ReadableStream factory helpers to `@enbox/common`

**Files changed:**
- `packages/common/src/stream.ts` - Add `Stream.fromBytes()` and `Stream.fromBlob()`

These are the Web-stream equivalents of `DataStream.fromBytes()` and
`DataStream.fromObject()`. They create a `ReadableStream<Uint8Array>` from common
input types, useful across the agent and API layers.

### 1.3 Simplify `Record.data` in `@enbox/api`

**Files changed:**
- `packages/api/src/record.ts` - Change `data.stream()` return type from `Readable` to
  `ReadableStream`. Use `Stream` utilities instead of `NodeStream` for consumption.

**Before:**
```ts
data.stream(): Promise<Readable>     // Node stream
data.blob(): Promise<Blob>           // via NodeStream.consumeToBytes
data.json(): Promise<any>            // via NodeStream.consumeToJson
data.text(): Promise<string>         // via NodeStream.consumeToText
```

**After:**
```ts
data.stream(): Promise<ReadableStream>  // Web stream (works everywhere)
data.blob(): Promise<Blob>              // via Stream.consumeToBlob
data.json(): Promise<any>               // via Stream.consumeToJson
data.text(): Promise<string>            // via Stream.consumeToText
```

The internal `_readableStream` field changes from `Readable` to `ReadableStream`.
Where DWN SDK returns a Node `Readable` (from read replies), we convert to Web
`ReadableStream` using `NodeStream.toWebReadable()`.

### 1.4 Clean up sync-engine-level

**Files changed:**
- `packages/agent/src/sync-engine-level.ts` - Use `NodeStream.fromWebReadable()`
  consistently, remove unsafe `as unknown as ReadableStream` cast.

---

## Phase 2: Migrate DWN SDK Core to Web ReadableStream

**Goal:** Replace `Readable` from `readable-stream` with Web `ReadableStream` as the canonical
stream type throughout the DWN engine.

### 2.1 Change core interfaces

**Files to change:**
- `packages/dwn-sdk-js/src/types/data-store.ts`
  - `DataStore.put()`: `dataStream: Readable` -> `dataStream: ReadableStream<Uint8Array>`
  - `DataStoreGetResult.dataStream`: `Readable` -> `ReadableStream<Uint8Array>`
- `packages/dwn-sdk-js/src/types/method-handler.ts`
  - `MethodHandler.handle()`: `dataStream?: Readable` -> `dataStream?: ReadableStream<Uint8Array>`
- `packages/dwn-sdk-js/src/types/records-types.ts`
  - `RecordsWriteMessageOptions.dataStream`: `Readable` -> `ReadableStream<Uint8Array>`
  - `RecordsReadReplyEntry.data`: `Readable` -> `ReadableStream<Uint8Array>`
- `packages/dwn-sdk-js/src/types/messages-types.ts`
  - `MessagesReadReplyEntry.data`: `Readable` -> `ReadableStream<Uint8Array>`
- `packages/dwn-sdk-js/src/dwn.ts`
  - `MessageOptions.dataStream`: `Readable` -> `ReadableStream<Uint8Array>`

### 2.2 Migrate `DataStream` utility

**File:** `packages/dwn-sdk-js/src/utils/data-stream.ts`

Replace all `Readable` usage with `ReadableStream`:

```ts
// Before
static fromBytes(bytes: Uint8Array): Readable
static toBytes(readableStream: Readable): Promise<Uint8Array>
static duplicateDataStream(dataStream: Readable, count: number): Readable[]

// After
static fromBytes(bytes: Uint8Array): ReadableStream<Uint8Array>
static toBytes(readableStream: ReadableStream<Uint8Array>): Promise<Uint8Array>
static duplicateDataStream(dataStream: ReadableStream<Uint8Array>, count: number): ReadableStream<Uint8Array>[]
```

For `duplicateDataStream`, replace `PassThrough.pipe()` with `ReadableStream.tee()` (for 2
copies) or a custom `TransformStream`-based fan-out for N copies.

For `fromBytes`, use the Web ReadableStream constructor:
```ts
static fromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const chunkLength = 100_000;
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkLength, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    }
  });
}
```

### 2.3 Migrate `data-store-level.ts`

**Key concern:** `ipfs-unixfs-importer` expects `content: AsyncIterable<Uint8Array>`.

Web `ReadableStream` is not `AsyncIterable` in all runtimes. Solution: use
`Stream.asAsyncIterator()` (already exists in `@enbox/common`) or use
`ReadableStream.prototype[Symbol.asyncIterator]` where supported.

```ts
// In put():
const asyncDataBlocks = importer(
  [{ content: Stream.asAsyncIterator(dataStream) }],
  blockstoreForData,
  { cidVersion: 1 }
);

// In get():
return new ReadableStream({
  async pull(controller) {
    const result = await contentIterator.next();
    if (result.done) {
      controller.close();
    } else {
      controller.enqueue(result.value);
    }
  }
});
```

### 2.4 Migrate `encryption.ts`

**Key concern:** Uses `crypto.createCipheriv()` / `crypto.createDecipheriv()` which return
Node `Transform` streams, and listens for `data`/`end`/`error` events on Node `Readable`
input streams.

Option A (recommended): Use `TransformStream` from the Web Streams API:
```ts
static async aes256CtrEncrypt(
  key: Uint8Array, iv: Uint8Array, plaintextStream: ReadableStream<Uint8Array>
): Promise<ReadableStream<Uint8Array>> {
  const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(new Uint8Array(cipher.update(chunk)));
    },
    flush(controller) {
      const final = cipher.final();
      if (final.length > 0) controller.enqueue(new Uint8Array(final));
    }
  });
  return plaintextStream.pipeThrough(transform);
}
```

Option B: Use the Web Crypto API (`crypto.subtle.encrypt`) for AES-CTR. However, the Web
Crypto API doesn't support streaming — it requires all data upfront. Stick with Node `crypto`
via `TransformStream` adapter.

**Note:** `crypto.createCipheriv` is a Node.js-only API. For true browser compatibility,
consider using a WebAssembly AES implementation or restructuring to use Web Crypto's
`encrypt`/`decrypt` on full buffers. This is a bigger decision for later.

### 2.5 Migrate `cid.ts`

```ts
// Before
static async computeDagPbCidFromStream(dataStream: Readable): Promise<string>

// After
static async computeDagPbCidFromStream(dataStream: ReadableStream<Uint8Array>): Promise<string> {
  const asyncDataBlocks = importer(
    [{ content: Stream.asAsyncIterator(dataStream) }],
    new BlockstoreMock(),
    { cidVersion: 1 }
  );
  // ...
}
```

### 2.6 Migrate `records.ts` (decrypt)

```ts
// Before
static async decrypt(..., cipherStream: Readable): Promise<Readable>

// After
static async decrypt(..., cipherStream: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>>
```

### 2.7 Update all handlers

Each handler that receives or returns streams needs updating:
- `records-write.ts` handler
- `records-read.ts` handler
- `messages-read.ts` handler

### 2.8 Update `@enbox/dwn-sql-store`

```ts
// DataStoreSql.get() — return ReadableStream instead of Readable
return {
  dataSize: result.data.length,
  dataStream: new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(result.data));
      controller.close();
    }
  })
};

// DataStoreSql.put() — consume ReadableStream instead of Readable
const bytes = await Stream.consumeToBytes({ readableStream: dataStream });
```

### 2.9 Update `@enbox/dwn-server`

> **Note:** The HTTP API has already been migrated from Express to `Bun.serve()`. The `Request` object in Bun's fetch handler natively provides `request.body` as a `ReadableStream`. No conversion is needed at the server boundary.

### 2.10 Update `@enbox/agent` (inner layer)

- `ProcessDwnRequest.dataStream` type simplifies from `Blob | ReadableStream | Readable` to
  `Blob | ReadableStream`
- `DwnMessageWithData.dataStream` changes from `Readable` to `ReadableStream`
- `constructDwnMessage()` no longer needs Node-stream conversions

### 2.11 Remove `readable-stream` dependency

Once all usages are migrated:
- Remove from `dwn-sdk-js/package.json`
- Remove from `common/package.json`
- Remove from `dwn-sql-store/package.json`
- Remove from `dwn-server/package.json`
- Remove `@types/readable-stream` dev dependencies
- Remove `stream-browserify` dev dependency from `dwn-server`
- Remove `NodeStream` class from `@enbox/common` (or deprecate)
- Stop re-exporting `Readable` from `@enbox/common`

### 2.12 Update `@enbox/common`

- Deprecate/remove `NodeStream` class (keep `Stream` only)
- Remove `readable-stream` dependency
- The `Stream` class becomes the single source of truth for stream operations

---

## Migration Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| `ipfs-unixfs-importer` needs AsyncIterable, not ReadableStream | Use `Stream.asAsyncIterator()` adapter |
| `crypto.createCipheriv` is Node-only | Keep using it wrapped in TransformStream; browser crypto is a separate concern |
| Breaking change for external DataStore implementations | Bump major version; provide migration guide |
| `readable-stream` v4 Readable is used as AsyncIterable in for-await-of loops | ReadableStream supports this in modern runtimes; use `Stream.asAsyncIterator()` polyfill |
| dwn-server HTTP boundary | Already resolved — `Bun.serve()` provides Web `Request` with native `ReadableStream` body |

---

## Test Strategy

- All existing tests in `packages/common/tests/stream*.spec.ts` continue to pass
- All existing tests in `packages/dwn-sdk-js/tests/` continue to pass
- All existing tests in `packages/agent/tests/` continue to pass
- All existing tests in `packages/api/tests/` continue to pass
- Add new tests for `Stream.fromBytes()` and `Stream.fromBlob()` in Phase 1
