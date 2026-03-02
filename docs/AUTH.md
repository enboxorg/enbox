# Auth Workflows

This document explains how `@enbox/auth` works — its architecture, state machine,
connection flows, and real-world usage patterns. It is aimed at developers building
apps on the Enbox platform.

## Overview

`@enbox/auth` is a headless authentication and identity management SDK. It replaces
the old `Web5.connect()` API with a composable, multi-identity-aware system that
works in both browser and CLI environments.

The package depends only on `@enbox/agent` (not `@enbox/api`). The dependency
direction is:

```
@enbox/auth  -->  @enbox/agent
@enbox/api   -->  @enbox/auth  (optional, via session)
```

Apps use `@enbox/auth` to authenticate, then pass the resulting session to
`@enbox/api` to interact with DWN protocols:

```ts
import { AuthManager } from '@enbox/auth';
import { Enbox } from '@enbox/api';

const auth = await AuthManager.create({ sync: '15s' });
const session = await auth.restoreSession() ?? await auth.connect();

const enbox = Enbox.connect({ session });
// enbox.using(MyProtocol).records.create(...)
```

## Architecture

```
AuthManager (orchestrator)
  |
  |-- VaultManager            wraps HdIdentityVault (PBES2, 210K iterations)
  |-- AuthEventEmitter        typed event bus (9 event types)
  |-- StorageAdapter          session persistence (browser/LevelDB/memory)
  |-- AuthSession             immutable session object (agent + did + delegateDid)
  |
  |-- Connection Flows:       stateless functions, each returns AuthSession
        |-- localConnect()
        |-- walletConnect()
        |-- restoreSession()
        |-- importFromPhrase()
        |-- importFromPortable()
        |
        |-- Supporting:
              |-- registerWithDwnEndpoints()   DWN tenant registration
              |-- applyLocalDwnDiscovery()     local DWN detection (browser)
              |-- processConnectedGrants()     wallet-connect grant processing
```

### Key design decisions

- **Companion to `@enbox/agent`**, not dependent on `@enbox/api`.
- **Headless** — no React, no UI. React helpers will be a separate library.
- **Multi-identity** with switchable active identity.
- **Password is optional** with an insecure default + console warning.
- **StorageAdapter is an interface** with LevelDB as the default for Node/CLI.
- **Connection flows are stateless functions.** `AuthManager` wraps them with
  concurrency guards, state management, and event emission.

---

## State Machine

`AuthManager` tracks a four-state lifecycle:

```
                  create()
                    |
                    v
             +---------------+
             | uninitialized |  no vault exists
             +-------+-------+
                     |
                connect() / importFromPhrase()
                     |
                     v
             +-------+-------+
     +------>|    locked      |  vault exists, password required
     |       +-------+-------+
     |               |
     |     unlock (start agent)
     |               |
     |               v
     |       +-------+-------+
     |  +--->|   unlocked    |  vault open, no active session
     |  |    +-------+-------+
     |  |            |
     |  | disconnect() / switchIdentity()
     |  |            |
     |  |            v
     |  |    +-------+-------+
     |  +----+   connected   |  active session with an identity
     |       +---------------+
     |               |
     |          lock()
     +-----------+
```

Every state transition emits a `state-change` event with `{ previous, current }`.

### States

| State | Meaning |
|---|---|
| `uninitialized` | No vault exists. First-time user. |
| `locked` | Vault exists but is locked. Password required to proceed. |
| `unlocked` | Vault is open, agent is running, but no identity session is active. |
| `connected` | An identity is active. `auth.session` is available. |

### Transitions

| From | To | Trigger |
|---|---|---|
| `uninitialized` | `connected` | `connect()`, `importFromPhrase()` |
| `locked` | `connected` | `connect()`, `restoreSession()`, `importFromPhrase()` |
| `unlocked` | `connected` | `switchIdentity()` |
| `connected` | `unlocked` | `disconnect()` |
| `connected` | `locked` | `lock()` |
| `unlocked` | `locked` | `lock()` |

---

## Connection Flows

### 1. Local Connect

**Method:** `auth.connect(options?)`

Creates or reconnects a local identity. This is the primary flow for apps that
manage their own DID (no external wallet).

```ts
const session = await auth.connect();
```

**First launch (vault does not exist):**

1. Initialize vault with password + generate recovery phrase.
2. Start the agent (unlock vault).
3. Create a new DID:DHT identity with Ed25519 (signing) and X25519 (encryption) keys.
4. Register the DID with DWN endpoints.
5. Register identity for sync and start sync.
6. Persist session markers in storage.
7. Return `AuthSession` with `recoveryPhrase` populated.

**Subsequent launches (vault exists):**

1. Start the agent (unlock vault with password).
2. Find the existing identity.
3. Start sync.
4. Return `AuthSession` (no `recoveryPhrase`).

**Options:**

```ts
interface LocalConnectOptions {
  password?: string;           // overrides the manager default
  recoveryPhrase?: string;     // re-derive identity from BIP-39 phrase
  sync?: SyncOption;           // override sync interval
  dwnEndpoints?: string[];     // override DWN endpoints
  metadata?: { name?: string }; // identity display name
}
```

**Recovery phrase:** Only present on first launch. The app should display it to
the user for backup, then discard it:

```ts
const session = await auth.connect();

if (session.recoveryPhrase) {
  showRecoveryPhraseDialog(session.recoveryPhrase);
}
```

---

### 2. Wallet Connect

**Method:** `auth.walletConnect(options)`

Connects to an external wallet (e.g., a mobile app) via the OIDC/QR relay
protocol. The wallet grants delegated permissions to the app.

```ts
const session = await auth.walletConnect({
  displayName:      'My App',
  connectServerUrl: 'https://enbox-dwn.fly.dev/connect',
  permissionRequests: [
    {
      protocolDefinition: MyProtocol.definition,
      permissionScopes: [
        { protocol: MyProtocol.definition.protocol, interface: 'Records', method: 'Write' },
        { protocol: MyProtocol.definition.protocol, interface: 'Records', method: 'Read' },
        // ...
      ],
    },
  ],
  onWalletUriReady: (uri) => renderQRCode(uri),
  validatePin:      ()    => promptUserForPin(),
});
```

**Flow:**

1. Validate that sync is enabled (wallet connect requires sync).
2. Run the OIDC relay via `WalletConnect.initClient()`:
   - Generate a connect URI and call `onWalletUriReady` (app renders QR code).
   - User scans QR with wallet, approves permissions.
   - Call `validatePin` to collect the PIN from the user.
   - Receive `delegatePortableDid`, `connectedDid`, and `delegateGrants`.
3. Import the delegate DID as a new identity.
4. Process and store the permission grants locally.
5. Register with DWN endpoints (if registration is configured).
6. Register the connected identity for sync with the granted protocols.
7. Pull existing messages from the connected DID's DWN.
8. Start sync.
9. Persist session markers.
10. Return `AuthSession` with `delegateDid` populated.

**Session shape for wallet connect:**

| Property | Value |
|---|---|
| `session.did` | The wallet's DID (the `connectedDid`) |
| `session.delegateDid` | The locally-created delegate DID holding permissions |
| `session.agent` | The local agent |

**Error handling:** If the flow fails after importing the delegate DID, the
imported DID and identity are cleaned up (best effort) before the error is thrown.

**Permission requests:** Each `ConnectPermissionRequest` requires both
`protocolDefinition` and `permissionScopes`. Scopes typically include:

| Interface | Method | Purpose |
|---|---|---|
| `Protocols` | `Query` | Query the protocol configuration |
| `Messages` | `Read` | Enable sync and subscriptions |
| `Records` | `Read` | Read records |
| `Records` | `Write` | Create/update records |
| `Records` | `Delete` | Delete records |
| `Records` | `Query` | Query records |
| `Records` | `Subscribe` | Real-time subscriptions |

---

### 3. Session Restore

**Method:** `auth.restoreSession(options?)`

Restores a previous session from persisted storage. Returns `undefined` if no
previous session exists. This is the recommended way to reconnect on page load.

```ts
const session = await auth.restoreSession();
if (!session) {
  // No previous session — show login UI
}
```

**Algorithm:**

1. Check `previouslyConnected` flag in storage. Return `undefined` if absent.
2. Check if the vault exists (`firstLaunch()`). If the flag is stale (vault was
   wiped), clean up and return `undefined`.
3. Unlock the vault with the password.
4. Run local DWN discovery (browser only).
5. Find the identity to reconnect (priority: connected identity > active identity
   from storage > first identity in list).
6. Start sync.
7. Return `AuthSession`.

**Options:**

```ts
interface RestoreSessionOptions {
  password?: string;  // override the manager default password
}
```

---

### 4. Import from Recovery Phrase

**Method:** `auth.importFromPhrase(options)`

Re-derives an identity from a BIP-39 recovery phrase. Used for account recovery
on a new device.

```ts
const session = await auth.importFromPhrase({
  recoveryPhrase: 'word1 word2 ... word12',
  password: 'user-chosen-password',
});
```

The flow is similar to `connect()` but uses the provided phrase instead of
generating a new one. The vault is re-initialized deterministically from the
mnemonic.

---

### 5. Import from Portable Identity

**Method:** `auth.importFromPortable(options)`

Imports an identity from a `PortableIdentity` JSON object. Used for device
transfer or backup restoration when you have the full key material.

```ts
const session = await auth.importFromPortable({
  portableIdentity: jsonFromBackup,
});
```

---

## Disconnect and Lock

### Disconnect

**Method:** `auth.disconnect(options?)`

Tears down the active session. Two modes:

```ts
// Clean disconnect — keeps vault and identities
await auth.disconnect();

// Nuclear wipe — deletes everything
await auth.disconnect({ clearStorage: true });
```

| Option | Default | Effect |
|---|---|---|
| `clearStorage` | `false` | If `true`, wipes all storage (localStorage, IndexedDB, auth storage) |
| `timeout` | `2000` | Milliseconds to wait for final sync before stopping |

After disconnect, the state transitions to `unlocked`. The vault remains open and
you can call `switchIdentity()` or `connect()` again without re-entering the
password.

### Lock

**Method:** `auth.lock()`

Disconnects the session AND locks the vault:

```ts
await auth.lock();
// state is now 'locked' — password required to proceed
```

This calls `disconnect()` internally, stops sync, and then locks the vault
(clearing the content encryption key from memory). State transitions to `locked`.

---

## Multi-Identity

`@enbox/auth` supports multiple identities in a single vault.

### List identities

```ts
const identities = await auth.listIdentities();
// [{ didUri: 'did:dht:abc...', name: 'Default', connectedDid?: '...' }]
```

### Switch active identity

```ts
const session = await auth.switchIdentity('did:dht:xyz...');
```

This disconnects the current session (if any), switches to the target identity,
restarts sync, and returns a new `AuthSession`.

### Delete an identity

```ts
await auth.deleteIdentity('did:dht:xyz...');
```

Deletes the DID, keys, and identity record. If it's the active identity, the
session is disconnected first.

### Export an identity

```ts
const portable = await auth.exportIdentity('did:dht:xyz...');
// portable is a PortableIdentity JSON object with private keys
```

---

## DWN Registration

When `registration` is provided in `AuthManagerOptions`, the auth flows
automatically register newly created DIDs with DWN endpoints.

Two registration paths are supported:

### 1. Proof of Work (default)

No configuration required. The agent solves a PoW challenge from the DWN server:

```ts
const auth = await AuthManager.create({
  registration: {
    onSuccess: () => console.log('Registered'),
    onFailure: (err) => console.error('Registration failed', err),
  },
});
```

### 2. Provider Auth (OAuth)

For DWN servers that require `provider-auth-v0`:

```ts
const auth = await AuthManager.create({
  registration: {
    onSuccess: () => {},
    onFailure: (err) => console.error(err),
    onProviderAuthRequired: async (params) => {
      // params.authorizeUrl — open this URL for the user
      // params.state — CSRF nonce to validate
      const { code, state } = await doOAuthFlow(params.authorizeUrl);
      return { code, state };
    },
    registrationTokens: loadTokensFromDisk(),           // cached tokens
    onRegistrationTokens: (tokens) => saveTokens(tokens), // persist new tokens
  },
});
```

The auth library handles token refresh automatically when tokens have a
`refreshToken` and `refreshUrl`.

---

## Local DWN Discovery

In browser environments, `@enbox/auth` can discover a locally-running DWN server
(e.g., from `electrobun-dwn`). Three discovery channels, highest to lowest
priority:

1. **URL fragment payload** — A `dwn://register` redirect landed on the page with
   the endpoint encoded in `#`.
2. **Persisted endpoint** — A previously discovered endpoint stored in auth
   storage, re-validated via `GET /info`.
3. **Agent-level discovery** — Transparent to `@enbox/auth`:
   - File-based: reads `~/.enbox/dwn.json` (Node/Bun only).
   - Port probing: tries `127.0.0.1:{3000, 55500-55509}`.

Discovery runs automatically during `connect()` and `restoreSession()`. You can
also trigger it manually:

```ts
import { requestLocalDwnDiscovery, probeLocalDwn } from '@enbox/auth';

// Trigger the dwn://register flow (opens the register URL)
requestLocalDwnDiscovery();

// Direct probe for a local DWN server
const endpoint = await probeLocalDwn();
if (endpoint) {
  console.log('Found local DWN at', endpoint);
}
```

---

## Events

Subscribe to lifecycle events via `auth.on()`:

```ts
const unsubscribe = auth.on('state-change', ({ previous, current }) => {
  console.log(`Auth state: ${previous} -> ${current}`);
});

// Later:
unsubscribe();
```

### Event Reference

| Event | Payload | When |
|---|---|---|
| `state-change` | `{ previous: AuthState, current: AuthState }` | Any state transition |
| `session-start` | `{ session: AuthSessionInfo }` | A session becomes active |
| `session-end` | `{ did: string }` | A session is disconnected |
| `identity-added` | `{ identity: IdentityInfo }` | An identity is created or imported |
| `identity-removed` | `{ didUri: string }` | An identity is deleted |
| `vault-locked` | `{}` | The vault is locked |
| `vault-unlocked` | `{}` | The vault is unlocked |
| `local-dwn-available` | `{ endpoint: string }` | A local DWN server was discovered |
| `local-dwn-unavailable` | `{}` | No local DWN server found |

---

## Sync

Sync behavior is controlled by the `sync` option:

| Value | Mode | Description |
|---|---|---|
| `undefined` (omitted) | Live | WebSocket sync with 5-minute fallback interval |
| `'15s'`, `'2m'`, `'1h'` | Poll | Periodic sync at the specified interval |
| `'off'` | Disabled | No sync. Wallet connect will throw. |

Sync is configured at `AuthManager.create()` time and can be overridden per-flow:

```ts
const auth = await AuthManager.create({ sync: '15s' }); // default for all flows

const session = await auth.connect({ sync: '5s' });      // override for this connect
```

---

## Vault Management

The vault stores the agent's DID and content encryption key, protected by the
user's password (PBES2-HS512+A256KW, 210K iterations).

Access the vault via `auth.vault`:

```ts
// Lock
await auth.vault.lock();

// Unlock
await auth.vault.unlock(password);

// Change password
await auth.vault.changePassword(oldPassword, newPassword);

// Backup / restore
const backup = await auth.vault.backup();
await auth.vault.restore(backup, password);

// Check status
auth.vault.isLocked;                 // boolean (synchronous)
await auth.vault.isInitialized();    // boolean
```

Note: prefer `auth.lock()` over `auth.vault.lock()` — the top-level method also
disconnects the session and stops sync.

---

## Storage Adapters

The `StorageAdapter` interface persists session markers (previously connected flag,
active identity DID, delegate DID, local DWN endpoint):

```ts
interface StorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}
```

### Built-in adapters

| Adapter | Backing store | Environment |
|---|---|---|
| `BrowserStorage` | `localStorage` | Browser |
| `LevelStorage` | LevelDB (Node) / IndexedDB (browser) | Any |
| `MemoryStorage` | In-memory `Map` | Testing |

Auto-detection: if no `storage` option is passed to `AuthManager.create()`,
`createDefaultStorage()` returns `BrowserStorage` if `localStorage` is available,
otherwise `LevelStorage`.

```ts
import { LevelStorage } from '@enbox/auth';

const auth = await AuthManager.create({
  storage: new LevelStorage('/path/to/AUTH_STORE'),
});
```

---

## AuthSession

The session object returned by all connection flows contains the authenticated
`agent`, the connected `did`, and optionally a `delegateDid` (for wallet-connected
sessions) or a `recoveryPhrase` (on first local connect only).

Pass the session to `@enbox/api`:

```ts
const enbox = Enbox.connect({ session });

// Or manually:
const enbox = Enbox.connect({
  agent:        session.agent,
  connectedDid: session.did,
  delegateDid:  session.delegateDid,
});
```

---

## Usage Patterns

### Browser — React SPA

The typical pattern wraps `AuthManager` in a React context provider:

```tsx
import { AuthManager, type AuthSession, type WalletConnectOptions } from '@enbox/auth';
import { Enbox } from '@enbox/api';

const EnboxProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const authRef = useRef<AuthManager>();
  const [enbox, setEnbox] = useState<Enbox>();
  const [did, setDid] = useState<string>();

  // 1. Create AuthManager once
  useEffect(() => {
    AuthManager.create({ sync: '15s' }).then((auth) => {
      authRef.current = auth;

      // 2. Auto-restore on mount
      auth.restoreSession().then((session) => {
        if (session) applySession(session);
      });
    });
  }, []);

  const applySession = (session: AuthSession) => {
    const api = Enbox.connect({ session });
    setEnbox(api);
    setDid(session.did);
  };

  // 3. Local connect (new identity)
  const connect = async () => {
    const auth = authRef.current!;
    const session = await auth.connect();
    applySession(session);
  };

  // 4. Wallet connect
  const walletConnect = async (options: Omit<WalletConnectOptions, 'sync'>) => {
    const auth = authRef.current!;
    const session = await auth.walletConnect(options as WalletConnectOptions);
    applySession(session);
  };

  // 5. Disconnect
  const disconnect = async (clearStorage?: boolean) => {
    await authRef.current?.disconnect({ clearStorage });
    setEnbox(undefined);
    setDid(undefined);
  };

  return (
    <EnboxContext.Provider value={{ enbox, did, connect, walletConnect, disconnect }}>
      {children}
    </EnboxContext.Provider>
  );
};
```

### CLI / Node.js

CLI apps typically pass a pre-built agent and explicit storage:

```ts
import { AuthManager, LevelStorage } from '@enbox/auth';
import { EnboxUserAgent } from '@enbox/agent';
import { Enbox } from '@enbox/api';

// 1. Create a custom agent (e.g., with SQLite-backed DWN)
const agent = await EnboxUserAgent.create({ dataPath, dwnApi });

// 2. Create AuthManager with the custom agent
const auth = await AuthManager.create({
  agent,
  password: userPassword,
  storage: new LevelStorage(join(dataPath, 'AUTH_STORE')),
  sync: '30s',
  dwnEndpoints: ['https://enbox-dwn.fly.dev'],
  registration: {
    onSuccess: () => {},
    onFailure: (err) => console.error(err),
  },
});

// 3. Connect (creates identity on first run, reconnects on subsequent runs)
const session = await auth.connect({ password: userPassword });

if (session.recoveryPhrase) {
  console.log('Save your recovery phrase:', session.recoveryPhrase);
}

// 4. Use the Enbox API
const enbox = Enbox.connect({ session });
const typed = enbox.using(MyProtocol);
```

---

## API Reference

For the full `AuthManager` API (methods, properties, options, types), see the
[API reference documentation](https://enbox-docs.pages.dev/docs/api).
