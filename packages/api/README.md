# @enbox/api

> **Research Preview** -- Enbox is under active development. APIs may change without notice.

[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/api.json)](https://github.com/enboxorg/enbox/actions/workflows/ci.yml)

The high-level SDK for building decentralized applications with protocol-first data management.

## Installation

```bash
bun add @enbox/api
```

## Quick Start

```ts
import { defineProtocol, Web5 } from '@enbox/api';

// 1. Connect
const { web5, did: myDid } = await Web5.connect();

// 2. Define a protocol with typed data shapes
const NotesProtocol = defineProtocol({
  protocol  : 'https://example.com/notes',
  published : true,
  types     : {
    note: {
      schema      : 'https://example.com/schemas/note',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    note: {},
  },
} as const, {} as {
  note: { title: string; body: string };
});

// 3. Scope all operations to the protocol
const notes = web5.using(NotesProtocol);

// 4. Install the protocol
await notes.configure();

// 5. Write a record (path, data, and schema are type-checked)
const { record } = await notes.records.write('note', {
  data: { title: 'Hello', body: 'World' },
});

// 6. Send to your remote DWN
await record.send(myDid);
```

## Core Concepts

### `Web5.connect(options?)`

Connects to a local identity agent or generates an in-app DID.

```ts
const { web5, did, recoveryPhrase } = await Web5.connect();
```

**Options** (all optional):

| Option | Type | Description |
|--------|------|-------------|
| `agent` | `Web5Agent` | Custom agent instance. Defaults to a local `Web5UserAgent`. |
| `connectedDid` | `string` | Existing DID to connect to. |
| `password` | `string` | Password to protect the local identity vault. |
| `recoveryPhrase` | `string` | 12-word BIP-39 phrase for vault recovery. |
| `sync` | `string` | Sync interval (e.g. `'2m'`) or `'off'`. Default: `'2m'`. |
| `didCreateOptions.dwnEndpoints` | `string[]` | DWN endpoints for the created DID. |
| `walletConnectOptions` | `ConnectOptions` | Trigger external wallet connect flow. |

**Returns** `{ web5, did, recoveryPhrase?, delegateDid? }`.

---

### `Web5.anonymous(options?)`

Creates a lightweight, read-only instance for querying public DWN data. No identity, vault, or signing keys are required.

```ts
const { dwn } = Web5.anonymous();

const { records } = await dwn.records.query({
  from   : 'did:dht:alice...',
  filter : { protocol: 'https://example.com/notes', protocolPath: 'note' },
});

for (const record of records) {
  console.log(record.id, await record.data.text());
}
```

Returns a `{ dwn: DwnReaderApi }` with read-only `records.query()` and `records.read()`.

---

### `web5.using(protocol)`

The **primary interface** for all record operations. Returns a `TypedWeb5` instance scoped to the given protocol.

```ts
const notes = web5.using(NotesProtocol);
```

The returned object provides:

- **`notes.configure()`** -- Install the protocol on the local DWN.
- **`notes.records.write(path, request)`** -- Write a record at a protocol path.
- **`notes.records.query(path, request?)`** -- Query records at a path.
- **`notes.records.read(path, request)`** -- Read a single record.
- **`notes.records.delete(path, request)`** -- Delete a record by ID.
- **`notes.records.subscribe(path, request?)`** -- Subscribe to real-time changes (returns a `LiveQuery`).

Protocol URI, protocolPath, and schema are automatically injected into every operation.

---

### `defineProtocol(definition, schemaMap?)`

Creates a typed protocol definition that enables compile-time path autocompletion and data type checking.

```ts
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

const SocialProtocol = defineProtocol({
  protocol  : 'https://social.example/protocol',
  published : true,
  types: {
    profile : { schema: 'https://social.example/schemas/profile', dataFormats: ['application/json'] },
    post    : { schema: 'https://social.example/schemas/post',    dataFormats: ['application/json'] },
    reply   : { schema: 'https://social.example/schemas/reply',   dataFormats: ['application/json'] },
  },
  structure: {
    profile : {},
    post    : {
      reply: {},
    },
  },
} as const satisfies ProtocolDefinition, {} as {
  profile : { displayName: string; bio?: string };
  post    : { title: string; body: string };
  reply   : { body: string };
});
```

The `schemaMap` is a phantom type -- it exists only at compile time. Pass `{} as YourSchemaMap` as the second argument.

---

### Record Instances

Methods like `write`, `query`, and `read` return `Record` instances.

**Properties**: `id`, `contextId`, `dataFormat`, `dateCreated`, `timestamp`, `datePublished`, `protocol`, `protocolPath`, `recipient`, `schema`, `dataCid`, `dataSize`, `published`.

**Data accessors**:

```ts
await record.data.text();          // string
await record.data.json<MyType>();  // typed JSON
await record.data.blob();          // Blob
await record.data.bytes();         // Uint8Array
await record.data.stream();        // ReadableStream
```

**Mutators** (return a new `Record` instance):

```ts
const { record: updated } = await record.update({ data: { title: 'New Title', body: '...' } });
const { status } = await record.delete();
```

**Side-effect methods** (return status only):

```ts
await record.send(targetDid);     // send to a remote DWN
await record.store();             // persist locally
await record.import();            // import from a remote DWN
```

---

### LiveQuery (Subscriptions)

`records.subscribe()` returns a `LiveQuery` that provides an initial snapshot plus real-time deduplicated change events.

```ts
const { liveQuery } = await notes.records.subscribe('post');

liveQuery.on('create', (record) => { /* new record */ });
liveQuery.on('update', (record) => { /* updated record */ });
liveQuery.on('delete', (record) => { /* deleted record */ });

// Clean up
await liveQuery.close();
```

---

## Advanced Usage

For power users who need direct, unscoped DWN access (e.g. cross-protocol queries, raw permission management), import from the `@enbox/api/advanced` sub-path:

```ts
import { DwnApi } from '@enbox/api/advanced';
```

The `DwnApi` class provides raw `records`, `protocols`, and `permissions` accessors without protocol scoping. Most applications should use `web5.using()` instead.

---

## DID Operations

```ts
// Create a DID
const myDid = await web5.did.create('dht');

// Resolve a DID
const { didDocument } = await web5.did.resolve('did:dht:abc...');
```

## License

Apache-2.0
