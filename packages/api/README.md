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
import { Enbox } from '@enbox/api';

const { auth, enbox, session } = await Enbox.connect({
  password      : userPassword,
  createIdentity: true,
  dwnEndpoints  : ['https://enbox-dwn.fly.dev'],
});
```

`Enbox.connect()` creates an `AuthManager`, connects or restores a session, and
returns:

| Value | Description |
|---|---|
| `auth` | The `AuthManager` that owns the session lifecycle. |
| `enbox` | The high-level API instance. |
| `session` | Active DID, delegate DID when present, agent, and first-run recovery phrase. |

Common options:

| Option | Description |
|---|---|
| `password` | Local vault password. The default is insecure; production apps should pass one. |
| `createIdentity` | Create a default identity when no identity exists. |
| `recoveryPhrase` | Explicit BIP-39 vault recovery. |
| `dwnEndpoints` | Remote DWN endpoints used for registration and sync. |
| `sync` | Omit for live sync, pass an interval like `'30s'`, or pass `'off'`. |
| `protocols` | Protocol scopes for handler-based connect flows. |
| `connectHandler` | Browser/wallet connect handler. |
| `registration` | DWN endpoint registration callbacks and token persistence options. |

If you already own an auth session, use `Enbox.fromSession(session)`. If you
own a raw agent and DID, use `new Enbox({ agent, connectedDid })`.

## Observable Connection and Sync State

`createConnectionStore()` publishes connection and selected-identity sync state
through one framework-neutral external-store contract:

```ts
import { createConnectionStore } from '@enbox/api';

const store = createConnectionStore({ password: userPassword });
const unsubscribe = store.subscribe((snapshot) => {
  console.log(snapshot.phase, snapshot.sync?.state, snapshot.sync?.connectivity);
});

await store.initialize();
```

Connection snapshots retain the replication-level `loading`, `ready`, `stale`,
and `error` states. `loading` means a registered replica has not completed its first
baseline; `ready` means every current link is caught up (or the identity is
local-only); `stale` retains a previously reached baseline while a link is no
longer current; and `error` reports paused replication or an unreadable local
status projection. `connectivity` is `unknown`, `online`, or `offline`, and
`lastActivityAt` is the newest activity time recorded by the sync engine.
`loading` has no timeout: a registered identity with no established links
remains there until the engine reports new state.

For registered identities, connectivity uses the sync engine's existing
aggregation rule: any online link makes the identity online; otherwise an
offline link makes it offline, and no links fall back to the engine-wide state.

The frozen snapshot updates from existing sync events and local state without
polling or network requests. Its reference stays stable until a field changes,
and sync state resets on lock, disconnect, replacement, or shutdown. Call
`unsubscribe()` when the consumer is released and `store.dispose()` at shutdown.

## Typed Protocols

```ts
import { Enbox, defineProtocol, recordCodecs } from '@enbox/api';

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

const { enbox } = await Enbox.connect({ password: userPassword, createIdentity: true });
const notes = enbox.using(NotesProtocol);

const record = await notes.records.create('note', {
  data : { title: 'Hello', body: 'World' },
  tags : { category: 'draft' },
});

const data = await record.value(); // { title: string; body: string }
```

`defineProtocol()` pairs each protocol record type with one runtime codec.
`enbox.using(protocol)` returns a `TypedEnbox` scoped to that protocol, so
record methods infer paths and application values while using the same codec
for writes and reads.

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
const initial = await store.initialize(); // restored sessions are readied before publication
if (initial.phase === 'disconnected') {
  await store.connect();
}
```

The connection store treats the manifest as the canonical protocol source. It
projects delegated permission requests into `connect()`, `refresh()`, and an
opted-in monitor `autoRefresh`; callers cannot supply a competing protocol
list. A manifest-backed store requires at least one protocol. It then gates
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

Transient readiness failures retain the underlying `store.auth.session` for a
retry while keeping it out of the public snapshot. A missing or incompatible
wallet protocol configuration instead ends the unusable delegate session and
sets `walletReapprovalRequired`, so the next `connect()` requests fresh
approval. On a manifest-backed store, `connect()` is delegated and a per-call
`password` unlocks the delegate vault; use `connectVault()` for an owner.

Without the connection store, project and ready the manifest explicitly:

```ts
const protocols = getApplicationProtocolRequests(application);
const { enbox } = await Enbox.connect({ connectHandler, protocols });

await enbox.protocols.ensureReady({ application });
```

The manifest retains each `TypedProtocol` for application-side use, while the
auth projection contains only raw definitions and permission names — runtime
codecs are never transmitted. The manifest itself is not a raw connect-options
object. Owner/vault connections remain explicit `connectVault()` or
`Enbox.connect({ createIdentity: true, ... })` calls.

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
API until the explicit composition contract tracked in #1462 is available.

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

// Observe one bounded materialization
const view = await notes.records.observe('note', selection);
const render = (state) => {
  console.log(state.status, state.records, state.hasMore);
};
await view.ready();
const unsubscribe = view.subscribe(render);
render(view.getState()); // close the one-shot-to-live handoff

// Consume later writes/deletes from one stream, discriminated by path
const changes = await notes.records.subscribe(['note', 'attachment'], async (event) => {
  if (event.type === 'write' && event.path === 'note') {
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

Typed record operations return application values directly: `create()` returns
a `Record`, `query()` returns a `RecordPage`, `count()` returns a number, and
`read()` returns a `Record` or `undefined`. `Record.update()` mutates and returns
the same handle, while `TypedEnbox.records.patch()` returns the freshly read and
updated record. Successful delete, store, import, and send operations resolve
without a value. Context-bound deletion requires authority-backed proof: an
authorized existing tombstone is idempotent, while a plain scoped 404 remains a
404 because the ID may name a record outside the context.

Other non-success DWN statuses throw a `DwnResponseError` with the original
status:

```ts
import { DwnResponseError } from '@enbox/api';

try {
  await notes.records.delete('note', { recordId: record.id });
} catch (error) {
  if (error instanceof DwnResponseError) {
    console.error(error.status.code, error.status.errorCode, error.status.detail);
  }
}
```

Returned records are canonical `Record<T>` instances. `value()` decodes the
typed application value through the protocol codec, while `data.json()`,
`data.text()`, `data.bytes()`, `data.blob()`, and `data.stream()` expose the
raw representation without wrapping a second record object. `update({ data })`
replaces the full payload; use `records.patch(path, recordId, patch)` for
a shallow partial object update with one bounded conflict retry.

`observe()` watches the connected tenant by default; pass `from` and, when
required, `protocolRole` to watch a foreign tenant. Subscription events are
wake hints: every immutable view state is rebuilt from the same canonical query.
Its required pagination limit bounds retained records.
When the owning session ends, a view publishes one terminal `error` state
and closes. After automatic grant refresh, `ConnectionStore` publishes a
replacement `enbox`; direct `Enbox.fromSession()` consumers recreate resources
from the replacement `AuthManager.session` announced by `session-start`.

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

Open an owned context once when several operations share the same root. Owner
and member contexts expose the same confined records contract:

```ts
const NotebookProtocol = defineProtocol(NotebookDefinition, notebookCodecs, {
  roleGroups: {
    // Strongest to weakest; used by ordinary owner and member flows.
    default: [
      'notebook/page/collaborator',
      'notebook/page/viewer',
    ],
  },
});

const notebooks = enbox.using(NotebookProtocol);
const page = await notebooks.contexts.open('notebook/page', pageContextId);

await page.records.set('notebook/page/title', { data: { title: 'Local title' } });
await page.records.query('notebook/page/delta');

const members = page.members();
let collaborator = await members.set(collaboratorDid, {
  role : 'notebook/page/viewer',
  data : {},
});
if (collaborator.delivery.state === 'awaiting-recipient-install') {
  showInstallPrompt(collaboratorDid);
  collaborator = await members.retryDelivery(collaboratorDid) ?? collaborator;
}
const memberView = await members.observe();
const renderMembers = (state) => {
  if (state.status === 'error') report(state.error);
  else render(state.records);
};
const unsubscribeMembers = memberView.subscribe(renderMembers);
renderMembers(memberView.getState());
if (collaborator.delivery.state === 'delivered') {
  await page.invite(collaboratorDid, {
    preview: { title: 'Launch notes' },
  });
}

// When the consuming component is released:
unsubscribeMembers();
await memberView.close();
```

`open()` binds a handle; it does not read the root record. An
invitation can be accepted without handling its tenant, signed record, or role
policy directly:

```ts
const inbox = await notebooks.contexts.invitations.observe();
const render = (state) => {
  if (state.status === 'error') report(state.error);
  else showInvitations(state.records);
};
const unsubscribe = inbox.subscribe(render);
render(inbox.getState());

const [invitation] = (await inbox.ready()).records;
if (invitation === undefined) throw new Error('Invitation not found.');
const shared = await invitation.accept();

// Optional before consuming a complete local append-only record set.
// follow() itself does not block on an unbounded download.
await shared.refresh();

const view = await shared.records.observe('notebook/page/title', {
  pagination: { limit: 1 },
});
const changes = await shared.records.subscribe(
  'notebook/page/delta',
  { initial: true },
  async (event) => {
    if (event.type === 'write') {
      applyDelta(await event.record.value());
    }
  },
);
await shared.records.create('notebook/page/delta', { data: nextDelta });
await shared.records.set('notebook/page/title', { data: { title: 'Shared title' } });

unsubscribe();
await changes.close();
await view.close();
await inbox.close();
```

Context-bound `records.subscribe()` also accepts `{ initial: true }`. Enbox
opens live delivery first, incrementally pages the currently visible records,
and then hands off without exposing cursors or returning one complete result
array. Each selected path is replayed oldest-first, in selection order. The
handoff is at least once: overlap may be delivered twice, but no accepted write
or delete between opening the subscription and completing the queries is
missed. The returned promise resolves after the handoff; an initial query or
listener failure closes the live stream and rejects it. Pass an `AbortSignal`
in the options to cancel one replay without closing its context. The overlap is
bounded to 1,000 changes; exceeding that bound closes and rejects the stream
instead of retaining an unbounded backlog. Use this mode for append-only
histories, and `observe()` for mutable collection truth.

Every typed protocol containing an encrypted role audience carries the same
protocol-isolated invitation inbox, derived only from its DWN definition.
`roleGroups` remains application-only metadata and enables the typed invitation
API without changing the installed definition. Dapps do not define another
record type or register another protocol. `invite()` requires an existing member
in the selected group and writes a signed offer to that member's own tenant. The
offer contains only the context ID, declared group name, and small string-valued
`preview` metadata.
The authenticated owner comes from the record creator and the protocol comes
from its signed descriptor; preview values are untrusted, non-sensitive UI
text. The recipient's ordinary own-tenant sync makes the bounded inbox
available offline.

`accept()` reuses `contexts.follow()` and leaves a failed follow retryable. Once
follow succeeds, it returns the accepted member context; a temporary inbox
cleanup failure does not falsely report that acceptance failed. `dismiss()` is
idempotent for the retained handle and does not revoke membership. Invitation
queries return the newest bounded page, defaulting to 50 records and accepting
limits from 1 through 100. Continuation and abuse hardening are tracked in
[#1552](https://github.com/enboxorg/enbox/issues/1552).

Accepted-context catalogs are currently agent-local. Consuming an invitation
on one device can therefore remove it from another device before that second
agent has accepted the context; cross-device acceptance is tracked in
[#1551](https://github.com/enboxorg/enbox/issues/1551).

`contexts.follow()` and `refresh()` throw `ContextNotReadyError` while the
context's membership, encryption, or replication state is not ready. The
condition is retryable; other establishment failures remain sanitized as a
generic context error with the original error retained as `cause`. `refresh()`
is a no-op when the replica is current; otherwise it starts one actor-scoped
pull, then rejects instead of waiting forever if that pull cannot catch it up.
If live sync is already initializing the link, it waits for that initialization
for at most ten seconds.

`shared.records` is the existing typed records implementation projected as a
context-bound API—the same contract returned by `notebooks.contexts.open()`.
Reads and views use a member context's pull-synchronized local replica;
once synchronized, they remain available offline. Creates and retained-record
mutations go to the context owner's DWN and require it to be reachable; Enbox
does not queue those mutations offline. Callers do not pass tenant DIDs, grant
IDs, `from`, `protocolRole`, root `within` selectors, or raw DWN storage
controls. Deeper descendants can still name their direct parent inside the
shared context. A new follow performs only bounded role, protocol, context-root,
and audience-key bootstrap, while the existing sync engine catches up the exact
role-readable path set.

`defineProtocol()` declares ordered, mutually-exclusive groups of direct
encrypted roles once, then reuses them at every owner and member call site. A
non-empty map
must include one protocol-global `default`; `members()` and `follow()` select
it when no group is named. Additional groups are selected explicitly with
`members('moderators')` or `follow({ ..., group: 'moderators' })`.
`set()`, `get()`, `list()`, `remove()`, and `retryDelivery()` expose only
the member DID, role, typed role data, and key-delivery state; role-record IDs,
queries, duplicate cleanup, and delivery repair stay inside Enbox. Put the
strongest role first: earlier paths have precedence if an interrupted role
change temporarily leaves more than one assignment, so Enbox never reports
less authority than the member still holds. Protocol structure property order
does not define authority precedence. Each role must authorize reading the
context root so its recipient can follow the shared context. `remove()` deletes
those role assignments but does not claim
cryptographic revocation: audience re-keying is required before a former member
is unable to decrypt future content.

Role-record paths are not exposed through `context.records`; membership has one
surface, `ownedContext.members()`.

`members.observe()` publishes immutable state through `getState()` and
`subscribe()`. Role writes, replacements, and removals that reach the local
owner replica refresh the current roster. Committed local delivery-state
changes, including background repair and `retryDelivery()`, refresh the same
view without dapp polling. `ready` means the local roster can be rendered;
check the view's `current` flag before treating it as a complete remote roster.
Neither state implies that every member's delivery is `delivered`.

Owned collaboration roots and accepted member contexts are returned together
by `await notebooks.contexts.list()`. Accepted contexts survive restart. For a
live catalog, subscribe to the same local truth:

```ts
const contexts = await notebooks.contexts.observe();
const renderState = ({ status, contexts, error }) => {
  if (status === 'error') report(error);
  else render(contexts);
};
const unsubscribe = contexts.subscribe(renderState);
renderState(contexts.getState());

// When the consuming component is released:
unsubscribe();
await contexts.close();
```

The catalog's `ready` state means its first local materialization has loaded.
Record views expose `current`, and member contexts expose `refresh()`, for
replication freshness. Catalog entries discriminate owner and member access
through `context.access`; when the same owner and context ID appears through
both routes, owner access wins.
Enbox persists the ordered role group and automatically replaces the active
role when every advertised owner endpoint proves the same new role record. The
active readable paths come from that hosted protocol definition; a definition
change that alters them creates a new fenced acceptance. Operations, streams,
and views on the former handle then fail with `ContextRetiredError`, so reload
the context from `contexts.list()` or `contexts.observe()`. A stored acceptance
whose active role no longer exists in the application's definition is omitted
from that catalog; following the context with the current role policy replaces
it. Enbox removes the accepted context only when every endpoint proves every
candidate role absent.
An unreachable, lagging, malformed, or disagreeing endpoint retains the last
local context and never implies removal.
`forget()` removes only this exact accepted source locally; a retained handle
cannot remove a replacement acceptance. `leave()` sends one signed deletion to
every advertised owner DWN, stores the tombstone in the local replica, and then
retires only that acceptance; an endpoint without a durable tombstone leaves the
local source intact for retry. It is available only when that role path authorizes
recipient `co-delete`. Following the same owner context again after removal
creates a fresh local acceptance, even when the remote role-record ID is
unchanged.

A removed source role fences future replication, but previously learned
plaintext remains local; forward-secure member removal requires audience-key
rotation in addition to role deletion.

For wallet-delegated member sessions, a foreign owner's DWN can enforce the
embedded grant's expiry but does not automatically receive revocations stored
on the member's own DWNs. Treat revocation of a compromised delegate as
expiry-bounded until verifier-visible foreign-context revocation is added.

Include the protocol in the connection store's application manifest. The
normal connection lifecycle then owns the actor's sync registration and its
current wallet delegate. Raw-agent constructor users must register that actor;
start the live sync engine when ongoing background replication is desired.

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
| `Enbox` | Main app API: `connect()`, `fromSession()`, `anonymous()`, `using()`. |
| `defineProtocol()` | Creates typed protocol definitions. |
| `RecordQuery` | Protocol-derived filter, date ordering, and pagination shared by query and count. |
| `RecordPage<Item>` | One page of selected record items with cursor-free `next()` pagination. |
| `RecordView<Item>` | Closeable bounded query view with immutable state. |
| `ContextView` | Closeable live catalog of owned and accepted member contexts. |
| `ProtocolContext` | Discriminated owner/member entry returned by a context catalog. |
| `OwnedContext` / `MemberContext` | Context-scoped records and owner/member lifecycle handles. |
| `ContextMember` | One owner-managed member and its audience-key delivery state. |
| `MaterializedRecord<T>` | A decoded value paired with its canonical mutable record handle. |
| `TypedEnbox` | Protocol-scoped record API returned by `enbox.using()`. |
| `Record<T>` | Canonical mutable record handle with protocol-derived payload typing. |
| `DwnResponseError` | Typed-operation error carrying the original non-success DWN status. |
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
