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
  defineApplicationManifest,
  getApplicationProtocolRequests,
} from '@enbox/api';

const application = defineApplicationManifest({
  protocols: [
    NotesProtocol, // default: read, write, delete
    { protocol: PhotosProtocol, permissions: ['read'] },
  ],
} as const);

// Only delegated handler flows need auth permission requests.
const protocols = getApplicationProtocolRequests(application);
const { enbox } = await Enbox.connect({ connectHandler, protocols });

// Install locally and make the protocols available at the owner's hosted DWN.
await enbox.protocols.ensureReady({ application });
```

The manifest retains each `TypedProtocol` for application-side use, while the
auth projection contains only raw definitions and permission names — runtime
codecs are never transmitted. The manifest itself is not a connect-options
object. Owner/vault connections remain explicit `connectVault()` or
`Enbox.connect({ createIdentity: true, ... })` calls without the projected
protocol requests.

`ensureReady()` publishes only for owner sessions. A delegated session instead
validates and imports the wallet-owned configurations without authoring or
publishing replacements. Pass `targetDid` only when publishing for another
owner identity controlled by the same agent. The lower-level
`enbox.using(protocol).configure()` never publishes to a hosted DWN.

Typed protocol composition through `$ref` is not inferred from incomplete
local metadata. `defineProtocol()` rejects it for now; use the raw `enbox.dwn`
API until the explicit composition contract tracked in #1462 is available.

## Records

```ts
// Create
const record = await notes.records.create('note', {
  data: { title: 'Launch', body: 'Ship it' },
});

const selection = { pagination: { limit: 20 } };

// Query
const page = await notes.records.query('note', selection);
const { records, cursor } = page;

// Observe one bounded local materialization
const view = await notes.records.observe('note', selection);
const unsubscribe = view.subscribe((snapshot) => {
  console.log(snapshot.state, snapshot.records, snapshot.hasMore);
});

// Count the same selection before pagination
const count = await notes.records.count('note', selection);

// Read
const found = await notes.records.read('note', {
  filter: { recordId: record.id },
});

if (found === undefined) {
  throw new Error('Note not found');
}

// Update
await found.update({
  data: { title: 'Launch', body: 'Shipped' },
});

// Delete
await found.delete();

unsubscribe();
await view.close();
```

Typed record operations return application values directly: `create()` returns
a `Record`, `query()` returns a `RecordPage`, `count()` returns a number, and
`read()` returns a `Record` or `undefined`. `Record.update()` and `patch()`
return the same updated handle; successful delete, store, import, and send
operations resolve without a value. Other non-success DWN statuses throw a
`DwnResponseError` with the original status:

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
replaces the full payload; use `patch()` for a shallow partial object update.

`observe()` watches only the connected tenant's local replica. Subscription
events are wake hints: every immutable snapshot is rebuilt from the same
canonical query. Its required pagination limit bounds retained records, and
its `loading`, `ready`, `stale`, or `error` state reflects replica currentness.
When the owning session ends, a view publishes one terminal `error` snapshot
and closes. After automatic grant refresh, `ConnectionStore` publishes a
replacement `enbox`; direct `Enbox.fromSession()` consumers recreate resources
from the replacement `AuthManager.session` announced by `session-start`.

`loading` means a replicated source has not completed its required pull yet;
an empty `ready` snapshot is therefore authoritatively empty, not still
bootstrapping. After a view has been ready, an offline or catching-up source
makes it `stale`. Successful local queries continue to update stale snapshots,
so offline writes remain visible. Query, authorization, and terminal sync
failures publish `error` while retaining the latest successful records.
`hasMore` is always present: it is `false` before the first query and whenever
the latest bounded result has no continuation cursor.

The snapshot object and records array are immutable. Each `Record<T>` handle
represents the queried version until the caller explicitly uses that handle's
normal `update()` or `delete()` method; record data remains lazily read.

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
| `RecordPage<Item>` | One page of selected record items and its optional continuation cursor. |
| `RecordView<Item>` | Closeable bounded local query view with immutable snapshots. |
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
