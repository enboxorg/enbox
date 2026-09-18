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
import {
  BrowserConnectHandler,
  createConnectionStore,
  defineApplicationManifest,
} from '@enbox/browser';

const application = defineApplicationManifest({
  protocols: [NotesProtocol],
} as const);
const store = createConnectionStore({
  application,
  connectHandler: BrowserConnectHandler({ appName: 'Notes' }),
  monitor: { autoRefresh: {} },
});

await store.initialize();

// Invoke directly from a click or other user action so the wallet popup opens.
async function connect(): Promise<void> {
  const snapshot = await store.connect();
  if (snapshot.phase !== 'connected') {
    throw snapshot.error ?? new Error('Connection was not established.');
  }
  const enbox = snapshot.enbox;
  // ...use enbox...
}
```

Create one store for the application lifetime. It owns session restoration,
protocol readiness, grant refresh, facade replacement, and teardown. Call
`disconnect()` on sign-out and `dispose()` when the store is permanently
released.

## Browser runtime

Every browser dapp must register an application-owned service worker that calls
`activatePolyfills()`. The page owns the connection store, record views, and
WebSockets; the worker owns DRL fetch interception and the offline shell. Keep
the default Level/IndexedDB storage stack.

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
