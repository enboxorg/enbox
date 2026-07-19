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

`@enbox/auth` depends on the agent, not on the API package. A session returned
by `AuthManager` can be passed into the API layer:

```ts
import { Enbox } from '@enbox/api';
import { AuthManager } from '@enbox/auth';

const auth = await AuthManager.create({ sync: '15s' });
const session = await auth.restoreSession() ?? await auth.connectVault({ createIdentity: true });

const enbox = Enbox.fromSession(session);
```

For the default app flow, prefer `Enbox.connect()`:

```ts
import { Enbox } from '@enbox/api';

const { auth, enbox, session } = await Enbox.connect({
  password      : userPassword,
  createIdentity: true,
  sync          : '15s',
});
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

`connect()` is the routing entry point used by dapps and by `Enbox.connect()`.
It first tries to restore a previous session unless the caller provides a
recovery phrase. If restore does not produce a session, it chooses a flow from
the supplied options:

- `recoveryPhrase`: restore or re-unlock from a BIP-39 phrase.
- `protocols` or `connectHandler`: use a handler-based connect flow.
- `password`, `createIdentity`, or local vault options: use the vault flow.

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
vault is not overwritten.

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

## Registration

When `dwnEndpoints` and `registration` options are provided, auth registers the
agent DID and active identity DID with the configured DWN endpoints. Servers may
support provider auth (`provider-auth-v0`) or proof-of-work registration.

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

Call `disconnect()` to end the active identity session while keeping the vault
unlocked. Call `lock()` when the vault should be closed. Call `shutdown()` when
disposing a manager permanently; a shut-down manager cannot be reused.
