# TODO app API proposal

A concrete proposal for simplifying the application-facing Enbox SDK, built
around one complete example: a wallet-connected TODO app.

This is a design document. **No API shown here as `PROPOSED` exists yet.**
Every proposal is grounded in the current source; the
[current-to-proposed mapping](#current-to-proposed-mapping) names the exact
files each piece builds on. Existing APIs — typed protocols, records,
`ConnectionStore`, shared contexts, `BrowserConnectHandler`,
`activatePolyfills()` — remain available unchanged for advanced applications.

The runtime boundary from [Browser dapps](browser-dapps.md) is preserved
verbatim: **the page owns sessions, views, and sockets; the
application-owned service worker owns DRL fetches and the offline shell.**

## 1. The TODO application

The example app supports:

- Connect a wallet (explicit user action) and restore an existing session on
  reload without a second approval.
- A live, bounded list of TODOs — no polling, no refresh button.
- Add, complete/uncomplete, and delete a TODO.
- Locally persisted data stays usable offline; changes replicate later.
- Loading states, actionable errors, and replication freshness are visible.
- Wallet reapproval (expiry, revocation) and sign-out are handled.

Data model: one owner-only, encrypted protocol with one JSON type. The DWN
record ID is the identity of a TODO; there is no app-assigned ID.

```ts
type TodoData = { title: string; completed: boolean };
```

Deliberately excluded: sharing, CRDTs, attachments, search, routing,
design-system work, and standardizing a TODO protocol.

## 2. Proposed developer experience

### 2.1 Scaffold

```bash
bunx @enbox/create-app my-todos     # PROPOSED — not yet implemented
cd my-todos
bun install
bun run dev
```

The generator produces a Vite + React + TypeScript project with
`@enbox/browser`, `@enbox/react`, and `vite-plugin-pwa` already wired. Until
the generator exists, the same files are the documentation recipe (Section
2.6 lists every file and exactly what it supplies).

### 2.2 Protocol definition

Unchanged from today (`defineProtocol` + `recordCodecs` from
`@enbox/browser`, via `packages/api/src/define-protocol.ts`). Owner-only by
default: no `$actions` rules means only the owner's tenant can read or write.
`encryptionRequired: true` routes every record through the DWN encryption
envelope.

```ts
// src/enbox/todo-protocol.ts — CURRENT API, no changes
import { defineProtocol, recordCodecs } from '@enbox/browser';

export type TodoData = {
  completed : boolean;
  title     : string;
};

export const TodoProtocol = defineProtocol({
  protocol  : 'https://todos.example/protocols/todo/v1',
  published : false,
  types     : {
    todo: {
      schema             : 'https://todos.example/schemas/todo/v1',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
  },
  structure: {
    todo: {},
  },
} as const, {
  todo: recordCodecs.json<TodoData>(),
});
```

### 2.3 Application configuration

The entire Enbox configuration — the design target is ~10 lines:

```ts
// src/enbox/app.ts — PROPOSED API (createApp does not exist yet)
import { createApp } from '@enbox/browser';

import { TodoProtocol } from './todo-protocol.js';

export const app = createApp({
  name      : 'Todos',
  icon      : '/icon.svg',
  protocols : [TodoProtocol],
});
```

`createApp()` composes what an app wires by hand today
(`packages/api/src/application-manifest.ts`,
`packages/api/src/connection-store.ts`,
`packages/browser/src/browser-connect-handler.ts`):

- `defineApplicationManifest({ protocols })` — the manifest stays the source
  for protocol installation, delegated permissions, sync registration, and
  grant refresh.
- `BrowserConnectHandler({ appName, appIcon })` — wallet selection UI
  unchanged.
- `createConnectionStore({ application, connectHandler, monitor })` — the
  headless state machine stays the engine; `createApp` returns it, dressed.

```ts
// PROPOSED — packages/browser/src/create-app.ts
export interface EnboxApp extends ConnectionStore {
  readonly application : ApplicationManifest;
  readonly name        : string;

  /**
   * Full application boot: register and await the DWeb service worker,
   * install page-side DRL link handling, then restore any session.
   * Resolves to the post-restore snapshot; worker boot failures reject.
   */
  start(options?: AppStartOptions): Promise<ConnectionSnapshot>;
}

export type CreateAppOptions = {
  name           : string;
  protocols      : readonly ApplicationManifestProtocolInput[];
  applicationId? : string;                     // default: page origin
  icon?          : string;                     // default: ${origin}/favicon.ico
  renewal?       : 'auto' | 'manual';          // default: 'auto' (Section 3.5)
  wallets?       : WalletOption[];             // default: DEFAULT_WALLETS
  walletUrl?     : string;                     // pin one wallet, skip selector
  worker?        : { url?: string } | false;   // default: { url: '/sw.js' }
  connectHandler?: ConnectHandler;             // escape hatch (CLI, tests)
  auth?          : AuthManager;                // escape hatch (caller-owned)
  onDrain?       : (reason: DrainReason) => Promise<void>;  // Section 3.6
};
```

Because `EnboxApp extends ConnectionStore`, everything the store already does
— `initialize`, `connect`, `connectVault`, `refresh`, `disconnect`,
`refreshDwnEndpoints`, `retryRemote`, `dispose`, `subscribe`, `getSnapshot` —
is available untouched. Advanced apps keep the whole lower-level surface.

### 2.4 Browser startup

```tsx
// src/main.tsx — PROPOSED API (app.start does not exist yet)
import { EnboxProvider } from '@enbox/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { app } from './enbox/app.js';

async function main(): Promise<void> {
  await app.start();   // worker registered + controlling, session restored
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <EnboxProvider app={app}>
        <App />
      </EnboxProvider>
    </StrictMode>,
  );
}

void main().catch(() => {
  document.getElementById('root')!.textContent = 'Application startup failed.';
});
```

`app.start()` performs the boot order the current guide writes by hand
(`apps/docs/content/docs/guides/browser-dapp.mdx` lines 196–237):

1. `navigator.serviceWorker.register('/sw.js', { type: 'module' })`;
2. await `navigator.serviceWorker.ready` and, on first visit, the
   `controllerchange` that gives the worker control of the page;
3. page-side `activatePolyfills({ serviceWorker: false })` for DRL link
   handling and loading UI;
4. `connectionStore.initialize()` — session restore.

`worker: false` opts out for hosts with custom registration; the manual
sequence remains documented for them.

### 2.5 React UI

Bindings live in a **new package, `@enbox/react`** (PROPOSED), with `react`
as a peer dependency. `@enbox/browser` stays framework-free — there is no
React dependency anywhere in `packages/*` today, and the modal/QR UI is
Shadow DOM. The bindings are four exports:

```ts
// PROPOSED — @enbox/react
export function EnboxProvider(props: { app: EnboxApp; children: ReactNode }): JSX.Element;
export function useConnection(): ConnectionBinding;
export function useProtocol<P extends TypedProtocol>(protocol: P): TypedEnboxFor<P> | undefined;
export function useRecords<D, C, Path extends ProtocolPaths<D> & string>(
  protocol: TypedProtocol<D, C>,
  path: Path,
  options: { limit: number } & Omit<TypedObserveRequest<D, Path, true>, 'materialize' | 'pagination'>,
): RecordsBinding<D, C, Path>;
```

`EnboxProvider` is a pure `useSyncExternalStore` subscription over the app's
store — no lifecycle ownership, no gates. The connection UI:

```tsx
// src/App.tsx — PROPOSED API (useConnection does not exist yet)
import { isConnectDeniedError } from '@enbox/browser';
import { useConnection } from '@enbox/react';

import { Todos } from './Todos.js';

export function App(): JSX.Element {
  const { connect, disconnect, error, phase, walletReapprovalRequired } = useConnection();

  if (phase === 'initializing' || phase === 'connecting') {
    return <p>Starting…</p>;
  }

  if (phase !== 'connected') {
    const denied = error !== undefined && isConnectDeniedError(error);
    return (
      <main>
        {error !== undefined && !denied && <p role="alert">{error.message}</p>}
        <button onClick={() => void connect()}>
          {walletReapprovalRequired ? 'Reconnect wallet' : 'Connect wallet'}
        </button>
      </main>
    );
  }

  return (
    <main>
      <Todos />
      <button onClick={() => void disconnect()}>Sign out</button>
    </main>
  );
}
```

The connected screen — 46 lines, inside the 30–50 line design target, with
loading, error, and freshness states included rather than omitted:

```tsx
// src/Todos.tsx — PROPOSED API (useRecords/useProtocol do not exist yet;
// records.create/patch/delete are CURRENT APIs, unchanged)
import { useProtocol, useRecords } from '@enbox/react';
import { useState } from 'react';

import { TodoProtocol } from './enbox/todo-protocol.js';

export function Todos(): JSX.Element {
  const todos = useProtocol(TodoProtocol);
  const view = useRecords(TodoProtocol, 'todo', { limit: 50 });
  const [title, setTitle] = useState('');

  if (view.status === 'loading') {
    return <p>Loading…</p>;
  }
  if (view.status === 'error') {
    return <p role="alert">Could not load todos. <button onClick={view.retry}>Retry</button></p>;
  }

  const add = async (): Promise<void> => {
    if (todos === undefined || title.trim() === '') { return; }
    await todos.records.create('todo', { data: { completed: false, title: title.trim() } });
    setTitle('');
  };

  return (
    <section>
      {!view.current && <p>Offline or syncing — changes will replicate when connected.</p>}
      <form onSubmit={(event): void => { event.preventDefault(); void add(); }}>
        <input value={title} onChange={(event): void => setTitle(event.target.value)} placeholder="Add a todo" />
        <button type="submit">Add</button>
      </form>
      <ul>
        {view.records.map(({ record, value }) => (
          <li key={record.id}>
            <label>
              <input
                type="checkbox"
                checked={value.completed}
                onChange={() => void todos?.records.patch('todo', record.id, { completed: !value.completed })}
              />
              {value.title}
            </label>
            <button onClick={() => void todos?.records.delete('todo', { recordId: record.id })}>Delete</button>
          </li>
        ))}
      </ul>
      {view.hasMore && <button onClick={() => void view.loadMore()}>Load more</button>}
    </section>
  );
}
```

`useRecords` returns `{ status, records, current, hasMore, error, loadMore,
retry }`. Rows are materialized `{ record, value }` pairs — the same shape as
today's `records.observe(path, { materialize: true, pagination })`
(`packages/api/src/typed-enbox.ts`, `observe` at line 3420;
`packages/api/src/record-view.ts`). `record.id` is the TODO's identity and
React key.

Mutations deliberately stay on the existing typed records API:
`records.create('todo', { data })`, `records.patch('todo', id, patch)`,
`records.delete('todo', { recordId })` are already readable. **No path-bound
collection helpers are proposed.** The TODO example establishes no need for
`todos.collection('todo').add(...)`-style wrappers; they remain possible
follow-up work if a future example demonstrates concrete value.

Non-React apps use the same `EnboxApp` directly:
`app.subscribe(render)` / `app.getSnapshot()` and `records.observe()` — the
bindings are an optional shell, not a new runtime.

### 2.6 Service worker and the full file inventory

The worker file is unchanged from the current recipe and is supplied by the
scaffold:

```ts
// src/sw.ts — CURRENT API, generated verbatim by the scaffold
/// <reference lib="webworker" />
import { activatePolyfills } from '@enbox/browser';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare let self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));

activatePolyfills({ onCacheCheck: () => ({ ttl: 30_000 }) });
```

Every file the developer has after scaffolding:

| File | Supplies |
|---|---|
| `vite.config.ts` | `@vitejs/plugin-react` + `VitePWA` with `strategies: 'injectManifest'`, `srcDir: 'src'`, `filename: 'sw.ts'`, `injectRegister: false`, 8 MiB precache limit, `devOptions` for dev-mode SW. Identical to the current guide's block. |
| `index.html` | Vite default plus app icon/title. |
| `src/sw.ts` | Above: Workbox precache + SPA navigation route + `activatePolyfills()`. |
| `src/main.tsx` | Section 2.4: boot order, root render. |
| `src/enbox/todo-protocol.ts` | Section 2.2: protocol + codecs. |
| `src/enbox/app.ts` | Section 2.3: `createApp()` — the only Enbox configuration. |
| `src/App.tsx` | Section 2.5: connection gate. |
| `src/Todos.tsx` | Section 2.5: connected screen. |

Hosting headers (HTTPS, SPA fallback, `Cache-Control` on `/sw.js`,
Referrer-Policy, no `Cross-Origin-Opener-Policy: same-origin`) are unchanged
and stay in the hosting section of the public guide.

## 3. Lifecycle contract

This section is the normative contract for `EnboxApp` and the bindings.

### 3.1 Construction, start, connection, disconnect, disposal

| Moment | Contract |
|---|---|
| **Construction** — `createApp()` | Synchronous, no I/O, no storage handles. Safe at module scope; exactly one per page load. The `AuthManager` materializes lazily on the first action (current store behavior, `connection-store.ts` `_ensureAuth`). |
| **Start** — `app.start()` | Once per page load, awaited before render. Idempotent and single-flighted (inherits `initialize()` semantics). Worker failure rejects (startup failure); session-restore failure lands in the snapshot as `phase: 'error'`. |
| **Connection** — `app.connect()` | Explicit user action only — the wallet popup needs the browser gesture. Never rejects for flow outcomes: denial resolves `phase: 'disconnected'` with `error` set to `ConnectDeniedError` (distinguish with `isConnectDeniedError`); other failures resolve `phase: 'error'`. Calls while an action is in flight join it (single-flight). |
| **Disconnect** — `app.disconnect({ clearStorage?, discardPending? })` | Runs the optional drain hook first (Section 3.6), then grant revocation + session cleanup. Supersedes an in-flight connect. `clearStorage: true` additionally wipes the local replica. |
| **Disposal** — `app.dispose()` | Terminal teardown for app shutdown. Not a sign-out, not part of React unmount. Actions on a disposed app throw synchronously (programming error). |

### 3.2 Startup with and without a restored session

- **Restored session:** `start()` resolves `phase: 'connected'`; the UI
  renders the TODO screen immediately. `useRecords` opens its view against
  the local replica; records render as soon as the first local query
  completes, before any network.
- **No session:** `start()` resolves `phase: 'disconnected'`; the UI renders
  the connect button. Nothing about data is loaded.
- **Locked vault / repairable delegated session:** the snapshot carries
  `vaultLocked` / `walletReapprovalRequired` as today; the connect button
  copy follows the flag.

### 3.3 Local usability versus remote currentness

A resolved mutation means the record is durably accepted into the local
IndexedDB replica and queued for replication — never that a remote DWN has
acknowledged it. Remote convergence is reported separately:

- per view: `RecordViewState.current` (`ready` + `current: false` = usable
  local data, replicas catching up);
- aggregate: `ConnectionSnapshot.sync` (`SyncStatusSnapshot` with
  connectivity, per-remote health, retry state).

The TODO app renders the local list unconditionally and shows the freshness
line when `!view.current`. No timers, no re-query loops — views are wake-driven
(`record-view.ts`: subscription payloads are wake hints; every published
collection re-runs the canonical query).

### 3.4 Wallet denial, expiry, revocation, reapproval

- **Denial:** a user decision, not a failure. Phase rests at
  `'disconnected'`; the `ConnectDeniedError` is available for copy but the UI
  treats it as neutral (Section 2.5).
- **Expiry / revocation / coverage gaps:** the delegated monitor publishes
  `walletReapprovalRequired: true` with `connection.state` ∈
  `expired | revoked | permissions-changed`. Local data remains readable.
- **Reapproval:** always an explicit user action. `connect()` on a retained
  repairable session runs `AuthManager.refresh()` instead of starting a
  second session (existing store behavior). On success the flag clears and
  the facade is replaced.

### 3.5 Renewal policy (recommended default and why)

**Proposal: `renewal: 'auto'` is the default; `renewal: 'manual'` is the
documented escape for buffer-holding apps.**

Wallet approvals issue one-hour grants by default, so some renewal strategy
is mandatory. notesd keeps repair explicit because it holds unsaved,
identity-bound plaintext (CRDT editor buffers) that must survive facade
replacement — automatic renewal at an arbitrary moment can fence the facade
its flush loops are writing through.

The TODO app — and the default app class this proposal targets — commits
every mutation to the durable local replica at action time. For that class,
facade replacement is safe: views rebind automatically and there is no
in-memory plaintext to lose. Automatic renewal (`monitor: { autoRefresh: {} }`,
the current guide's recommendation) is the correct default **for them**.

Lifecycle implications, stated explicitly:

- `renewal: 'auto'`: the store renews grants before expiry using manifest
  protocols. A successful renewal replaces the `enbox` facade; bindings
  rebind views. A **failed** renewal (offline, wallet unreachable) degrades
  to `walletReapprovalRequired` — the explicit path, same as manual mode.
  Revocation is never auto-healable in either mode.
- `renewal: 'manual'`: the monitor observes but never refreshes. Expiry,
  revocation, and coverage gaps all surface as `walletReapprovalRequired`;
  the app renders a repair affordance and the user re-approves. Apps that
  hold identity-bound plaintext between writes (CRDT flush loops, encrypted
  drafts) must choose this and pair it with the drain hook (3.6) and
  repair-state retention, as notesd does today.

### 3.6 Draining and retaining pending work (advanced apps)

The SDK owns the state machine; applications own their unsaved buffers. The
boundary is one optional hook plus one option, added to the connection store
(PROPOSSED):

```ts
onDrain?: (reason: 'connect' | 'disconnect') => Promise<void>;
```

- `connect()` runs `onDrain('connect')` before a **fresh** connect. It never
  runs before a same-identity repair (repair preserves the workspace —
  notesd's rule).
- `disconnect()` runs `onDrain('disconnect')` before teardown. If the hook
  rejects, disconnect aborts, the session stays live, and the error lands in
  the snapshot. The app may then offer `disconnect({ discardPending: true })`,
  which skips the hook — the generic form of notesd's `WorkspaceDrainError` +
  "discard local edits and sign out" flow.
- **Enforcement is never delayed by the hook.** Revocation and session loss
  detected by the monitor fence the session synchronously — auth aborts the
  session lifetime, which aborts every typed operation through the facade —
  before and regardless of any drain. The hook can delay a user-initiated
  sign-out; it cannot delay authorization enforcement.
- Repair-state retention (notesd's `WorkspaceRepairState`: memory-only
  plaintext carried across same-identity facade replacement) stays
  application-side. What moves into the SDK is the publication guarantee that
  makes it simple: during a same-identity refresh, the store keeps publishing
  the previous `session` and `enbox` while `phase: 'connecting'` until the
  replacement commits (PROPOSED store change), instead of clearing them and
  forcing every app to latch the old facade across the gap.

### 3.7 Same-identity replacement versus identity switching

- **Same-identity repair** pins the provider DID of the retained session
  (the connect handshake's `expectedProviderDid`). If the wallet returns a
  different identity during repair, the action fails with an actionable
  error; the existing session is never silently replaced by another
  identity's (PROPOSED store guard — today this is enforceable only through
  handler options apps must wire themselves).
- **Identity switching** requires explicit `disconnect()` first. With
  `clearStorage: true` the previous identity's local replica is destroyed.
  Even with `clearStorage: false`, the next identity gets a fresh facade and
  fresh views over tenant-scoped stores; the previous identity's encrypted
  records are undecryptable ciphertext to it. The SDK never adopts a
  different-DID session over a live one without an intervening disconnect.

### 3.8 View opening, cancellation, rebinding, cleanup

- `useRecords` opens its view in an effect keyed by the current facade,
  protocol, path, and scalar options (`limit`, `within`, …) — never object
  identity. The open is cancellable through an `AbortController`; a stale
  open is aborted and its view closed.
- Facade replacement (renewal, repair) changes the key: the old view is
  closed and a fresh one opens against the new facade. No app code runs.
- `view.close()` is idempotent; closing fences callbacks and local
  subscriptions without publishing (existing `RecordView` contract).
- A terminal view error publishes `status: 'error'`; the binding's `retry()`
  re-opens a fresh view. Errors are actionable, not silent.
- Sign-out closes the facade, which aborts every view opened through it;
  bindings tear down on the resulting snapshot change.

### 3.9 React StrictMode and pending asynchronous operations

- The app object is a **module-level singleton**, created once per page load.
  StrictMode's setup–cleanup–setup replay never reconstructs it, and effect
  cleanup never disposes it. This removes the deferred-dispose generation
  trick every app currently reimplements (notesd's `EnboxProvider` lines
  126–139) by contract rather than by pattern.
- `app.start()` is called once from `main.tsx`, not from an effect. It is
  idempotent and single-flighted, so accidental double invocation is safe.
- `useRecords` under StrictMode opens two views sequentially (replay closes
  the first synchronously). Views are explicitly built for this: bounded,
  signal-cancelled, idempotent close.
- A disconnect that lands while a connect or view-open is in flight
  supersedes it; the stale outcome is discarded by the store's generation
  gate (existing behavior).

### 3.10 Error behavior summary

| Action | Outcome channel |
|---|---|
| `connect` / `disconnect` / `refresh` / `start` (session part) | Resolve a snapshot; denial vs failure via `isConnectDeniedError`; UI reads state. |
| `start` (worker part) | Rejects — startup is impossible without the worker boundary; fail loudly before render. |
| `records.create/patch/delete` | Reject with typed errors (`DwnResponseError`, codec validation failures). `patch` internally retries once on the canonical 409 conflict. `delete` treats a 404 miss as success (idempotent). |
| Observed views | Publish `status: 'error'` with the cause; terminal until `retry()`. |
| Sync freshness | `sync.state: 'error'` carries paused-link detail; `retryRemote(endpoint)` is the action. |

## 4. Current-to-proposed mapping

### 4.1 What the same app costs today

The compact current-API equivalent of Sections 2.3–2.5 (from the public
guide, abridged but functional):

```ts
// CURRENT API — src/enbox/application.ts
export const application = defineApplicationManifest({ protocols: [TodoProtocol] } as const);
export const connectionStore = createConnectionStore({
  application,
  connectHandler : BrowserConnectHandler({ appName: 'Todos', appIcon: `${window.location.origin}/icon.svg` }),
  monitor        : { autoRefresh: {} },
});
```

```tsx
// CURRENT API — Connection gate + boot glue (abridged)
const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
// + phase mapping, denial discrimination, walletReapprovalRequired copy,
// + a mount-once initialize() effect with StrictMode-safe deferred dispose,
// + manual worker registration / ready / controllerchange await in main.tsx
//   (guide lines 196–237), + page-side activatePolyfills call.
```

```tsx
// CURRENT API — live list hook every app hand-rolls
const [state, setState] = useState(view.getSnapshot());
useEffect(() => {
  const lifetime = new AbortController();
  let view: ExpandableRecordView<...> | undefined;
  let unsubscribe: (() => void) | undefined;
  void enbox.using(TodoProtocol).records
    .observe('todo', { materialize: true, pagination: { limit: 50 }, signal: lifetime.signal })
    .then((opened) => {
      if (lifetime.signal.aborted) { void opened.close(); return; }
      view = opened;
      unsubscribe = opened.subscribe(() => setState(opened.getSnapshot()));
      setState(opened.getSnapshot());
    });
  return () => { lifetime.abort(); unsubscribe?.(); void view?.close(); };
}, [enbox]);
```

Today that is ~15 lines of manifest/store setup, ~30 lines of connection
gate, ~35 lines of worker boot, and ~30 lines per observed list — roughly
**110 lines of generic plumbing before any TODO logic**, rising to ~590 lines
in a production app like notesd (its `EnboxProvider` alone is 286 lines, of
which ~200 are generic).

### 4.2 Mapping table

| Proposed capability | Exists today | Required change | Owner package | Disappears from a typical app |
|---|---|---|---|---|
| Manifest definition | `defineApplicationManifest` (`packages/api/src/application-manifest.ts:85`) | None | `@enbox/api` | — (folded into `createApp`) |
| Wallet connect UI | `BrowserConnectHandler` (`packages/browser/src/browser-connect-handler.ts:177`) | None | `@enbox/browser` | Manual handler construction |
| Connection state machine | `createConnectionStore` / `HeadlessConnectionStore` (`packages/api/src/connection-store.ts:527`) | None for the core | `@enbox/api` | Per-app provider plumbing, phase→flag mapping |
| App composition + boot | — | **New** `createApp()`, `EnboxApp.start()` | `@enbox/browser` (new `create-app.ts`) | `main.tsx` worker choreography; store/handler/manifest wiring |
| React bindings | — (no React anywhere in `packages/*`) | **New package** `@enbox/react`: `EnboxProvider`, `useConnection`, `useProtocol`, `useRecords` | `@enbox/react` | `useSyncExternalStore` glue, observe/abort/close hooks, facade-rebind effects |
| Retained facade during repair | Refresh-instead-of-reconnect exists (`connection-store.ts:600–613`); gap-clearing behavior (`:963–968`) forces app-side latching | **Store change:** keep publishing prior `session`/`enbox` through same-identity `'connecting'` | `@enbox/api` | notesd's repair latch / retained-session logic |
| Drain before user-initiated teardown | App-side only (notesd's `workspace-lifecycle.ts` + `WorkspaceDrainError`) | **Store options:** `onDrain`, `disconnect({ discardPending })` | `@enbox/api` | Drain registries and drain-error plumbing |
| Identity pinning on repair | `expectedProviderDid` exists in handler params | **Store guard:** reject mismatched-DID repair outcomes | `@enbox/api` / `@enbox/auth` | Hand-wired pinning |
| Live bounded list | `records.observe` → `ExpandableRecordView` (`typed-enbox.ts:3420`, `record-view.ts`) | None | `@enbox/api` | — (consumed via `useRecords`) |
| Mutations | `records.create/patch/delete` (`typed-enbox.ts` records API) | None | `@enbox/api` | — (used directly) |
| Freshness | `RecordViewState.current`, `SyncStatusSnapshot` | None | `@enbox/api` / `@enbox/agent` | Custom sync polling |
| Denial discrimination | `isConnectDeniedError` (`@enbox/auth`) | None | `@enbox/auth` | — |
| DRL / offline worker | `activatePolyfills` (`packages/browser/src/web-features.ts:583`) | None | `@enbox/browser` | — (generated `sw.ts`) |
| Scaffold | Manual recipe in the guide | **New package** `@enbox/create-app` | `@enbox/create-app` | Boilerplate copying |
| Standard protocols | `ProfileProtocol`, `PreferencesProtocol` (`packages/protocols/src/profile.ts`, `preferences.ts`) | None | `@enbox/protocols` | — |

### 4.3 What does *not* disappear

notesd's workspace layer — `WorkspaceProvider`, `openWorkspaceSession`, the
CRDT corpus controllers, live rooms, sharing controllers, first-run
bootstrap, repair-state retention — is application behavior and stays
application-side. This proposal removes the *generic* plumbing notesd
reimplements (provider lifecycle, repair latching, view adapters, drain
registry), not its workspace controllers. A CRDT app on the proposed SDK
would still write those controllers, now against `useProtocol` +
`records.subscribe` + `onDrain` instead of a hand-rolled provider.

### 4.4 Standard protocols

Profile and preferences protocols already exist in `@enbox/protocols`
(`ProfileDefinition`/`ProfileProtocol`, `PreferencesDefinition`/
`PreferencesProtocol`), with `createProfileReader` re-exported through
`@enbox/browser`. The TODO example intentionally does **not** depend on
standardizing a new TODO protocol: its protocol URI is application-owned
(`https://todos.example/...`), which keeps the data model under the app's
control and the example free of ecosystem coordination.

## 5. Staged implementation plan

Dependency-ordered. Each PR is independently reviewable and ships green.
Stage numbering continues from this proposal (stage 1).

**PR 2.1 — `@enbox/browser`: `createApp()` + `EnboxApp.start()`**
Scope: `create-app.ts` composing manifest, handler, and store; worker boot
sequence; `renewal` option mapping to `monitor`; escape-hatch options
(`connectHandler`, `auth`, `worker: false`). Tests in the package's Vitest
browser suite with a stubbed `ConnectHandler` and stubbed SW registration.
Completion: the TODO example runs against `createApp` with zero hand-written
store/handler/boot code; existing browser tests green.

**PR 2.2 — `@enbox/api`: repair/lifecycle store additions**
Scope: retained-facade publication during same-identity `'connecting'`
refresh; `onDrain` + `disconnect({ discardPending })`; mismatched-DID repair
guard. `bun:test` coverage in the connection-store specs (supersession,
retention, drain rejection, discard path). Completion: notesd's
provider-side repair latch and drain registry are expressible as store
options; no behavior change for stores that don't opt in. Independent of
PR 2.1; lands before PR 2.3.

**PR 2.3 — `@enbox/react`: bindings package**
Scope: package scaffold (peer deps `react`, `@enbox/browser`); the four
exports; StrictMode-safe view lifecycle. Tests: component-level Vitest
browser tests against a fake `EnboxApp` plus a real `ConnectionStore` over
the agent test harness. Completion: the TODO UI renders through bindings
only; replay/unmount/disconnect cleanup proven in tests.

**PR 2.4 — `@enbox/create-app`: scaffold**
Scope: non-interactive generator emitting exactly the Section 2.6 file set;
CI smoke test that builds and type-checks the generated app. Completion:
`bunx @enbox/create-app x && bun run build` passes in CI.

**PR 2.5 — Docs + example verification**
Scope: rewrite the docs landing quick start and the browser-dapp guide
around `createApp` (keeping the composed store path as the advanced recipe);
Playwright e2e over the scaffolded TODO app implementing the acceptance
matrix below. Completion: matrix green in CI.

### Acceptance matrix

| # | Scenario | Observable acceptance | Verified in |
|---|---|---|---|
| 1 | First visit | Worker controls the page before first render (`navigator.serviceWorker.controller` non-null); connect CTA visible; no session popup | PR 2.5 Playwright e2e |
| 2 | Wallet approval | `phase: 'connected'`; TODO screen usable; grants cover the manifest | e2e with test wallet/relay |
| 3 | Wallet denial | Rests `'disconnected'`; no error banner; a second attempt works | e2e (deny path) |
| 4 | Reload | Session restored with no popup; list renders from local replica before network | e2e |
| 5 | Live create/update/delete | View updates with no polling; a second tab receives the change via the live path | e2e, two browser contexts |
| 6 | Offline after setup | Shell + existing TODOs render; offline create stays visible; reconnect converges and `current` flips true | e2e with network emulation |
| 7 | Grant expiry, failed renewal | `walletReapprovalRequired` surfaces; local data stays readable; UI offers repair | PR 2.2 `bun:test` + e2e short-lived grants |
| 8 | Successful same-identity repair | Facade replaced; views rebind with no data loss and no app code; old facade fenced | PR 2.2/2.3 tests + e2e |
| 9 | Identity switching | After `disconnect({ clearStorage: true })`, identity B never sees A's TODOs; mismatched-DID repair is rejected | e2e + PR 2.2 tests |
| 10 | Unmount / StrictMode replay | No duplicate stores, no leaked views or subscriptions; dispose is terminal | PR 2.3 component tests |
| 11 | Disconnect during pending connect | Connect superseded; store settles `'disconnected'`; no session resurrection | PR 2.2 tests (existing generation gate) |
| 12 | Pagination | 60 seeded TODOs with `limit: 50`: first page ready fast, `hasMore` true, `loadMore` appends the remainder | PR 2.3/2.5 tests |

This stage adds no runtime tests for unimplemented APIs; the matrix is the
verification contract for stages 2.1–2.5.

## 6. Getting started, in five parts

```text
1. Create app        bunx @enbox/create-app my-todos && cd my-todos && bun run dev
2. Define protocol   src/enbox/todo-protocol.ts  → defineProtocol + recordCodecs.json<TodoData>()
3. Connect wallet    src/enbox/app.ts            → createApp({ name, protocols: [TodoProtocol] })
                     src/App.tsx                 → useConnection() → connect()
4. Show TODOs        src/Todos.tsx               → useRecords(TodoProtocol, 'todo', { limit: 50 })
5. Edit TODOs        todos.records.create / patch / delete — the existing typed records API
```

## Consequential choices, summarized

1. **`createApp` lives in `@enbox/browser`**, not `@enbox/api`: the
   composition it adds (worker boot, browser connect handler) is
   browser-specific. CLI/desktop keep composing `ConnectionStore` directly.
2. **React bindings are a separate `@enbox/react` package** with a peer
   dependency on React: `@enbox/browser` stays framework-free, and the
   underlying `EnboxApp` needs no React.
3. **The app object is a module-level singleton** — never component-owned —
   which dissolves the StrictMode disposal problem by construction.
4. **`renewal: 'auto'` is the default** for commit-immediately apps, with
   `renewal: 'manual'` + `onDrain` as the documented path for buffer-holding
   apps (the notesd class). Repair is always an explicit user action;
   revocation is never automatic.
5. **Mutations stay on `records.create/patch/delete`.** No collection
   helpers in this proposal.

Open decisions that materially change implementation scope (raise on the
PR, not in-app): whether `@enbox/react` lives in this monorepo (no package
here depends on React today); whether the scaffold ships as a published
`@enbox/create-app` package or a template repository; and whether
`app.start()` owns worker registration (proposed) or remains app-side
(guide status quo).
