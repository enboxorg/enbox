# @enbox/api

> **Research Preview** -- Enbox is under active development. APIs may change without notice.

[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/api.json)](https://github.com/enboxorg/enbox/actions/workflows/ci.yml)

The high-level SDK for building decentralized applications with protocol-first data management. This is the main consumer-facing package in the Enbox ecosystem -- most applications only need `@enbox/api`.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
  - [Web5.connect()](#web5connectoptions)
  - [defineProtocol()](#defineprotocoldefinition-schemamap)
  - [web5.using()](#web5usingprotocol)
  - [Record Instances](#record-instances)
  - [LiveQuery (Subscriptions)](#livequery-subscriptions)
  - [Web5.anonymous()](#web5anonymousoptions)
- [Repository Pattern](#repository-pattern)
  - [Collections vs Singletons](#collections-vs-singletons)
  - [Nested Records](#nested-records-1)
  - [Using Pre-built Protocols](#using-pre-built-protocols)
- [Cookbook](#cookbook)
  - [Nested Records](#nested-records)
  - [Querying with Filters and Pagination](#querying-with-filters-and-pagination)
  - [Tags](#tags)
  - [Publishing Records](#publishing-records)
  - [Reading Public Data Anonymously](#reading-public-data-anonymously)
  - [Sending Records to Remote DWNs](#sending-records-to-remote-dwns)
- [Code Generation](#code-generation)
- [Advanced Usage](#advanced-usage)
  - [Unscoped DWN Access](#unscoped-dwn-access)
  - [Permissions](#permissions)
  - [DID Operations](#did-operations)
- [API Reference](#api-reference)
- [License](#license)

## Installation

```bash
bun add @enbox/api
```

## Quick Start

```ts
import { defineProtocol, Web5 } from '@enbox/api';

// 1. Connect -- creates or loads a local identity and agent
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

// 4. Install the protocol on the local DWN
await notes.configure();

// 5. Create a record -- path, data, and schema are type-checked
const { record } = await notes.records.create('note', {
  data: { title: 'Hello', body: 'World' },
});

// 6. Query records back -- data is typed automatically
const { records } = await notes.records.query('note');
for (const r of records) {
  const note = await r.data.json(); // { title: string; body: string }
  console.log(r.id, note.title);
}

// 7. Send to your remote DWN
await record.send(myDid);
```

## Core Concepts

### `Web5.connect(options?)`

Connects to a local identity agent. On first launch it creates an identity vault, generates a `did:dht` DID, and starts the sync engine. On subsequent launches it unlocks the existing vault.

```ts
const { web5, did, recoveryPhrase } = await Web5.connect({
  password: 'user-chosen-password',
});

// recoveryPhrase is returned on first launch only -- store it safely!
```

**Options** (all optional):

| Option | Type | Description |
|--------|------|-------------|
| `password` | `string` | Password to protect the local identity vault. **Defaults to an insecure static value** -- always set this in production. |
| `recoveryPhrase` | `string` | 12-word BIP-39 phrase for vault recovery. Generated automatically on first launch if not provided. |
| `sync` | `string` | Sync interval (e.g. `'2m'`, `'30s'`) or `'off'` to disable. Default: `'2m'`. |
| `didCreateOptions.dwnEndpoints` | `string[]` | DWN service endpoints for the created DID. Default: `['https://enbox-dwn.fly.dev']`. |
| `connectedDid` | `string` | Use an existing DID instead of creating a new one. |
| `agent` | `Web5Agent` | Provide a custom agent instance. Defaults to a local `Web5UserAgent`. |
| `walletConnectOptions` | `ConnectOptions` | Trigger an external wallet connect flow for delegated identity. |
| `registration` | `{ onSuccess, onFailure }` | Callbacks for DWN endpoint registration status. |

**Returns** `{ web5, did, recoveryPhrase?, delegateDid? }`.

- `web5` -- the `Web5` instance for all subsequent operations
- `did` -- the connected DID URI (e.g. `did:dht:abc...`)
- `recoveryPhrase` -- only returned on first initialization
- `delegateDid` -- only present when using wallet connect

---

### `defineProtocol(definition, schemaMap?)`

Creates a typed protocol definition that enables compile-time path autocompletion and data type checking when used with `web5.using()`.

```ts
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

const ChatProtocol = defineProtocol({
  protocol  : 'https://example.com/chat',
  published : true,
  types: {
    thread  : { schema: 'https://example.com/schemas/thread',  dataFormats: ['application/json'] },
    message : { schema: 'https://example.com/schemas/message', dataFormats: ['application/json'] },
  },
  structure: {
    thread: {
      message: {},   // messages are nested under threads
    },
  },
} as const satisfies ProtocolDefinition, {} as {
  thread  : { title: string; description?: string };
  message : { text: string };
});
```

The second argument is a **phantom type** -- it only exists at compile time. Pass `{} as YourSchemaMap` to map protocol type names to TypeScript interfaces. The runtime value is ignored.

This gives you:
- **Path autocompletion**: `'thread'`, `'thread/message'` are inferred from `structure`
- **Typed `data` payloads**: `write('thread', { data: ... })` type-checks against the schema map
- **Typed `dataFormat`**: restricted to the formats declared in the protocol type

---

### `web5.using(protocol)`

The **primary interface** for all record operations. Returns a `TypedWeb5` instance scoped to the given protocol.

```ts
const chat = web5.using(ChatProtocol);
```

#### `configure()`

Installs the protocol on the local DWN. If already installed with an identical definition, this is a no-op. If the definition has changed, it reconfigures with the updated version.

```ts
await chat.configure();
```

#### `records.create(path, request)`

Create a new record at a protocol path. The protocol URI, protocolPath, schema, and dataFormat are automatically injected. Returns a `TypedRecord<T>` where `T` is inferred from the schema map.

```ts
const { record, status } = await chat.records.create('thread', {
  data: { title: 'General', description: 'General discussion' },
});

console.log(status.code);  // 202
console.log(record.id);    // unique record ID

// record is TypedRecord<{ title: string; description?: string }>
const data = await record.data.json(); // typed -- no cast needed
```

To mutate an existing record, use the instance method `record.update()`:

```ts
const { record: updated } = await record.update({
  data: { title: 'Updated Title', description: 'New description' },
});
```

#### `records.query(path, request?)`

Query records at a protocol path. Returns `TypedRecord<T>[]` with optional pagination.

```ts
const { records, cursor } = await chat.records.query('thread', {
  dateSort   : 'createdDescending',
  pagination : { limit: 20 },
});

// records is TypedRecord<{ title: string; description?: string }>[]
for (const thread of records) {
  const data = await thread.data.json(); // typed automatically
  console.log(data.title);
}

// Fetch next page
if (cursor) {
  const { records: nextPage } = await chat.records.query('thread', {
    pagination: { limit: 20, cursor },
  });
}
```

#### `records.read(path, request)`

Read a single record by filter criteria.

```ts
const { record } = await chat.records.read('thread', {
  filter: { recordId: 'bafyrei...' },
});

const data = await record.data.json();
```

#### `records.delete(path, request)`

Delete a record by ID.

```ts
const { status } = await chat.records.delete('thread', {
  recordId: record.id,
});
```

#### `records.subscribe(path, request?)`

Subscribe to real-time changes. Returns a `TypedLiveQuery<T>` with an initial snapshot of `TypedRecord<T>[]` plus a stream of typed change events.

```ts
const { liveQuery } = await chat.records.subscribe('thread/message');

// Initial snapshot -- typed records
for (const msg of liveQuery.records) {
  const data = await msg.data.json(); // { text: string } -- no cast
  console.log(data.text);
}

// Real-time updates -- typed records in handlers
liveQuery.on('create', (record) => console.log('new:', record.id));
liveQuery.on('update', (record) => console.log('updated:', record.id));
liveQuery.on('delete', (record) => console.log('deleted:', record.id));
```

All methods also accept a `from` option to query a remote DWN:

```ts
const { records } = await chat.records.query('thread', {
  from: 'did:dht:other-user...',
});
```

---

### Record Instances (`TypedRecord<T>`)

Methods like `create`, `query`, and `read` return `TypedRecord<T>` instances -- type-safe wrappers that preserve the data type `T` inferred from the schema map through the entire lifecycle (create, query, read, update, subscribe).

`TypedRecord<T>` exposes a typed `data.json()` that returns `Promise<T>` instead of `Promise<unknown>`, eliminating manual type casts. The underlying `Record` is accessible via `record.rawRecord` if needed.

**Properties**:

| Property | Description |
|----------|-------------|
| `id` | Unique record identifier |
| `contextId` | Context ID (scopes nested records to a parent thread) |
| `protocol` | Protocol URI |
| `protocolPath` | Path within the protocol structure (e.g. `'thread/message'`) |
| `schema` | Schema URI |
| `dataFormat` | MIME type of the data |
| `dataCid` | Content-addressed hash of the data |
| `dataSize` | Size of the data in bytes |
| `dateCreated` | ISO timestamp of creation |
| `timestamp` | ISO timestamp of most recent write |
| `datePublished` | ISO timestamp of publication (if published) |
| `published` | Whether the record is publicly readable |
| `author` | DID of the record author |
| `recipient` | DID of the intended recipient |
| `parentId` | Record ID of the parent record (for nested structures) |
| `tags` | Key-value metadata tags |
| `deleted` | Whether the record has been deleted |

**Data accessors** -- read the record payload in different formats:

```ts
const obj    = await record.data.json();   // T -- automatically typed from schema map
const text   = await record.data.text();   // string
const blob   = await record.data.blob();   // Blob
const bytes  = await record.data.bytes();  // Uint8Array
const stream = await record.data.stream(); // ReadableStream
```

**Mutators**:

```ts
// Update the record's data
const { record: updated } = await record.update({
  data: { title: 'Updated Title', body: '...' },
});

// Delete the record
const { status } = await record.delete();
```

**Side-effect methods**:

```ts
// Send the record to a remote DWN
await record.send(targetDid);

// Persist a remote record to the local DWN
await record.store();

// Import a record from a remote DWN into the local store
await record.import();
```

---

### LiveQuery (Subscriptions) -- `TypedLiveQuery<T>`

`records.subscribe()` returns a `TypedLiveQuery<T>` that provides an initial snapshot of `TypedRecord<T>[]` plus a real-time stream of deduplicated, typed change events.

```ts
const { liveQuery } = await chat.records.subscribe('thread/message');

// Initial snapshot -- TypedRecord<MessageData>[]
for (const msg of liveQuery.records) {
  const data = await msg.data.json(); // MessageData -- typed
  renderMessage(data);
}

// Real-time changes -- handlers receive TypedRecord<MessageData>
const offCreate = liveQuery.on('create', (record) => appendMessage(record));
const offUpdate = liveQuery.on('update', (record) => refreshMessage(record));
const offDelete = liveQuery.on('delete', (record) => removeMessage(record));

// Catch-all event (receives { type: 'create'|'update'|'delete', record: TypedRecord<T> })
liveQuery.on('change', ({ type, record }) => {
  console.log(`${type}: ${record.id}`);
});

// Unsubscribe from a specific handler
offCreate();

// Close the subscription entirely
await liveQuery.close();
```

The underlying `LiveQuery` is accessible via `liveQuery.rawLiveQuery` if needed. Events are automatically deduplicated against the initial snapshot -- you won't receive a `create` event for records already in the `records` array.

---

### `Web5.anonymous(options?)`

Creates a lightweight, read-only instance for querying public DWN data. No identity, vault, or signing keys are required.

```ts
const { dwn } = Web5.anonymous();

// Query published records from someone's DWN
const { records } = await dwn.records.query({
  from   : 'did:dht:alice...',
  filter : { protocol: 'https://example.com/notes', protocolPath: 'note' },
});

for (const record of records) {
  console.log(record.id, await record.data.text());
}

// Read a specific record
const { record } = await dwn.records.read({
  from   : 'did:dht:alice...',
  filter : { recordId: 'bafyrei...' },
});

// Count matching records
const { count } = await dwn.records.count({
  from   : 'did:dht:alice...',
  filter : { protocol: 'https://example.com/notes', protocolPath: 'note' },
});

// Query published protocols
const { protocols } = await dwn.protocols.query({
  from: 'did:dht:alice...',
});
```

Returns `ReadOnlyRecord` instances (no `update`, `delete`, `send`, or `store` methods). All calls require a `from` DID since the reader has no local DWN.

---

## Cookbook

### Nested Records

Protocols support hierarchical record structures. Child records reference their parent via `parentContextId`.

```ts
const ChatProtocol = defineProtocol({
  protocol  : 'https://example.com/chat',
  published : true,
  types: {
    thread  : { schema: 'https://example.com/schemas/thread',  dataFormats: ['application/json'] },
    message : { schema: 'https://example.com/schemas/message', dataFormats: ['application/json'] },
  },
  structure: {
    thread: {
      message: {},
    },
  },
} as const, {} as {
  thread  : { title: string };
  message : { text: string };
});

const chat = web5.using(ChatProtocol);
await chat.configure();

// Create a parent thread
const { record: thread } = await chat.records.create('thread', {
  data: { title: 'General' },
});

// Create a message nested under the thread
const { record: msg } = await chat.records.create('thread/message', {
  parentContextId : thread.contextId,
  data            : { text: 'Hello, world!' },
});

// Query messages within a specific thread
const { records: messages } = await chat.records.query('thread/message', {
  filter: { parentId: thread.id },
});
```

### Querying with Filters and Pagination

```ts
// Date-sorted, paginated query
const { records, cursor } = await notes.records.query('note', {
  dateSort   : 'createdDescending',
  pagination : { limit: 10 },
});

// Fetch next page using the cursor
if (cursor) {
  const { records: page2 } = await notes.records.query('note', {
    dateSort   : 'createdDescending',
    pagination : { limit: 10, cursor },
  });
}

// Filter by recipient
const { records: shared } = await notes.records.query('note', {
  filter: { recipient: 'did:dht:bob...' },
});

// Query from a remote DWN
const { records: remote } = await notes.records.query('note', {
  from: 'did:dht:alice...',
});
```

### Tags

Tags are key-value metadata attached to records, useful for filtering without parsing record data.

```ts
const { record } = await notes.records.create('note', {
  data : { title: 'Meeting Notes', body: '...' },
  tags : { category: 'work', priority: 'high' },
});

// Query by tag
const { records } = await notes.records.query('note', {
  filter: { tags: { category: 'work' } },
});
```

> Note: tags must be declared in your protocol's type definition for the DWN engine to index them.

### Publishing Records

Published records are publicly readable by anyone, including anonymous readers.

```ts
const { record } = await notes.records.create('note', {
  data      : { title: 'Public Note', body: 'Visible to everyone' },
  published : true,
});
```

### Reading Public Data Anonymously

```ts
const { dwn } = Web5.anonymous();

const { records } = await dwn.records.query({
  from   : 'did:dht:alice...',
  filter : {
    protocol     : 'https://example.com/notes',
    protocolPath : 'note',
  },
});

for (const record of records) {
  const note = await record.data.json();
  console.log(note.title);
}
```

### Sending Records to Remote DWNs

Records are initially written to the local DWN. Use `send()` to push them to a remote DWN, or rely on the automatic sync engine.

```ts
// Explicitly send to your own remote DWN
await record.send(myDid);

// Send to someone else's DWN (requires protocol permissions)
await record.send('did:dht:bob...');
```

The sync engine (enabled by default at 2-minute intervals) automatically synchronizes records between local and remote DWNs. For most use cases, you don't need to call `send()` manually.

---

## Repository Pattern

The `repository()` factory provides a higher-level abstraction over `TypedWeb5`. Instead of passing path strings to every call, you get a **structure-aware object** with CRUD methods directly on each protocol type -- with automatic singleton detection.

```ts
import { defineProtocol, repository, Web5 } from '@enbox/api';

const { web5 } = await Web5.connect({ password: 'secret' });

const TaskProtocol = defineProtocol({
  protocol  : 'https://example.com/tasks',
  published : false,
  types: {
    project : { schema: 'https://example.com/schemas/project', dataFormats: ['application/json'] },
    task    : { schema: 'https://example.com/schemas/task',    dataFormats: ['application/json'] },
    config  : { schema: 'https://example.com/schemas/config',  dataFormats: ['application/json'] },
  },
  structure: {
    project: {
      task: {},   // collection -- many tasks per project
    },
    config: {
      $recordLimit: { max: 1, strategy: 'reject' },  // singleton
    },
  },
} as const, {} as {
  project : { name: string; color?: string };
  task    : { title: string; completed: boolean };
  config  : { defaultView: 'list' | 'board' };
});

const repo = repository(web5.using(TaskProtocol));
await repo.configure();
```

### Collections vs Singletons

The repository automatically detects types with `$recordLimit: { max: 1 }` and provides different APIs:

**Collections** (default) -- `create`, `query`, `get`, `delete`, `subscribe`:

```ts
// Create
const { record } = await repo.project.create({
  data: { name: 'Website Redesign', color: '#3b82f6' },
});

// Query all
const { records } = await repo.project.query();

// Query with filters and pagination
const { records: recent, cursor } = await repo.project.query({
  dateSort   : 'createdDescending',
  pagination : { limit: 10 },
});

// Get by record ID
const { record: project } = await repo.project.get(recordId);

// Delete
await repo.project.delete(recordId);

// Subscribe to real-time changes
const { liveQuery } = await repo.project.subscribe();
liveQuery.on('create', (record) => console.log('new project:', record.id));
```

**Singletons** (`$recordLimit: { max: 1 }`) -- `set`, `get`, `delete`:

```ts
// Set (creates or updates)
await repo.config.set({
  data: { defaultView: 'board' },
});

// Get the single record
const { record: config } = await repo.config.get();
const { defaultView } = await config.data.json(); // 'board'

// Delete
await repo.config.delete(config.id);
```

### Nested Records

Nested types take `parentContextId` as the first argument:

```ts
// Create a task under a project
const { record: task } = await repo.project.task.create(project.contextId, {
  data: { title: 'Design mockups', completed: false },
});

// Query tasks within a project
const { records: tasks } = await repo.project.task.query(project.contextId);

// Subscribe to tasks within a project
const { liveQuery } = await repo.project.task.subscribe(project.contextId);
```

### Using Pre-built Protocols

The `@enbox/protocols` package provides production-ready protocol definitions. Combined with `repository()`, you get zero-boilerplate typed data access:

```ts
import { repository, Web5 } from '@enbox/api';
import {
  PreferencesProtocol,
  ProfileProtocol,
  SocialGraphProtocol,
} from '@enbox/protocols';

const { web5 } = await Web5.connect({ password: 'secret' });

// Social Graph -- friend, block, group, member
const social = repository(web5.using(SocialGraphProtocol));
await social.configure();

const { record } = await social.friend.create({
  data: { did: 'did:dht:alice...', alias: 'Alice' },
});

// Profile -- profile (singleton), avatar, hero, link, privateNote
const profile = repository(web5.using(ProfileProtocol));
await profile.configure();

await profile.profile.set({
  data: { displayName: 'Bob', bio: 'Building the decentralized web' },
});

// Add links nested under the profile
const { record: p } = await profile.profile.get();
await profile.profile.link.create(p.contextId, {
  data: { url: 'https://github.com/bob', title: 'GitHub' },
});

// Preferences -- theme, locale, privacy (singletons), notification (collection)
const prefs = repository(web5.using(PreferencesProtocol));
await prefs.configure();

await prefs.theme.set({ data: { mode: 'dark', accentColor: '#8b5cf6' } });
await prefs.locale.set({ data: { language: 'en', timezone: 'America/New_York' } });
```

See [`@enbox/protocols`](../protocols) for the full catalog of 6 protocols and 19 typed data shapes.

---

## Code Generation

For protocols defined externally (e.g. from a spec or shared JSON file), use `@enbox/protocol-codegen` to generate TypeScript types from a protocol definition and JSON Schemas:

```bash
bunx @enbox/protocol-codegen generate \
  --definition ./my-protocol.json \
  --schemas ./schemas/ \
  --name MyProtocol \
  --output ./my-protocol.generated.ts
```

This generates:
- TypeScript interfaces for each type's JSON Schema (via `json-schema-to-typescript`)
- A `SchemaMap` mapping type names to generated interfaces
- A ready-to-use `defineProtocol()` call

See [`@enbox/protocol-codegen`](../protocol-codegen) for full documentation.

---

## Advanced Usage

### Unscoped DWN Access

For power users who need direct DWN access without protocol scoping (e.g. cross-protocol queries, raw permission management), import from the `@enbox/api/advanced` sub-path:

```ts
import { DwnApi } from '@enbox/api/advanced';
```

The `DwnApi` class provides raw `records`, `protocols`, and `permissions` accessors without automatic protocol/path/schema injection. You must provide those fields manually in every call. Most applications should use `web5.using()` instead.

### Permissions

The DWN permission system supports fine-grained access control through permission requests, grants, and revocations.

```ts
import { DwnApi } from '@enbox/api/advanced';

// Query existing permission grants
const grants = await web5._dwn.permissions.queryGrants();

// Request permissions from another DWN
const request = await web5._dwn.permissions.request({
  scope: {
    interface : 'Records',
    method    : 'Write',
    protocol  : 'https://example.com/notes',
  },
});

// Send the request to the target DWN
await request.send('did:dht:alice...');
```

### DID Operations

```ts
// Resolve any DID
const { didDocument } = await web5.did.resolve('did:dht:abc...');
```

---

## API Reference

### Main Exports (`@enbox/api`)

| Export | Description |
|--------|-------------|
| `Web5` | Main entry point -- `connect()`, `anonymous()`, `using()` |
| `defineProtocol()` | Factory for creating typed protocol definitions |
| `repository()` | Factory for creating structure-aware CRUD repositories from `TypedWeb5` |
| `TypedWeb5` | Protocol-scoped API returned by `web5.using()` -- `create`, `query`, `read`, `delete`, `subscribe` |
| `TypedRecord<T>` | Type-safe record wrapper -- `data.json()` returns `Promise<T>` |
| `TypedLiveQuery<T>` | Type-safe subscription with `TypedRecord<T>[]` snapshot and typed change events |
| `Record` | Mutable record instance with data accessors and side-effect methods |
| `ReadOnlyRecord` | Immutable record for anonymous/read-only access |
| `LiveQuery` | Real-time subscription with initial snapshot and change events |
| `Protocol` | Protocol metadata wrapper |
| `PermissionGrant` | Permission grant record |
| `PermissionRequest` | Permission request record |
| `PermissionGrantRevocation` | Permission revocation record |
| `DidApi` | DID resolution |
| `VcApi` | Verifiable Credentials (not yet implemented) |
| `DwnReaderApi` | Read-only DWN API for anonymous access |

### Advanced Export (`@enbox/api/advanced`)

| Export | Description |
|--------|-------------|
| `DwnApi` | Full unscoped DWN API with `records`, `protocols`, `permissions` |

### Key Types

| Export | Description |
|--------|-------------|
| `TypedProtocol<D, M>` | Typed protocol wrapper with definition and schema map |
| `ProtocolPaths<D>` | Union of valid slash-delimited paths for a protocol definition |
| `SchemaMap` | Maps protocol type names to TypeScript interfaces |
| `TypedCreateRequest<D, M, Path>` | Options for `records.create()` |
| `TypedCreateResponse<T>` | Response from `records.create()` -- `{ status, record: TypedRecord<T> }` |
| `TypedQueryRequest` | Options for `records.query()` |
| `TypedQueryResponse<T>` | Response from `records.query()` -- `{ status, records: TypedRecord<T>[], cursor? }` |
| `TypedSubscribeResponse<T>` | Response from `records.subscribe()` -- `{ status, liveQuery: TypedLiveQuery<T> }` |
| `Repository<D, M>` | Repository type -- structure-aware Proxy object with CRUD methods |
| `DataForPath<D, M, Path>` | Resolves TypeScript data type for a protocol path from the schema map |
| `Web5ConnectOptions` | Options for `Web5.connect()` |
| `Web5ConnectResult` | Return type of `Web5.connect()` |
| `RecordModel` | Structured data model of a record |
| `RecordChangeType` | `'create' \| 'update' \| 'delete'` |
| `RecordChange` | Change event payload `{ type, record }` |

## License

Apache-2.0
