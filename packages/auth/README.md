# Enbox Auth

> **Research Preview** - Enbox is under active development. APIs may change without notice.

Headless authentication and session management for Enbox agents. The package
owns vault connection, identity restore/import, wallet connect flows, session
state, and registration token persistence.

## Installation

```bash
bun add @enbox/auth
```

## Usage

```ts
import { AuthManager } from '@enbox/auth';

const auth = await AuthManager.create();
const session = await auth.connectVault({
  createIdentity : true,
  password       : userPassword,
});
```

Browser apps usually import these APIs from `@enbox/browser`, which also
provides `BrowserConnectHandler` and a browser-conditioned bundle:

```ts
import { AuthManager, BrowserConnectHandler } from '@enbox/browser';
```

`@enbox/auth/browser` is a browser-safe subpath for packages that need auth
directly. It exports the browser auth surface plus `PasswordProvider.fromCallback()`
and `PasswordProvider.chain()`.

## Delegated Protocol Requests

Handler-based connect accepts raw protocol definitions and structural
definition carriers such as `TypedProtocol`. A carrier's application-only
fields are not sent to the wallet:

```ts
await auth.connect({
  connectHandler,
  protocols: [
    NotesProtocol, // default: read, write, delete
    { protocol: PhotosProtocol, permissions: ['read'] },
  ],
});
```

The explicit `{ definition: RawDefinition, permissions }` form remains
available. A non-empty `protocols` array intentionally selects delegated
handler routing; owner applications should continue to use `connectVault()`.

## Identity-only wallet authentication

`WalletConnect.initAuthentication()` performs a relay-mediated owner login and
returns `{ connectedDid, authentication }`, or `undefined` when denied. Its
options contain a service-issued `authentication` request (`version`, HTTPS
`audience`, and unpredictable `challenge`) and the usual relay, wallet URI and
PIN callbacks. It returns no delegate keys or `AgentSession` and requests no
DWN permissions. Authentication-enabled wallets must trust the request origin;
an arbitrary public relay does not establish that trust.

For combined approval, `WalletConnect.initClient()` accepts the same optional
`authentication` request and returns verified authentication alongside the
delegated credentials. A wallet response that omits the requested proof is
rejected. The service remains responsible for consuming the challenge once;
cryptographic verification alone does not create an account or OAuth session.
Use `onAuthenticationRequest` to durably register the exact generated request
with the service before it reaches the wallet. The callback is awaited, and
failure prevents delivery. The service binds it to its own challenge and OAuth
transaction, then verifies the response against that stored request; it must
not trust browser-reported verification results.

Authentication-bearing inputs must be cloneable plain JSON data; unwrap
reactive proxies before using these new APIs. Ordinary delegation continues
to accept JSON-serializable reactive inputs and snapshots their wire value.

Server verification additionally requires `expected: { audience, challenge }`
from service configuration and the issued transaction. A replay store must
reject challenges the service never issued, not merely duplicates. The proof
expires 300 seconds after signing even though its encrypted response envelope
lasts 600 seconds after sealing; delayed relay PIN entry can therefore fail
authentication after approval. Reconcile existing grants before retrying a
combined operation. Owner authentication requires HTTPS during local
development too; an HTTP delegation origin does not enable HTTP sign-in.

These adapters do not discover or negotiate wallet authentication capability.
An older wallet rejects identity-only requests, but a combined request can
produce its requested DWN grants before the missing proof causes login to
fail. Use combined mode only with a wallet known to support authentication.
Any combined failure needs outcome reconciliation: grants written before a
late signing failure are not automatically rolled back, and a failed login
must not be retried as a blind new grant-creation transaction.

## Storage

`BrowserStorage`, `MemoryStorage`, `LevelStorage`, and `createDefaultStorage()`
are exported for session persistence. `LevelStorage` uses `level`, which maps to
`classic-level` in Node and `browser-level` over IndexedDB in browsers.

IndexedDB-backed Level storage is the durable browser storage path used by the
agent runtime because it supports concurrent access from tabs, workers, and
service workers on the same origin. Do not replace it with in-memory storage for
production browser sessions.

## Password Providers

`PasswordProvider.fromEnv()`, `PasswordProvider.fromTty()`, and
`PasswordProvider.fromDevTty()` are Node/CLI helpers exported by the Node root
entry. Browser apps should pass a password directly, import
`PasswordProvider.fromCallback()` from `@enbox/auth/browser`, or collect
credentials through their own UI.

`PasswordProvider.chain()` only tries the next provider when the current one
throws `PasswordProviderUnavailableError` (exported by both auth entrypoints).
Custom providers should use that error when a capability is absent.
Cancellation, invalid credentials, and unexpected failures should throw their
original error so authorization stops instead of silently switching methods.

## License

Apache-2.0
