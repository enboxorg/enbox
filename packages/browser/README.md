# Enbox Browser

> **Research Preview** — Enbox is under active development. APIs may change without notice.

| Browser-specific tools and features for building decentralized web applications |
| ------------------------------------------------------------------------------ |

[![NPM Package][browser-npm-badge]][browser-npm-link]
[![NPM Downloads][browser-downloads-badge]][browser-npm-link]

[![Build Status][browser-build-badge]][browser-build-link]
[![Open Issues][browser-issues-badge]][browser-issues-link]
[![Code Coverage][browser-coverage-badge]][browser-coverage-link]

---

- [Enbox Browser](#enbox-browser)
  - [Install](#install)
  - [Usage](#usage)
  - [Bundlers and Service Workers](#bundlers-and-service-workers)
  - [Storage Model](#storage-model)
  - [Activate Polyfills](#activate-polyfills)
  - [Project Resources](#project-resources)

---

<a id="introduction"></a>

This package contains browser-specific helpers for building DWAs (Decentralized Web Apps) with the Enbox toolkit.

## Install

```bash
bun add @enbox/browser
```

## Usage

Use the bare package entrypoint in browser apps. It re-exports the high-level
API from `@enbox/api`, auth/session helpers from `@enbox/auth`, and
browser-specific connect utilities.

```ts
import { BrowserConnectHandler, Enbox, defineProtocol, recordCodecs } from '@enbox/browser';

const { enbox } = await Enbox.connect({
  connectHandler : BrowserConnectHandler({ appName: 'Notes' }),
  createIdentity : true,
  protocols      : [NotesProtocol],
});
```

## Bundlers and Service Workers

`@enbox/browser` declares a browser-conditioned root export that resolves to the
prebuilt `dist/browser.mjs` bundle. Browser-aware bundlers, including secondary
Vite passes used for service workers, can import `@enbox/browser` without
adding Node global shims for `process`, `process.env`, `process.browser`,
`process.emitWarning`, `global`, or the Node `events` builtin.

`activatePolyfills()` is unrelated to Node-global shims. It installs browser
DWeb/DRL behavior such as service-worker handling for `dweb` URLs; it is not a
compatibility shim for the SDK package graph.

## Storage Model

The default browser agent storage remains Level-backed. The `level` package
resolves to `browser-level`, which stores data in IndexedDB so tabs, workers,
and service workers on the same origin can safely write concurrently. SQLite
over OPFS is not a drop-in browser replacement for this usage because it does
not provide the same cross-context write behavior.

### Activate Polyfills (required for any app that renders DWN-addressed content)

`activatePolyfills()` installs the **DWeb network stack**: a service worker
fetch handler that resolves DRLs — DWN-addressed URLs such as
`http://dweb/did:dht:abc123/protocols/read/aHR0cHM6Ly9hcmV3ZXdlYjV5ZXQuY29tL3NjaGVtYXMvcHJvdG9jb2xz/avatar`
— by resolving the DID to its DWN endpoints and returning the record as an
ordinary `Response` (with an optional TTL cache via `onCacheCheck`). This is
what lets a plain `<img src>` or `fetch()` address a record on any DWN.

Despite the name, this is not an optional compatibility shim. **Without it,
every DRL in your app fails as an ordinary network error** — no exception at
the SDK boundary, nothing in the console pointing at a missing subsystem, and
everything else (connect, records, sync) keeps working. Treat it like the
bundler configuration above: required scaffolding for a browser dapp.

Two ways to wire it:

- **Zero-config:** import and run `activatePolyfills()` at your page
  entrypoint; in a page context it registers itself as a root service worker
  (pass `path` explicitly under a strict CSP).
- **Own service worker (recommended for production):** call
  `activatePolyfills()` inside your `sw.ts` and let your build tool (e.g.
  `vite-plugin-pwa` with `injectManifest`) register it alongside precaching.

Verify it behaviorally, not just at build time: the worker must be registered,
reach `activated`, and control the page (`navigator.serviceWorker.controller`
non-null after a reload). A served-but-never-evaluated worker passes every
build. Full wiring guidance, build traps, and hosting-header pitfalls:
[`docs/architecture/browser-dapps.md`][browser-dapps-link].

## Project Resources

| Resource                                | Description                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| [AGENTS.md][agents-link] | Contributor workflow, style, testing, and release rules |
| [LICENSE][license-link]  | Apache License, Version 2.0                             |

[browser-npm-badge]: https://img.shields.io/npm/v/@enbox/browser.svg?style=flat&color=blue&santize=true
[browser-npm-link]: https://www.npmjs.com/package/@enbox/browser
[browser-downloads-badge]: https://img.shields.io/npm/dt/@enbox/browser?&color=blue
[browser-build-badge]: https://img.shields.io/github/actions/workflow/status/enboxorg/enbox/ci.yml?branch=main&label=ci
[browser-build-link]: https://github.com/enboxorg/enbox/actions/workflows/ci.yml
[browser-coverage-badge]: https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/browser.json
[browser-coverage-link]: https://github.com/enboxorg/enbox/actions/workflows/ci.yml
[browser-issues-badge]: https://img.shields.io/github/issues/enboxorg/enbox/package:%20browser?label=issues
[browser-issues-link]: https://github.com/enboxorg/enbox/issues?q=is%3Aopen+is%3Aissue+label%3A"package%3A+browser"
[browser-repo-link]: https://github.com/enboxorg/enbox/tree/main/packages/browser
[browser-jsdelivr-link]: https://www.jsdelivr.com/package/npm/@enbox/browser
[browser-jsdelivr-browser]: https://cdn.jsdelivr.net/npm/@enbox/browser/dist/browser.mjs
[browser-unpkg-link]: https://unpkg.com/@enbox/browser
[browser-unpkg-browser]: https://unpkg.com/@enbox/browser/dist/browser.mjs
[browser-dapps-link]: https://github.com/enboxorg/enbox/blob/main/docs/architecture/browser-dapps.md
[agents-link]: https://github.com/enboxorg/enbox/blob/main/AGENTS.md
[license-link]: https://github.com/enboxorg/enbox/blob/main/LICENSE
