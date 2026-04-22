# Agent guide — Enbox monorepo

This file orients automated agents and new contributors: **what the repo is**, **how packages relate**, and **where to look first**. For exhaustive commands (tests, Docker services, migrations, AWS, docs), use **`CLAUDE.md`** at the repo root as the single source of truth.

## What this repository is

Enbox is a **Bun** monorepo for **Decentralized Web Nodes (DWN)**, **DIDs** (`did:dht`, `did:jwk`), and **application SDKs**. It contains:

- A spec-aligned **DWN engine** (`@enbox/dwn-sdk-js`) and **SQL-backed stores** (`@enbox/dwn-sql-store`).
- A production-style **DWN server** (`@enbox/dwn-server`) with HTTP/WebSocket APIs, registration, and admin features.
- **Client libraries**: low-level DWN clients (`@enbox/dwn-clients`), an **agent** with encrypted vault and DWN-backed stores (`@enbox/agent`), **headless auth** (`@enbox/auth`), a **high-level SDK** (`@enbox/api`), and **browser helpers** (`@enbox/browser`).
- **Shared protocol definitions** (`@enbox/protocols`) and optional **codegen** (`@enbox/protocol-codegen`).
- **`apps/docs`**: the public documentation site (Fumadocs + Next.js); it uses its own linter (Biome), not the ESLint graph used by packages.

## Non-negotiable rule (tests vs production)

**Never weaken production code only to satisfy tests.** If a test fails because mocks are wrong, fix the test or the stub — see the “Inviolable Rules” section in `CLAUDE.md`.

## Workspace layout

Published / primary packages live under `packages/`. Root `package.json` lists all **workspace members**; `examples/` holds Vite sample apps that are **not** workspace packages.

| Package | One-line role |
|---|---|
| `@enbox/common` | Shared utilities, caches, LevelDB helpers |
| `@enbox/crypto` | Cryptographic primitives and JWE |
| `@enbox/dids` | DID creation, resolution, `did:dht` (Pkarr gateway required for tests) |
| `@enbox/dwn-sdk-js` | DWN protocol implementation (style reference for TS/ESLint) |
| `@enbox/dwn-sql-store` | SQL MessageStore/DataStore/StateIndex + **DWN** Kysely migrations |
| `@enbox/dwn-clients` | DWN JSON-RPC / client transport |
| `@enbox/dwn-server` | Runnable DWN server; **server** Kysely migrations separate from DWN store migrations |
| `@enbox/agent` | `EnboxUserAgent`, vault, DWN data stores, sync |
| `@enbox/auth` | `AuthManager`, sessions, password/connect flows, storage adapters |
| `@enbox/api` | App-facing SDK; composes agent + auth |
| `@enbox/browser` | Browser connect handlers and DWeb wiring (builds on agent, api, auth) |
| `@enbox/protocols` | Reusable protocol definitions for the ecosystem |
| `@enbox/protocol-codegen` | CLI to generate TS from schemas / protocols |
| `@enbox/dwn-server-admin-ui` | Admin UI bundle consumed by the server |
| `@enbox/electrobun-dwn` | **Private** desktop wrapper embedding the server |

**Dependency direction (high level):** `common` → `crypto` → `dids` → `dwn-sdk-js` → (`dwn-sql-store`, `dwn-clients`) → `agent` → `auth` → `api`; `protocols` builds on `api` + `dwn-sdk-js`; `browser` sits above `agent`/`api`/`auth`; `dwn-server` combines `dwn-sdk-js`, `dwn-sql-store`, and `dwn-clients`. Exact edges are in each package’s `package.json` (`workspace:*`).

## How apps use Enbox in practice

Downstream repos typically consume **npm releases** of scoped `@enbox/*` packages (not the monorepo path directly).

- **web-wallet** (package `@enbox/dweb-wallet`): Full stack — `agent`, `api`, `auth`, `browser`, `dwn-clients`, `protocols`, plus crypto/dids/common. Typical pattern: Vite + React, PWA, node stdlib browser shims, Vitest/Playwright.
- **nutsd** (package `@enbox/nutsd`): Narrower surface — e.g. **`@enbox/browser`** (and Cashu) for wallet/DID UX without pulling the full DWN server stack into the app bundle.

When changing public APIs, assume **multiple external apps** pin different semver ranges; follow the changeset workflow in `CLAUDE.md` for releases.

## What to run before proposing a PR

Minimum bar (from `CLAUDE.md`): **`bun run lint`**, **`bun run --filter @enbox/agent build`** (rebuild `dwn-sdk-js` first if you touched it), and **agent tests** with **`DID_DHT_GATEWAY_URI`** set. Full verification uses Docker test services and often a local DWN on port 3000 — details are in `CLAUDE.md` (“Local Test Infrastructure”).

Turbo runs `test:node` only after upstream packages in the graph **`build`**, which matches how CI discovers type errors.

## Where to make common kinds of changes

| Goal | Likely packages / paths |
|---|---|
| DWN protocol, message handlers, in-memory stores | `packages/dwn-sdk-js/` |
| Postgres/MySQL/SQLite persistence, DWN schema migrations | `packages/dwn-sql-store/src/migrations/` |
| HTTP API, tenant registration, server-only tables | `packages/dwn-server/` (+ server migrations) |
| Agent vault, DWN-backed stores, sync | `packages/agent/src/` |
| Login/session/connect, `AuthManager` | `packages/auth/src/` |
| High-level APIs for apps | `packages/api/src/` |
| `dwn://` discovery, browser connect | `packages/browser/src/`, `packages/auth/src/discovery.ts` |
| Shared protocol definitions | `packages/protocols/` |
| Docs site content | `apps/docs/content/docs/` |

## Cryptography and protocols (mental model)

- **Vault (Layer 1):** BIP-39 + password-encrypted agent material (`HdIdentityVault` in agent).
- **DWN records (Layer 2):** JWE with X25519 key agreement when `encryptionRequired` is set on protocol types; `$encryption` injected at protocol install.

See `CLAUDE.md` → “Architecture Notes” for store inheritance and tenant vs agent DID.

## Releases

Packages publish via **Changesets**; do **not** hand-edit `version` fields for releases. Never run `changeset version` locally to consume changesets — CI owns that. See `CLAUDE.md` → “Releasing & Publishing Packages”.

## Related infrastructure

- **Pkarr / DHT gateway** for `did:dht` tests: `docker-compose.test.yaml` (documented in `CLAUDE.md`).
- **Hosted DWN** (AWS): `infra/` and the deployment section in `CLAUDE.md`.
- **dwn-relay** is a **separate** repository (`enboxorg/dwn-relay`), not this monorepo.

---

For command snippets, coverage expectations, ESLint/import rules, test harness patterns, and SQL migration conventions, read **`CLAUDE.md`**.
