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
  - [Activate Polyfills](#activate-polyfills)
  - [Project Resources](#project-resources)

---

<a id="introduction"></a>

This package contains browser-specific helpers for building DWAs (Decentralized Web Apps) with the Enbox toolkit.

### Activate Polyfills

This enables a service worker that can handle Enbox features in the browser such as resolving DRLs that look like: `http://dweb/did:dht:abc123/protocols/read/aHR0cHM6Ly9hcmV3ZXdlYjV5ZXQuY29tL3NjaGVtYXMvcHJvdG9jb2xz/avatar`

To enable this functionality import and run `activatePolyfills()` at the entrypoint of your project, or within an existing service worker.

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
[agents-link]: https://github.com/enboxorg/enbox/blob/main/AGENTS.md
[license-link]: https://github.com/enboxorg/enbox/blob/main/LICENSE
