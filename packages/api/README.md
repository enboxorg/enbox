# @enbox/api

> **Research Preview** -- Enbox is under active development. APIs may change without notice.

High-level SDK for app developers. Start here unless you specifically need the
lower-level agent, auth, or DWN packages.

## Install

```bash
bun add @enbox/api
```

## Connect

```ts
import { createConnectionStore } from '@enbox/api';
import { application } from './application.js';

const store = createConnectionStore({
  application,
  password     : userPassword,
  dwnEndpoints : ['https://enbox-dwn.fly.dev'],
});

let snapshot = await store.initialize();
if (snapshot.phase === 'disconnected') {
  snapshot = await store.connectVault({ createIdentity: true });
}
if (snapshot.phase !== 'connected') {
  throw snapshot.error ?? new Error('Connection was not established.');
}

const enbox = snapshot.enbox;
```

`createConnectionStore()` owns the common application lifecycle: it creates an
`AuthManager`, restores or connects a session, closes stale API facades when a
session changes, and publishes immutable snapshots:

Create exactly one store for each application/data-path pairing and keep it for
the application lifetime. Separate stores intentionally do not coordinate
lifecycle actions or snapshots, even when they target the same `dataPath`.

| Value | Description |
|---|---|
| `snapshot.enbox` | The high-level API instance while connected. |
| `snapshot.session` | Active DID, delegate DID when present, agent, and first-run recovery phrase. |
| `snapshot.session.did` | The active identity DID. |

Common store and connection options:

| Option | Description |
|---|---|
| `application` | Canonical typed protocols and delegated permission policies. |
| `password` | Local vault password. The default is insecure; production apps should pass one. |
| `connectVault({ createIdentity: true })` | Create a default identity when no identity exists. |
| `dwnEndpoints` | Remote DWN endpoints used when creating new DIDs. |
| `sync` | Omit for live sync, pass an interval like `'30s'`, or pass `'off'`. |
| `connectHandler` | Browser/wallet connect handler. |
| `registration` | DWN endpoint registration callbacks and token persistence options. |
| `auth` | Caller-owned `AuthManager`; other manager-construction options are ignored and `dispose()` does not shut it down. |

Call `store.disconnect()` when the user signs out and `store.dispose()` once at
application shutdown. Advanced integrations that already own an auth session
can use `Enbox.fromSession(session)` and must call `enbox.close()` before ending
that session. If you own a raw agent and DID, use
`new Enbox({ agent, connectedDid })` and close that facade explicitly too.
Closing fences typed record operations and session-scoped resources. It does
not revoke the shared `agent` or `did` surfaces, or a raw `dwn` reference
obtained before close; their lifecycle remains with their owner.

## Observable Connection and Sync State

`createConnectionStore()` publishes connection and selected-identity sync state
through one framework-neutral external-store contract:

```ts
import { createConnectionStore } from '@enbox/api';
import { application } from './application.js';

const store = createConnectionStore({ application, password: userPassword });
const unsubscribe = store.subscribe((snapshot) => {
  console.log(snapshot.phase, snapshot.sync?.state, snapshot.sync?.connectivity);
});

await store.initialize();
```

Connection snapshots report replication as `syncing`, `caught-up`, or `error`.
`syncing` covers any registered replica that is not current, including an
identity with no established links. `caught-up` means every current link is
caught up, or that the identity is local-only. `error` reports paused
replication or an unreadable local status projection. `connectivity` is
`unknown`, `online`, or `offline`, and `lastActivityAt` is the newest activity
time recorded by the sync engine.

For registered identities, connectivity uses the sync engine's existing
aggregation rule: any online link makes the identity online; otherwise an
offline link makes it offline, and no links fall back to the engine-wide state.

The frozen sync projection updates from existing events and local state without
polling. Its `remotes` rows cover only the DID's currently advertised endpoints,
in document order. `remoteDwn` is freshly resolved for a new session, after an
opted-in service-config wake, or when `refreshDwnEndpoints()` is called; use
`retryRemote(endpoint)` to validate that routing again before retrying that
remote's quota-blocked messages. References stay stable until a field changes.
During sign-out, `phase` becomes
`'disconnecting'` and session fields clear immediately; call `store.disconnect()`
so the store can expose that transition. Call `unsubscribe()` when the consumer
is released and `store.dispose()` at shutdown.

## Typed Protocols

```ts
import {
  createConnectionStore,
  defineApplicationManifest,
  defineProtocol,
  recordCodecs,
} from '@enbox/api';

const NotesProtocol = defineProtocol({
  protocol  : 'https://example.com/notes',
  published : false,
  types     : {
    note: {
      schema      : 'https://example.com/schemas/note',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    note: {
      $tags: { category: { type: 'string' } },
    },
  },
} as const, {
  note: recordCodecs.json<{ title: string; body: string }>(),
});

const application = defineApplicationManifest({ protocols: [NotesProtocol] });
const store = createConnectionStore({ application, password: userPassword });
let snapshot = await store.initialize();
if (snapshot.phase === 'disconnected') {
  snapshot = await store.connectVault({ createIdentity: true });
}
if (snapshot.phase !== 'connected') {
  throw snapshot.error ?? new Error('Connection was not established.');
}

const notes = snapshot.enbox.using(NotesProtocol);

const record = await notes.records.create('note', {
  data : { title: 'Hello', body: 'World' },
  tags : { category: 'draft' },
});

const data = await record.value(); // { title: string; body: string }

await store.disconnect();
await store.dispose();
```

`defineProtocol()` pairs each protocol record type with one runtime codec.
`enbox.using(protocol)` returns a `TypedEnbox` scoped to that protocol, so
record methods infer paths and application values while using the same codec
for writes and reads.

For encrypted file records, use a private envelope:

```ts
const attachmentCodec = recordCodecs.fileEnvelope({
  formatId: 'myapp1', // exactly six ASCII bytes
});
```

The descriptor stays `application/octet-stream`; the safe filename and
canonicalized media type remain inside the payload. Declare the protocol type
with `encryptionRequired: true`. Use
`attachmentCodec.maxEncodedBytesFor(contentBytes)` when its `$size.max` rule
should reserve room for that content plus maximum envelope metadata. Pass
`maxContentBytes` to the codec only when the dapp also wants to reject larger
files locally; otherwise the codec adds no application size policy.

Register all of an application's typed protocols and delegated permission
policies once with `defineApplicationManifest()`:

```ts
import {
  createConnectionStore,
  defineApplicationManifest,
  Enbox,
  getApplicationProtocolRequests,
} from '@enbox/api';

const application = defineApplicationManifest({
  protocols: [
    NotesProtocol, // default: read, write, delete
    { protocol: PhotosProtocol, permissions: ['read'] },
  ],
} as const);

const store = createConnectionStore({
  application,
  connectHandler,
  monitor: { autoRefresh: {} },
});
let snapshot = await store.initialize(); // restored sessions are readied before publication
if (snapshot.phase !== 'connected') {
  snapshot = await store.connect();
}
if (snapshot.phase !== 'connected') {
  throw snapshot.error ?? new Error('Connection was not established.');
}
```

The connection store treats the manifest as the canonical protocol source. It
projects delegated permission requests into `connect()`, `refresh()`, and an
opted-in monitor `autoRefresh`; callers cannot supply a competing protocol
list. Every store requires at least one protocol. It then gates
each session the store establishes or restores on local protocol readiness
before publishing `phase: 'connected'`: owners install the protocols locally,
while delegates validate and import the wallet-approved configurations. This
includes app startup with a saved session.

Hosted publication is not required for a local owner connection. Set
`requireHostedReadiness: true` only when the app must publish and verify every
owner configuration at the hosted DWN before becoming connected. The default
keeps local-only, offline, and endpoint-less owner identities usable; an app
can also call `enbox.protocols.ensureReady({ application })` later when hosted
receiving becomes necessary.

Transient readiness failures remain retryable while keeping the unusable
session out of the public snapshot. A missing or incompatible
wallet protocol configuration instead ends the unusable delegate session and
sets `walletReapprovalRequired`, so the next `connect()` requests fresh
approval. A delegated sync registration that is missing, belongs to another
delegate, or omits any manifest protocol with read permission also fails closed:
the store closes and hides the public facade, stops its monitor, and preserves
the underlying auth session so the next `store.connect()` repairs approval
through refresh. On a connection store, `connect()` is delegated and a
per-call `password` unlocks the delegate vault; use `connectVault()` for an
owner.

Advanced integrations that own auth directly must project and ready the
manifest explicitly, and separately close both the session facade and manager:

```ts
import { AuthManager } from '@enbox/auth';

const auth = await AuthManager.create({ connectHandler });
const protocols = getApplicationProtocolRequests(application);
const session = await auth.connect({ protocols });
const enbox = Enbox.fromSession(session);

await enbox.protocols.ensureReady({ application });

enbox.close();
await auth.disconnect();
await auth.shutdown();
```

The manifest retains each `TypedProtocol` for application-side use, while the
auth projection contains only raw definitions and permission names — runtime
codecs are never transmitted. The manifest itself is not a raw connect-options
object. Owner/vault connections remain explicit `store.connectVault()` calls,
or `AuthManager.connectVault()` in a caller-managed advanced lifecycle.

`ensureReady()` publishes by default only for owner sessions; pass
`publish: false` for local installation without a hosted-DWN requirement. A
delegated session validates and imports the wallet-owned configurations without
authoring or publishing replacements regardless of that option. `targetDid` is
publish-only: the local install remains on the connected identity, and the
target must be controlled by the same agent so it can sign the configuration.
The lower-level
`enbox.using(protocol).configure()` never publishes to a hosted DWN.

Typed protocol composition through `$ref` is not inferred from incomplete
local metadata. `defineProtocol()` rejects it for now; use the raw `enbox.dwn`
API when an application needs explicit protocol composition.

## Integration Testing

Node integration tests can use `@enbox/api/testing` for an isolated owner
session backed by a real in-process DWN. It installs the application's typed
protocols locally without requiring hosted services:

```ts
import { createEnboxTestContext } from '@enbox/api/testing';

const context = await createEnboxTestContext({ application });
try {
  const notes = context.enbox.using(NotesProtocol);
  await notes.records.create('note', {
    data: { title: 'Test', body: 'Stored by a real DWN' },
  });
} finally {
  await context.close();
}
```

Each context owns a unique identity and storage directory, so contexts can run
concurrently. Always call `close()` to end its session and release resources.

## Records

```ts
// Create
const record = await notes.records.create('note', {
  data: { title: 'Launch', body: 'Ship it' },
});

const selection = { pagination: { limit: 20 } };

// Query
const page = await notes.records.query('note', selection);
const { records } = page;
const nextPage = await page.next(); // undefined after the final page
for await (const record of page) console.log(record.id);

// Observe one bounded materialization
const view = await notes.records.observe('note', selection);
const render = (state) => {
  console.log(state.status, state.records, state.hasMore);
};
await view.ready();
const unsubscribe = view.subscribe(render);
render(view.getSnapshot()); // close the one-shot-to-live handoff
await view.loadMore(); // retain one more 20-record step when hasMore is true

// Consume later writes/deletes from one stream
const changes = await notes.records.subscribe('note', async (event) => {
  if (event.type === 'write') {
    console.log(await event.record.value());
  }
});

// Count the same selection before pagination
const count = await notes.records.count('note', selection);

// Read
const found = await notes.records.read('note', record.id);

if (found === undefined) {
  throw new Error('Note not found');
}

// Update
await found.update({
  data: { title: 'Launch', body: 'Shipped' },
});

// Derive a partial update from the latest value, with one conflict retry
await notes.records.patch('note', found.id, (current) =>
  current.body === 'Shipped' ? undefined : { body: 'Shipped' }
);

// Delete by intent; an existing tombstone also resolves successfully
await notes.records.delete('note', { recordId: found.id });

unsubscribe();
await view.close();
await changes.close();
```

Typed record operations return protocol-bound `TypedRecord<T>` handles.
`contextId`, `protocol`, and `protocolPath` are therefore required strings on
every create, read, query, observe, subscription, and materialization result.
`update()` mutates and returns the same refined handle. Successful delete
operations resolve without a value.
Context-bound deletion requires authority-backed proof: an authorized existing
tombstone is idempotent, while a plain scoped 404 remains a 404 because the ID
may name a record outside the context.

Structured write failures preserve the original DWN status and expose exact
subclasses:

```ts
import { RecordParentNotFoundError, RecordSquashBackstopError } from '@enbox/api';

function reportWriteError(error: unknown) {
  if (error instanceof RecordSquashBackstopError) {
    console.error(error.squashFloorTimestamp);
  } else if (error instanceof RecordParentNotFoundError) {
    console.error('The parent record no longer exists.');
  }
}
```

Other non-success replies throw `DwnResponseError` with the same `status`.

### Delta history compaction

The typed records API exposes the timestamp and `squash` primitives needed by
delta-based applications. The canonical [API guide](https://enbox-docs.pages.dev/docs/packages/api)
documents the bounded rebase recipe and machine-readable squash backstop.
`record.squash` reports the immutable initial-write fact and remains stable
after updates and deletion; anonymous `ReadOnlyRecord` handles expose it too.

Returned records are canonical `Record<T>` instances. `value()` decodes the
typed application value through the protocol codec, while `data.json()`,
`data.text()`, `data.bytes()`, `data.blob()`, and `data.stream()` expose the
raw representation without wrapping a second record object. `update({ data })`
replaces the full payload; use `records.patch(path, recordId, patch)` for
a shallow partial object update with one bounded conflict retry.

`observe()` watches the connected tenant by default; pass `from` and, when
required, `protocolRole` to watch a foreign tenant. Subscription events are
wake hints: every immutable view state is rebuilt from the same canonical query.
Its required pagination limit is the initial retained-record bound and the
`loadMore()` step. Expansion reruns the live query from the beginning and
retains only the latest bounded prefix.
Pass `signal` to a typed record observation or subscription, or to a context,
invitation, or member observation, when its lifetime belongs to one caller.
Aborting it rejects an opening call or closes only that resource; `close()`
safely joins the same cleanup.
When the owning session ends, a view publishes one terminal `error` state
and closes. After automatic grant refresh, `ConnectionStore` publishes a
replacement `enbox`; direct `Enbox.fromSession()` consumers close the old
facade and recreate resources from the replacement `AuthManager.session`
announced by `session-start`.

Before the first query, every view is `loading`. After the first local
materialization it is `ready`, including for an empty or offline result.
`current` separately reports whether the relevant replication links are caught
up. Successful local queries continue to update a non-current state, so offline
writes remain visible. Query, authorization, and terminal sync failures publish
`error` while retaining the latest successful records.
`hasMore` is always present: it is `false` before the first query and whenever
the latest bounded result has no next page.

`ready({ signal })` resolves after the first local query makes its result
usable. It rejects the first error state, caller abort, or closure; callers may
wait again after a recoverable error, and later states continue through
`subscribe()`. Do not treat an empty result as authoritative remote absence
until `current` is true.

The state object and records array are immutable. Each `Record<T>` handle
represents the queried version until the caller explicitly uses that handle's
normal `update()` or `delete()` method; record data remains lazily read.

`subscribe()` delivers later writes and deletes for one exact path or one
non-empty path set as codec-bound, path-discriminated events. A path set uses
one underlying stream, and inline frame data is reused when present. Use
`observe()` when the application needs bounded current collection truth.
Change delivery is at least once, so consumers should tolerate duplicates.

## Contexts

Typed contexts provide the same confined records API to owners and members,
plus declarative membership, invitations, live catalogs, exact-context
replication, and explicit `refresh()`, `forget()`, and `leave()` lifecycle
operations. Tenant routing, role records, grants, delivery keys, and feed
cursors remain internal.

Each context exposes its `rootRecordId` and a collision-safe `key` equivalent
to `protocolContextKey(context.ownerDid, context.id)`.

The complete owner/member workflow and current limitations live in the
canonical [API guide](https://enbox-docs.pages.dev/docs/packages/api).

## Anonymous Reads

`Enbox.anonymous()` creates a read-only API for published records and protocol
metadata. It has no local identity, so every request needs a `from` DID.

```ts
const { dwn } = Enbox.anonymous();

const { records } = await dwn.records.query({
  from   : 'did:dht:alice...',
  filter : {
    protocol     : 'https://example.com/notes',
    protocolPath : 'note',
  },
});
```

## Advanced DWN Access

Most apps should use `enbox.using(protocol)`. If you need raw DWN methods, use
the advanced export. Low-level methods keep their exact DWN response envelopes,
including `status`:

```ts
import { DwnApi } from '@enbox/api/advanced';

const dwn = new DwnApi({
  agent        : session.agent,
  connectedDid : session.did,
  delegateDid  : session.delegateDid,
});
```

Permission request, grant, and revocation administration remains available at
`enbox.agent.permissions`; `DwnApi` does not duplicate that agent-level surface.
High-level typed mutations persist automatically. Use the raw agent request
methods only when an advanced workflow must preserve an exact signed message.

## Browser Builds

Browser apps typically use `@enbox/browser`, which re-exports the main app APIs
and adds browser-specific connect helpers:

```ts
import { Enbox, BrowserConnectHandler, defineProtocol, recordCodecs } from '@enbox/browser';
```

The root `@enbox/api` entry also declares a browser condition that resolves to
the prebuilt `dist/browser.mjs` bundle in browser-aware bundlers. Apps and
service-worker builds should not need Enbox-specific Node global shims for
`process`, `process.env`, `process.browser`, `process.emitWarning`, `global`,
or the Node `events` builtin.

The agent's browser storage remains Level-backed through `level` resolving to
`browser-level` over IndexedDB. Do not replace it with an in-memory store for
multi-tab or service-worker use; IndexedDB is the storage layer that safely
coordinates writes across browser contexts.

## Exports

| Export | Description |
|---|---|
| `createConnectionStore()` | Owns restore, connect, refresh, disconnect, and facade cleanup for applications. |
| `Enbox` | Session-bound app facade: `fromSession()`, `anonymous()`, `using()`, `close()`. |
| `defineProtocol()` | Creates typed protocol definitions. |
| `RecordQuery` | Protocol-derived filter, date ordering, and pagination shared by query and count. |
| `RecordPage<Item>` | One page with cursor-free `next()` and lazy async iteration. |
| `ExpandableRecordView<Item>` | Closeable bounded query view with fixed-step `loadMore()`. |
| `ContextView` | Closeable live catalog of owned and accepted member contexts. |
| `MaterializedMemberContext` | Accepted member context with its independently observed root state. |
| `ProtocolContext` | Discriminated owner/member entry returned by a context catalog. |
| `OwnedContext` / `MemberContext` | Context-scoped records and owner/member lifecycle handles. |
| `ContextMember` | One owner-managed member and its audience-key delivery state. |
| `MaterializedRecord<T, Handle>` | A decoded value paired with its retained record handle. |
| `TypedRecord<T>` | A canonical record with required protocol coordinates. |
| `TypedEnbox` | Protocol-scoped record API returned by `enbox.using()`. |
| `Record<T>` | Canonical mutable record handle with protocol-derived payload typing. |
| `DwnResponseError` | Typed-operation error carrying the original non-success DWN status. |
| `RecordSquashBackstopError` | Exact squash-floor rejection with the reported floor timestamp. |
| `RecordParentNotFoundError` | Exact same-protocol missing-parent write rejection. |
| `ReadOnlyRecord` | Anonymous-read record handle. |
| `DidApi` | DID resolution helpers. |
| `DwnReaderApi` | Anonymous read-only DWN API. |

## Related Packages

- [`@enbox/auth`](../auth): Auth lifecycle and session management.
- [`@enbox/agent`](../agent): Agent runtime, local DWN, key management, sync.
- [`@enbox/protocols`](../protocols): Ready-to-use protocol definitions.
- [`@enbox/protocol-codegen`](../protocol-codegen): Type generation from protocol JSON.

## License

Apache-2.0
