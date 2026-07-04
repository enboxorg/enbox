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

## License

Apache-2.0
