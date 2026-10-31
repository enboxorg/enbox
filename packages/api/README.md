# @enbox/api

> **Research Preview** -- Enbox is under active development. APIs may change without notice.

High-level SDK for app developers. Start here unless you specifically need the
lower-level agent, auth, or DWN packages.

## Install

```bash
bun add @enbox/api
```

## Application stores

Declare named resources and domain commands once, then share their instances
between UI components and headless controllers. These names have distinct roles:

| Name | Role |
|---|---|
| `NotesStore` | An inert feature definition returned by `defineStore`. Its factory must return synchronously. |
| `app.manifest` | The existing `ApplicationManifest`: typed protocols and delegated permission policy used by the connection. |
| `app` | The running owner returned by `createApplication`; it owns feature instances and the supplied connection. |
| `feature` | One resolved store instance. A feature is the application's domain module, such as notes or tasks. |

The headless example below expects a typed `NotesProtocol` whose `note` codec
accepts `{ title: string }`. Configure the native connection for your environment;
the Connect section below describes its vault, endpoint, and wallet options.
For this Node example, set `ENBOX_VAULT_PASSWORD` to your vault password.

```ts
import {
  createApplication,
  createConnectionStore,
  defineStore,
} from '@enbox/api';
import { NotesProtocol } from './protocol.js';

export const NotesStore = defineStore({
  protocols: { notes: NotesProtocol },
  create({ protocols }) {
    const notes = protocols.notes.collection('note');
    const addNote = (title: string) => notes.create.run({ title: title.trim() });
    return { notes, addNote };
  },
});

const password = process.env.ENBOX_VAULT_PASSWORD;
if (password === undefined) throw new Error('Set ENBOX_VAULT_PASSWORD.');
const app = createApplication({
  stores: { notes: NotesStore },
  connection: manifest => createConnectionStore({
    application: manifest,
    password,
  }),
});
try {
  let connectionState = await app.initialize();
  if (connectionState.phase === 'disconnected') {
    connectionState = await app.connection.connectVault({ createIdentity: true });
    // Wallet apps use connection.connect() with their platform connect handler.
  }
  if (connectionState.phase !== 'connected') {
    throw connectionState.error ?? new Error('Connection was not established.');
  }

  // Resolve after connection: a later session/facade replacement creates a new feature instance.
  const feature = app.store(NotesStore);
  const stop = feature.notes.subscribe(state => console.log(state.records.map(row => row.value)));
  try {
    const initial = await feature.notes.ready();
    console.log(initial.records.map(row => row.value));
    await feature.addNote('Hello');
  } finally {
    stop();
  }
} finally {
  await app.dispose();
}
```

Definitions and collection handles perform no I/O. A feature factory declares
handles and commands synchronously. Capture `protocols.notes.native` as a
function if needed, and invoke it inside a command or an observation opener;
calling `native()` requires a usable session. It returns the existing full
`TypedEnbox`, including `records` and `contexts`, rather than a second SDK.
Resolve it for each operation; a captured native client follows the SDK's own
lifetime and does not acquire store progress tracking or canonical-view refresh.

### Collection and native capabilities

| Need | API |
|---|---|
| Locally owned records with codec-derived data | `protocols.notes.collection('note')` with `create.run(data)`, `patch.run({ id, patch })`, and `delete.run(id)` |
| Nested records | A nested path produces a family; `pages.within(parentContextId)` resolves an exact direct-parent collection. |
| A `$recordLimit.max: 1` slot | `protocols.notes.native().records.set(...)`; singleton paths are excluded from `collection()`. |
| Tags, publication, timestamps, recipients, full update, or prune | Existing native record operations through `protocols.notes.native().records`, called inside a domain command. |
| Invitations, memberships, accepted shares, or member writes | Existing `protocols.notes.native().contexts` and context-bound `records`; observe them with the same `observe()` factory shown below. |

Collection commands accept data-only inputs; read filters never become write
fields. Deletion first reads the ID at the declared protocol path, then checks
the direct parent for nested paths. An absent path match is an idempotent no-op;
read or authorization failures propagate. Collection deletion therefore requires
read authorization as well as delete authorization.

Subscriptions and explicit `retain()` leases keep a native view live. **Collection
view controls hold temporary leases**: `ready`, `retry`, `refresh`, and `loadMore`
release their own interest when they settle. Without another lease or subscriber,
`getSnapshot()` then returns idle with no rows. Use the value returned by
`ready()`/`refresh()` for one-shot work, or keep a subscription/lease for live
state and retained pagination. `ready({ signal })` supports independent waiter
cancellation; the other controls currently end through their operation or owner
scope, rather than a per-call cancellation option.

Handles are memoized by canonical selection and parent **for the session's
lifetime**. Releasing interest closes the native observation and releases its
rows; handle descriptors and command instances remain interned until session
replacement or disposal. This slice does not implement bounded handle eviction.
Each distinct filter creates a distinct cached handle. Active write refreshers
are registered only while a native observation exists, so a write visits active
selections rather than the session's query history.

### Declare shared observations

The feature's `observe` factory owns native observations of records, accepted
shares, or members. The returned handle always has the same subscription,
readiness, retry, and cleanup rules. The native view determines its payload
and whether `refresh()` or `loadMore()` is available.

```ts
// Inside defineStore({ create({ protocols, observe }) { ... } }):
const native = protocols.notes.native;
const acceptedShares = observe(signal => native().contexts.observe({ access: 'member', signal }));
const pages = protocols.notes.collection('notebook/page');
const activePages = observe({
  source: (parentContextId: string) => pages.within(parentContextId),
});
return { acceptedShares, pages, activePages };
```

`observe(open)` declares a fixed native observation. It opens when subscribed,
retained, or awaited. `observe({ open })` declares an observation whose input is
chosen later with `select(input)`. `observe({ source })` selects an existing
observable store instead. It releases only its own subscription when the input
changes; an `open` callback transfers ownership of the native view it returns.
Protocol collections use this same owner internally. Native `records.observe()`
and context APIs remain available for custom code.

```ts
await feature.activePages.select(notebook.contextId);
const state = feature.activePages.getSnapshot();
if (state.status === 'ready') {
  console.log(state.selection, state.records.map(row => row.value));
}
await feature.activePages.select(null);
```

A changing-input observation starts idle with `selection: null`. `select(input)`
retains the chosen source until replacement, null, `close()`, or owner abort. It
waits for usable data, including `loadAll` expansion. Repeating the input preserves
its observation. Calling `ready()` or another read control before choosing an
input rejects with a `TypeError`.

A superseded wait rejects with `StoreRetiredError`; unrelated subscribers keep
their observations. Native payload fields can be absent before attachment, so
narrow on `status` before using them. `selection` is published with its data.

Use `observe(config, { signal })` for a shorter controller lifetime. Mutations
stay on fixed collection handles or explicit domain commands: changing a read
selection never retargets an already captured write handle. `getSnapshot()`
opens no observation. React reads the returned store with `useStore()`.

### State and completion

`StoreCollectionState` preserves native materialized rows (`{ record, value }`),
bounded pagination, and local readiness separately from replication `current`.
`pagination.limit` is the initial row window and `loadMore()` step, not a total
result cap. `loadAll: true` explicitly expands every matching local page.

| State | Meaning |
|---|---|
| `idle` | No active observation or usable session; rows are empty. |
| `loading` | The observation is opening or its first local query is pending. |
| `ready` | Local rows, including an empty result, are usable. `current` reports replication freshness. |
| `error` | Opening, query, pagination, or refresh failed. Previously usable rows may remain visible. |

Collection `create`/`patch`/`delete` completion includes local write acceptance
and refresh of currently active selections for the **same feature/protocol
binding, path, and direct parent**. It does not imply remote delivery or that a
new record falls inside every retained window. A slow active query can delay
completion; a `loadAll` selection also completes its expansion. This is an
intentional local-visibility barrier. Native wake events update other feature
bindings independently. A failed reread remains query state and preserves the
accepted write's result. Custom native commands retain their native completion
semantics and do not automatically add that collection refresh barrier.

`isLoadingMore` reports shared page expansion; `retry()` reopens and awaits usable
local data, while `refresh()` recomputes the existing native view.

`StoreCommandState.pendingInputs` lists unresolved command inputs. The state
also contains the shared pending count and the latest invocation's display error. Initial scope rejection happens before dispatch and leaves that
state unchanged; callers receive the rejected promise. Command inputs are one
value (use an object for several fields), optionally defaulted or omitted.
`run()` preserves the operation's result or rejection; it adds no automatic
retry or rollback. An optional `command(operation, { signal })` bounds a command to a shorter
caller lifetime without changing issued write outcomes. `isCurrent()` checks authorization, while UI selection,
drafts, and component completion effects remain caller-owned.

| Surface | Failure/lifetime policy |
|---|---|
| `app.store()`, `app.subscribe()`, `native()`, `command.reset()` | Synchronous methods throw for invalid ownership/authority; an unregistered definition is a `TypeError`. |
| `initialize()`, command `run()`, and async view controls | Return promises; unavailable/retired scopes reject with `StoreNotConnectedError`/`StoreRetiredError`, and native operation failures retain their original cause. |
| Command/observation subscription after retirement | Returns an inert unsubscribe; retaining a closed observed store is also inert. Reading its cached state opens nothing. |
| `app.dispose()` | Revokes store scopes, waits for registered cleanup and native connection disposal, and rejects with `AggregateError` for recorded cleanup/teardown failures. |

### Permissions and lifetime

`createApplication` derives one manifest from transitive store dependencies.
Protocols use the SDK's existing delegated default of `read`, `write`, and
`delete`; the application can override a protocol's policy explicitly:

```ts
const app = createApplication({
  stores: { notes: NotesStore },
  protocols: [{ protocol: NotesProtocol, permissions: ['read'] }],
  connection: manifest => createConnectionStore({ application: manifest }),
});
```

This requests delegated grants; owner authority is still governed by the SDK
and DWN. Per-store permission declarations are not a separate policy layer.
At least one protocol must be registered transitively or explicitly before
constructing a native `ConnectionStore`. Reuse the same `TypedProtocol` object
for one URI across store dependencies and overrides: conflicts include distinct
codec-bearing protocol objects, even if their wire definitions are equal.

Feature instances belong to exact session/facade references. Before connection,
`app.store(NotesStore)` can supply inert handles, but those instances retire when
connection publishes a usable session. Resolve again after each replacement;
React's `useFeature` does this automatically. `app.subscribe()` invalidates
feature lookups on all native connection publications and immediate scope
retirement. A sync-only publication does not replace the feature: handlers
compare `app.store(...)` identity before recreating their own setup. React's
`useFeature` already performs that comparison and avoids those rerenders.

Register custom release callbacks with `onClose` before starting owned work,
and return the completion of its entire asynchronous release. Registered
callbacks run after invalidation in reverse registration order. Late releases
registered during disposal are awaited by the application, but do not extend
the feature's dependency teardown sequence; registering after disposal has
settled cannot extend an already settled promise.
`dispose()` is terminal resource/connection teardown, not a request to
flush application buffers, discard documents, or sign out. Unsaved document
handoff and guarded drains remain with the host's existing lifecycle in this
application layer. Use `app.connection.disconnect()` for native sign-out.

`getSnapshot()` reads a store's current cached state, without creating a copy.
`State` names describe published values; `getSnapshot()` and `subscribe()` are
the observable read contract shared by UI and headless consumers.

## Connect

`createConnectionStore` is the native connection primitive used by
`createApplication`. Custom hosts can construct it directly from a manifest:

```ts
import { createConnectionStore } from '@enbox/api';
import { manifest } from './manifest.js';

const store = createConnectionStore({
  application: manifest,
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

### Delegated grant lifetime

Wallet connect approvals stamp delegate grants with a **one-hour default TTL**
(`CONNECT_SESSION_DEFAULT_TTL_SECONDS` in `@enbox/agent`; wallets cap grants at
90 days and apps cannot request longer). Configure
`monitor: { autoRefresh: {} }` on `createConnectionStore()` so the store renews
an expiring session from the same application manifest. Without automatic
refresh, operations stop succeeding when the grants expire. Two fail-closed
states require wallet approval:

- `snapshot.walletReapprovalRequired: true` — the wallet's protocol config
  drifted or the session was revoked; the next `connect()` requests fresh
  approval.
- `ManifestSyncRegistrationCoverageError` — the delegate's sync registration no
  longer covers every read protocol in the manifest. The store publishes
  `phase: 'disconnected'` with `walletReapprovalRequired: true`, keeps the
  underlying auth session, and the next `store.connect()` repairs approval
  through refresh.

Ship user-facing copy for both states. Treat SDK message text as debug material,
not user-facing or machine-readable state.

## Observable Connection and Sync State

`createConnectionStore()` publishes connection and selected-identity sync state
through one framework-neutral external-store contract:

```ts
import { createConnectionStore } from '@enbox/api';
import { manifest } from './manifest.js';

const store = createConnectionStore({ application: manifest, password: userPassword });
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

### Live transport: WebSocket first

Enbox's live paths — the agent sync engine, `records.subscribe()` feeds, and
remote-view currency — use WebSocket transports (`@enbox/dwn-clients`), with
HTTP for request/response and larger transfers. The periodic durable-feed
settle pass repairs missed notifications; it is not an application polling
API. Use `observe()` and `subscribe()` to keep application state current rather
than periodically re-querying.

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

const manifest = defineApplicationManifest({ protocols: [NotesProtocol] });
const store = createConnectionStore({ application: manifest, password: userPassword });
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

const manifest = defineApplicationManifest({
  protocols: [
    NotesProtocol, // default: read, write, delete
    { protocol: PhotosProtocol, permissions: ['read'] },
  ],
} as const);

const store = createConnectionStore({
  application: manifest,
  connectHandler,
  monitor: { autoRefresh: {} },
});
await store.initialize(); // restored sessions are readied before publication
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
can also call `enbox.protocols.ensureReady({ application: manifest })` later when hosted
receiving becomes necessary.

Transient readiness failures remain retryable while keeping the unusable
session out of the public snapshot. A missing or incompatible
wallet protocol configuration instead ends the unusable delegate session and
sets `walletReapprovalRequired`, so the next `connect()` requests fresh
approval. A delegated sync registration that is missing, belongs to another
delegate, or omits any manifest protocol with read permission also fails closed:
the store closes and hides the public facade, stops its monitor, and preserves
the underlying auth session so the next `store.connect()` repairs approval
through refresh. When no session was restored, call `connect()` from the
platform's connection action. In browsers, invoke it directly from a user
gesture so the wallet popup is not blocked. A per-call `password` unlocks the
delegate vault; use `connectVault()` for an owner.

Advanced integrations that own auth directly must project and ready the
manifest explicitly, and separately close both the session facade and manager:

```ts
import { AuthManager } from '@enbox/auth';

const auth = await AuthManager.create({ connectHandler });
const protocols = getApplicationProtocolRequests(manifest);
const session = await auth.connect({ protocols });
const enbox = Enbox.fromSession(session);

await enbox.protocols.ensureReady({ application: manifest });

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

const context = await createEnboxTestContext({ application: manifest });
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

Tests that need the production delegated and hosted-routing paths can use the
hosted helper instead:

```ts
import { createHostedDelegatedEnboxTestContext } from '@enbox/api/testing';

const context = await createHostedDelegatedEnboxTestContext({
  application: manifest,
  dwnEndpoints: [process.env.TEST_DWN_URL!],
});
try {
  const notes = context.enbox.using(NotesProtocol);
  await notes.records.create('note', {
    data : { title: 'Test', body: 'Stored on the hosted DWN' },
    from : context.ownerDid,
  });
} finally {
  await context.close();
}
```

This helper requires the normal `did:dht` test gateway and at least one
caller-managed DWN endpoint that accepts the generated owner tenant. It does
not start or emulate either service. `close()` stops the local agents and
removes their temporary files; protocol configurations, grants, revocations,
and records already sent to the hosted DWN remain there. Use a disposable or
resettable test endpoint when test isolation requires remote cleanup.

Note the coverage boundary: `createEnboxTestContext` is **owner-only** and
in-process — delegate, role-grant, and cross-tenant flows are invisible to it.
Application-level fakes of this API must model handles as non-spreadable
getter objects (see [Records](#records)) and reject empty `within` on nested
paths, so a unit suite fails exactly where production would; and every
multi-record addressing flow deserves at least one real-context smoke test
before shipping, because a lenient fake proves nothing.

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

Queries and observed views accept `materialize: true` for decoded values, or
`materialize: { children: [...] }` to include selected direct singleton
children. Inline child paths infer their exact result shape without a const
assertion. Materialization requires an explicit pagination limit. Integrations
can use `RecordMaterialization`, `RecordObserveRequest`, and
`RecordRepresentation` to share these native selection and result contracts.

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

### Record handles are live objects

Every record that crosses the API boundary (`create()` results, query and
observe rows, read results) is a `Record`/`TypedRecord` instance. Its public
address fields (`id`, `contextId`, `protocolPath`, and others) are prototype
accessors rather than enumerable own properties:

```ts
const row = ...;                     // { record: TypedRecord, value: T }
const snapshot = { ...row.record };  // not a public record snapshot
```

Pass the handle itself through, call `record.toJSON()` for its public metadata,
or copy the exact public fields an application model needs. Object spread can
omit address fields and expose implementation fields. An observed view always
requires `pagination.limit`; a materialized query requires the same bound. The
decoded application value rides beside the handle, not inside it.

> [!WARNING]
> Unbound typed queries and views reject a missing or malformed `within` for a
> nested protocol path. An unbound typed read rejects a malformed `within`, but an
> omitted value currently searches that path across the tenant and can return
> a sibling from another context. Pass the exact parent context on every nested
> read. A context-bound records handle supplies its root scope automatically;
> deeper entity subtrees still need their exact context.
>
> Nested records report composite `contextId`s (`<parentCtx>/<ownId>`; root
> records carry their bare own id), and there is no `parentContextId` metadata
> field — lineage is the composite prefix. `parentContextId` is accepted on
> create. Round-trip the node's `contextId` verbatim; never reconstruct it.

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
`current` separately reports whether freshness is established for the view's
source. Local replicated views use the relevant replication links. Direct
remote views become non-current when their subscription transport disconnects
and become current again only after reconnect rematerializes the query.
Successful local queries continue to update a non-current state, so offline
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

Typed contexts expose confined records, membership, invitations, and member lifecycle
operations such as `refresh()`, `forget()`, and `leave()`. The SDK manages tenant
routing, grants, delivery keys, replication, and feed cursors.

Following or accepting an invitation saves an encrypted choice in the application's
protocol. Each device independently verifies current membership and keys; saved
choices are not membership proof. Owner unavailability preserves the choice, and
apps need no separate bookmark protocol or reconciliation controller.

`contexts.observe()` restores choices in the background. `contexts.list()` waits
for one restoration attempt and may incur owner network timeouts. Recipient sync
and owner recovery retry without another timer; unexpected restoration failures
are logged while known contexts remain available.

`contexts.forget({ ownerDid, id })` works without a live acceptance and leaves the
owner's role intact. A member handle's `forget()` first checks that its acceptance
is still current, so an already-retired handle cannot override a later follow.

`leave()` withdraws the role and then saves the forget. If saving fails, the call
rejects and coordinate-based `contexts.forget()` can finish it. These writes are
not atomic; a retired `leave()` rejects with `ContextRetiredError`.

Changing a saved choice requires own-protocol write access; read-only grants are
not widened. All apps with that access can change the identity's shared choices.
The immutable journal retains and reads its history in pages without automatic
compaction. Future compaction must retain effective forgets so older offline follows cannot return.

Each context exposes its `rootRecordId` and a collision-safe `key` equivalent
to `protocolContextKey(context.ownerDid, context.id)`.

The complete owner/member workflow and current limitations live in
[Shared contexts](https://enbox-docs.pages.dev/docs/packages/api#shared-contexts).

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

## Browser applications

Use `@enbox/browser`, which re-exports this API with browser auth, wallet
connect, and DWeb helpers. The canonical
[browser dapp guide](https://enbox-docs.pages.dev/docs/guides/browser-dapp)
covers its service worker, persistent storage, and build setup.

## Exports

| Export | Description |
|---|---|
| `defineStore()` | Declares synchronous feature factories, typed protocols, dependencies, and commands. |
| `createApplication()` | Derives the manifest and owns session-scoped features and the constructed connection. |
| `ApplicationRuntime` | Running owner of the derived manifest, connection, and feature instances. |
| `StoreDefinition` / `StoreContext` / `StoreInstance` | Feature authoring and inferred instance types. |
| `DefineStoreOptions` / `CreateApplicationOptions` | Feature definitions and application registration, manifest policy, and connection construction. |
| `StoreProtocols` / `StoreDefinitions` | Named protocol and feature dependencies. |
| `ProtocolStore` | Inert collection authoring plus explicit `native()` access to the full typed SDK. |
| `StoreCollection` / `StoreCollectionFamily` | Data-only owned CRUD and keyed direct-parent collections. |
| `StoreCollectionOptions` | Protocol-derived read filters, pagination, and `loadAll` policy. |
| `StoreCollectionState` | Collection rows, pagination progress, and idle/native read state. |
| `ObservationFactory` / `ObservedStore` / `ObservedStoreState` | Common ownership and state for fixed or changing-input observations and borrowed collections. |
| `StoreCommand` / `StoreCommandState` | One-input domain operations and shared pending/error state. |
| `StoreNotConnectedError` / `StoreRetiredError` | Unavailable or retired store scope failures. |
| `createConnectionStore()` | Owns restore, connect, refresh, disconnect, and facade cleanup for applications. |
| `Enbox` | Session-bound app facade: `fromSession()`, `anonymous()`, `using()`, `close()`. |
| `defineProtocol()` | Creates typed protocol definitions. |
| `RecordQuery` | Protocol-derived filter, date ordering, and pagination shared by query and count. |
| `RecordPage<Item>` | One page with cursor-free `next()` and lazy async iteration. |
| `RecordView<Item>` / `ExpandableRecordView<Item>` | Closeable canonical local queries with `ready()`, `refresh()`, and optional fixed-step `loadMore()`. |
| `ContextView` | Closeable live catalog of owned and accepted member contexts. |
| `MaterializedMemberContext` | Accepted member context with its independently observed root state. |
| `ProtocolContext` | Discriminated owner/member entry returned by a context catalog. |
| `OwnedContext` / `MemberContext` | Context-scoped records and owner/member lifecycle handles. |
| `ContextMember` | One owner-managed member and its audience-key delivery state. |
| `MaterializedRecord<T, Handle>` | A decoded value paired with its retained record handle. |
| `RecordMaterialization` | Protocol-derived value or direct singleton child selection. |
| `RecordObserveRequest` | Bounded query, materialization, and cancellation options for an observed view. |
| `RecordRepresentation` | Protocol-bound handle or materialized row selected by a request. |
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
