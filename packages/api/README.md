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
import { Enbox, defineProtocol } from '@enbox/api';

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
} as const, {} as {
  note: { title: string; body: string };
});

const { enbox } = await Enbox.connect({ password: userPassword, createIdentity: true });
const notes = enbox.using(NotesProtocol);

const { record } = await notes.records.create('note', {
  data : { title: 'Hello', body: 'World' },
  tags : { category: 'draft' },
});

const data = await record.data.json(); // { title: string; body: string }
```

`defineProtocol()` preserves protocol paths and schema map types at compile
time. `enbox.using(protocol)` returns a `TypedEnbox` scoped to that protocol, so
record methods can infer paths and payload shapes.

## Records

```ts
// Create
const { record } = await notes.records.create('note', {
  data: { title: 'Launch', body: 'Ship it' },
});

const selection = { pagination: { limit: 20 } };

// Query
const { records, cursor } = await notes.records.query('note', selection);

// Observe one bounded local materialization
const view = await notes.records.observe('note', selection);
const unsubscribe = view.subscribe((snapshot) => {
  console.log(snapshot.state, snapshot.records, snapshot.hasMore);
});

// Count the same selection before pagination
const { count } = await notes.records.count('note', selection);

// Read
const { record: found } = await notes.records.read('note', {
  filter: { recordId: record.id },
});

// Update
await found.update({
  data: { title: 'Launch', body: 'Shipped' },
});

// Delete
await found.delete();

unsubscribe();
await view.close();
```

Returned records are `TypedRecord<T>` instances. They expose typed
`data.json()` plus `data.text()`, `data.bytes()`, `data.blob()`, and
`data.stream()`.

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

The snapshot object and records array are immutable. Each `TypedRecord` handle
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
the advanced export:

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
import { Enbox, BrowserConnectHandler, defineProtocol } from '@enbox/browser';
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
| `RecordView<T>` | Closeable bounded local query materialization with immutable snapshots. |
| `TypedEnbox` | Protocol-scoped record API returned by `enbox.using()`. |
| `TypedRecord<T>` | Type-safe record wrapper. |
| `Record` / `ReadOnlyRecord` | Mutable and anonymous-read record wrappers. |
| `DidApi` | DID resolution helpers. |
| `DwnReaderApi` | Anonymous read-only DWN API. |

## Related Packages

- [`@enbox/auth`](../auth): Auth lifecycle and session management.
- [`@enbox/agent`](../agent): Agent runtime, local DWN, key management, sync.
- [`@enbox/protocols`](../protocols): Ready-to-use protocol definitions.
- [`@enbox/protocol-codegen`](../protocol-codegen): Type generation from protocol JSON.

## License

Apache-2.0
