# Auth Workflows

`@enbox/auth` is the headless authentication layer for Enbox apps. It owns
vault lifecycle, identity selection, session persistence, DWN registration, and
sync startup. Most applications should use `@enbox/api` as the high-level entry
point and only drop down to `@enbox/auth` when they need direct control over
the auth lifecycle.

## Package Relationship

```text
@enbox/api
  -> @enbox/auth
    -> @enbox/agent
```

`@enbox/auth` depends on the agent, not on the API package. Most applications
should let a connection store compose auth and the API facade:

```ts
import { createConnectionStore } from '@enbox/api';

const store = createConnectionStore({ password: userPassword });
let snapshot = await store.initialize();
if (snapshot.phase === 'disconnected') {
  snapshot = await store.connectVault({ createIdentity: true });
}
if (snapshot.phase !== 'connected') {
  throw snapshot.error ?? new Error('Connection was not established.');
}

const enbox = snapshot.enbox!;
```

Call `store.disconnect()` to sign out and `store.dispose()` once at application
shutdown. The store closes session-bound `Enbox` facades automatically.

Create one store for each application/data-path pairing and retain it for the
application lifetime. Separate stores intentionally do not coordinate session
lifecycle or snapshots, even when they share a `dataPath`.

```ts
await store.disconnect();
await store.dispose();
```

Advanced integrations that own the auth lifecycle directly can pass an
`AuthManager` session into the API layer. They must close the facade separately
before ending the session:

```ts
import { Enbox } from '@enbox/api';
import { AuthManager } from '@enbox/auth';

const auth = await AuthManager.create({ password: userPassword });
const session = await auth.restoreSession()
  ?? await auth.connectVault({ createIdentity: true });
const directEnbox = Enbox.fromSession(session);

// ...use directEnbox...

directEnbox.close();
await auth.disconnect();
await auth.shutdown();
```

## State Model

`AuthManager.state` has four values:

| State | Meaning |
|---|---|
| `uninitialized` | No local vault exists. |
| `locked` | A vault exists but is locked. |
| `unlocked` | The vault is open, but no identity session is active. |
| `connected` | An identity session is active. |

Common transitions:

| Operation | Typical transition |
|---|---|
| `connectVault({ createIdentity: true })` | `uninitialized` -> `connected` |
| `restoreSession()` | `locked` or `unlocked` -> `connected` |
| `disconnect()` | `connected` -> `unlocked` |
| `lock()` | `connected` or `unlocked` -> `locked` |

Every state change emits a `state-change` event. Session start/end, identity
changes, vault lock/unlock, and local DWN discovery also emit typed events.

## Connection Paths

### `connect()`

`connect()` is the `AuthManager` routing entry point used directly by advanced
integrations and internally by connection stores. It first tries to restore a
previous session. If restore does not produce a session, it chooses a flow from
the supplied options:

- `protocols` or `connectHandler`: use a handler-based connect flow.
- `password`, `createIdentity`, or local vault options: use the vault flow.

Use `restoreFromPhrase()` for explicit BIP-39 recovery.

```ts
const auth = await AuthManager.create({
  connectHandler: BrowserConnectHandler(),
});

const session = await auth.connect({
  protocols: [NotesProtocol],
});
```

### `connectVault()`

Use `connectVault()` for wallets, CLIs, and apps that directly own the local HD
vault. On first launch it initializes the vault, creates an identity when
requested, registers DWN endpoints, starts sync, and returns the recovery
phrase once. On later launches it unlocks the vault and resumes the active
identity.

```ts
const session = await auth.connectVault({
  password      : userPassword,
  createIdentity: true,
});

if (session.recoveryPhrase !== undefined) {
  showRecoveryPhrase(session.recoveryPhrase);
}
```

### `restoreFromPhrase()`

Use this path when a user explicitly restores from their recovery phrase. A
fresh device initializes from the phrase and recovers remote identities. An
existing matching vault can reset the local password. A different existing
vault is not overwritten. Restore freshly resolves the vault DID and every
identity routing DID, then uses each DID's advertised `#dwn` endpoints rather
than application defaults. Passing `dwnEndpoints` is a deliberate endpoint
migration performed after recovery.

```ts
const session = await auth.restoreFromPhrase({
  recoveryPhrase,
  password: newPassword,
});
```

### `walletConnect()`

`walletConnect()` connects to an external wallet through the Enbox Connect
relay. It generates a URI for display, validates the PIN, imports the delegated
DID, and processes permission grants.

```ts
const session = await auth.walletConnect({
  displayName     : 'Notes',
  connectServerUrl: 'https://enbox-dwn.fly.dev/connect',
  permissionRequests: [
    { protocolDefinition: NotesProtocol.definition },
  ],
  onWalletUriReady: renderQrCode,
  validatePin     : promptForPin,
});
```

Wallet connect requires sync. If sync is disabled, the flow fails before
starting.

### `restoreSession()`

`restoreSession()` reconnects from persisted session markers and returns
`undefined` when there is nothing to restore.

```ts
const session = await auth.restoreSession();
if (session === undefined) {
  await auth.connectVault({ createIdentity: true });
}
```

## Sync Scoping

Auth does not silently request a full-DWN replica. Product apps should pass the
protocols they own:

```ts
const auth = await AuthManager.create({
  identitySyncProtocols: [NotesProtocol.definition.protocol],
});
```

Use `identitySyncProtocols: 'all'` only for wallet-style products that
intentionally sync every protocol for an identity.

`sync` controls scheduling:

| Value | Behavior |
|---|---|
| omitted | Live WebSocket sync where available. |
| `'15s'`, `'2m'`, `'1h'` | Live sync with the periodic settle check at the requested interval. |
| `'off'` | Disable sync. |

Phrase restore still performs its required one-shot recovery pulls when
`sync: 'off'`; the option disables ongoing synchronization afterward.

## Registration

For new DID creation, auth registers against the caller-selected or configured
default endpoints. During recovery, each vault or identity routing DID is
registered against its own advertised endpoints. Servers may support provider
auth (`provider-auth-v0`) or proof-of-work registration.

```ts
const auth = await AuthManager.create({
  dwnEndpoints: ['https://enbox-dwn.fly.dev'],
  registration: {
    onSuccess: () => {},
    onFailure: (error) => reportRegistrationError(error),
    persistTokens: true,
  },
});
```

Use `persistTokens: true` for normal apps so registration tokens survive across
sessions without custom token storage.

## Storage and Lifecycle

`AuthManager.create()` uses a default storage adapter for the current runtime
unless one is supplied. Browser apps normally use the browser-backed default;
tests and CLIs can pass memory or LevelDB-backed storage.

When managing auth directly, close every `Enbox.fromSession()` facade before
calling `disconnect()` to end the active identity session while keeping the
vault unlocked. Call `lock()` when the vault should be closed. Call `shutdown()`
when disposing a manager permanently; a shut-down manager cannot be reused.
