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

`@enbox/browser` re-exports the high-level API, browser-safe auth surface,
wallet connect handler, and DWeb helpers:

```ts
import { createApplication } from '@enbox/browser';
import { NotesStore } from './features/notes/store.js';

const application = createApplication({
  stores: { notes: NotesStore },
  wallet: { appName: 'Notes' },
  connection: { monitor: { autoRefresh: {} } },
});

await application.initialize();

// Invoke directly from a user action so the wallet popup opens.
async function connect(): Promise<void> {
  const snapshot = await application.connection.connect();
  if (snapshot.phase !== 'connected') {
    throw snapshot.error ?? new Error('Connection was not established.');
  }
  const notes = application.store(NotesStore);
  // Subscribe to notes' resources or run its domain commands.
}
```

Keep one application for the browser lifetime. It derives the manifest from
feature protocols and owns the connection, session-scoped resources, commands,
and cleanup. `application.connection.disconnect()` signs out;
`application.dispose()` permanently tears down the owner. React binds the same
runtime through `EnboxProvider application={application}`.

For a custom host, supply `connectHandler` instead of `wallet`, or supply a
`connection: manifest => nativeConnection` factory that owns all native
configuration. The headless `@enbox/api` constructor requires that factory;
the browser constructor supplies browser defaults around the same runtime.
Native connection, record, and context primitives remain available for custom
flows. `defineStore`'s `observe()` factory owns all native view types through
one subscription and cleanup mechanism.

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
