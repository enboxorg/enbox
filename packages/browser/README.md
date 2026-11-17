# Enbox Browser

> **Research Preview** — Enbox is under active development. APIs may change without notice.

| Browser entrypoint for Enbox application APIs, auth, wallet connect, and DWeb features |
| ------------------------------------------------------------------------------------- |

[![NPM Package][browser-npm-badge]][browser-npm-link]
[![NPM Downloads][browser-downloads-badge]][browser-npm-link]
[![Build Status][browser-build-badge]][browser-build-link]
[![Open Issues][browser-issues-badge]][browser-issues-link]
[![Code Coverage][browser-coverage-badge]][browser-coverage-link]

## Install

```bash
bun add @enbox/browser
```

## Usage

Use the [browser dapp guide][browser-dapp-guide-link] for the worker and
page build configuration. The following example assumes the worker is bundled
as an ES module at `/sw.js` and the app is served at the origin root.

```ts
// src/sw.ts — the app's service-worker entry point
import { activatePolyfills } from '@enbox/browser';

activatePolyfills();
```

```ts
// src/main.ts — the page entry point
import { createApplication, prepareBrowser } from '@enbox/browser';
import { NotesStore } from './features/notes/store.js';

await prepareBrowser('/sw.js', { registrationOptions: { type: 'module' } });

const application = createApplication({
  stores: { notes: NotesStore },
  wallet: { appName: 'Notes' },
  connection: { monitor: { autoRefresh: {} } },
});

// Both first approval and restoration publish a connected snapshot.
// Subscribe before initialization so the UI sees either transition.
application.connection.subscribe(snapshot => {
  if (snapshot.phase === 'connected') {
    // Mount or update the Notes view with application.store(NotesStore).
  }
});
await application.initialize();

// Bind this action to the Connect button so the wallet popup keeps its user gesture.
function connect() {
  return application.connection.connect();
}
```

Keep one application for the browser lifetime. It derives the manifest from
feature modules and owns the connection, session-scoped resources, commands,
and cleanup. `application.connection.disconnect()` signs out;
`application.dispose()` permanently tears down the owner. React binds the same
runtime through `EnboxProvider application={application}`. Mount the connected
view on both first approval and restore. Subscribe to the active feature's
records so the first local result and subsequent sync updates render in place.

For a custom host, supply `connectHandler` instead of `wallet`, or supply a
`connection: manifest => nativeConnection` factory that owns all native
configuration. The headless `@enbox/api` constructor requires that factory;
the browser constructor supplies browser defaults around the same runtime.
Native connection, record, and context primitives remain available for custom
flows. `defineStore`'s `observe()` factory owns all native view types through
one subscription and cleanup mechanism.

## Wallet sign-in without a data session

Call `authenticateViaPopup()` directly from a user action to request an owner
authentication proof. Supply the wallet URL and a service-issued
`authentication: { version: 1, audience, challenge }` request. The result is
`{ connectedDid, authentication }`, or `undefined` when denied; no DWN delegate
session is created. The service verifies the returned proof against its exact
pending request and consumes the challenge once before establishing login.
Supply `onAuthenticationRequest` to register that exact generated request with
the service before wallet delivery; the callback must resolve successfully
before approval can proceed. A registration failure closes the popup.

Service-side verification requires an independent `expected: { audience,
challenge }` from configuration and its issued transaction, together with the
stored full request. Unknown or already-used challenges must be rejected.
Owner authentication requires an HTTPS origin, including local development.
Proofs expire 300 seconds after signing; the response envelope's separate
600-second lifetime does not extend that deadline. An expired proof fails
login even if the wallet already approved grants in combined mode.

`connectViaPopup()` also accepts `authentication` to combine sign-in with its
explicit DWN permission request. The existing application/connection-store
APIs continue to manage data sessions. The Connect proof is an Enbox wallet
primitive; OAuth/OIDC token issuance belongs to the receiving service.

Authentication capability discovery/negotiation is not implemented. Use
combined mode only with known-capable wallets: older wallets can grant the
requested data access and then return no owner proof, which fails login.
Likewise, a final signing failure can leave previously written grants in
place. Callers must reconcile or revoke that partial outcome before retrying;
a rejected combined operation is not evidence of a DWN rollback.

## Browser runtime

Every browser dapp must register an application-owned service worker that calls
`activatePolyfills()`. The page owns the connection store, record views, and
WebSockets; the worker owns DRL fetch interception and the offline shell. Keep
the default Level/IndexedDB storage stack.

Before initializing the connection store, await `prepareBrowser(workerUrl,
{ registrationOptions: { type: 'module' } })` for a module worker, or pass an
existing registration from this page's `navigator.serviceWorker` when a PWA
tool owns registration. The helper waits for that worker to control the page
and activates page polyfills, with a timeout and abort signal. The application
owns update activation. Worker-side `activatePolyfills()` claims clients during
activation, but leaves waiting workers in place. Complete pending application
work before your update handler requests `skipWaiting()` and reloads the page.

Current browser-conditioned packages work in page and worker builds without
Enbox-specific Node-global, `process`, or IIFE shims. Follow the
[browser dapp guide][browser-dapp-guide-link] for the canonical Vite, worker,
startup, live-data, hosting, and verification setup. The rationale lives in
[Browser dapp architecture][browser-dapps-link].

## Project resources

| Resource | Description |
|---|---|
| [AGENTS.md][agents-link] | Contributor workflow and repository rules |
| [License][license-link] | Apache License, Version 2.0 |

[browser-npm-badge]: https://img.shields.io/npm/v/@enbox/browser.svg?style=flat&color=blue&santize=true
[browser-npm-link]: https://www.npmjs.com/package/@enbox/browser
[browser-downloads-badge]: https://img.shields.io/npm/dt/@enbox/browser?&color=blue
[browser-build-badge]: https://img.shields.io/github/actions/workflow/status/enboxorg/enbox/ci.yml?branch=main&label=ci
[browser-build-link]: https://github.com/enboxorg/enbox/actions/workflows/ci.yml
[browser-coverage-badge]: https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/browser.json
[browser-coverage-link]: https://github.com/enboxorg/enbox/actions/workflows/ci.yml
[browser-issues-badge]: https://img.shields.io/github/issues/enboxorg/enbox/package:%20browser?label=issues
[browser-issues-link]: https://github.com/enboxorg/enbox/issues?q=is%3Aopen+is%3Aissue+label%3A"package%3A+browser"
[browser-dapps-link]: https://github.com/enboxorg/enbox/blob/main/docs/architecture/browser-dapps.md
[browser-dapp-guide-link]: https://enbox-docs.pages.dev/docs/guides/browser-dapp
[agents-link]: https://github.com/enboxorg/enbox/blob/main/AGENTS.md
[license-link]: https://github.com/enboxorg/enbox/blob/main/LICENSE
