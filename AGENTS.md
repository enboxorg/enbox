# Agent guide — Enbox monorepo

This file orients automated agents and new contributors: **what the repo is**, **how packages relate**, and **where to look first**. For exhaustive commands (tests, Docker services, migrations, AWS, docs), use **`CLAUDE.md`** at the repo root as the single source of truth.

## What this repository is

Enbox is a **Bun** monorepo for **Decentralized Web Nodes (DWN)**, **DIDs** (`did:dht`, `did:jwk`), and **application SDKs**. It contains:

- A spec-aligned **DWN engine** (`@enbox/dwn-sdk-js`) and **SQL-backed stores** (`@enbox/dwn-sql-store`).
- A production-style **DWN server** (`@enbox/dwn-server`) with HTTP/WebSocket APIs, registration, and admin features.
- **Client libraries**: low-level DWN clients (`@enbox/dwn-clients`), an **agent** with encrypted vault and DWN-backed stores (`@enbox/agent`), **headless auth** (`@enbox/auth`), a **high-level SDK** (`@enbox/api`), and **browser helpers** (`@enbox/browser`).
- **Shared protocol definitions** (`@enbox/protocols`) and optional **codegen** (`@enbox/protocol-codegen`).
- **`apps/docs`**: the public documentation site (Fumadocs + Next.js); it uses its own linter (Biome), not the ESLint graph used by packages.

## Non-negotiable rules

1. **Never weaken production code only to satisfy tests.** If a test fails because mocks are wrong, fix the test or the stub — see the “Inviolable Rules” section in `CLAUDE.md`.
2. **Always work in a fresh worktree off the latest base branch** (default `main`, or whichever branch the user names). Never do long-running work on the primary clone, and never force-push shared branches.
   ```bash
   git fetch origin
   git worktree add ../enbox-<task> -b <type>/<short-desc> origin/main
   ```
3. **Ship through a PR.** `main` is protected — every change (including doc-only ones) goes through `gh pr create` against the requested base. Use conventional commit titles (`fix(...)`, `feat(...)`, `docs: ...`, `chore(deps): ...`) matching the existing log.
4. **Watch CI until it is green.** `gh pr checks <N> --watch`, `gh run view <id> --log-failed`. If CI fails, reproduce locally, fix forward in the same PR, and never merge with known failures or disable checks to unblock. Treat Quality Gate / coverage regressions as failures.
5. **Style is non-negotiable.** Run `bun run lint` (and `bun run lint:fix`) before pushing. Match the conventions in `CLAUDE.md` → “Coding Style” and “Test Style”: type-import grouping, colon alignment in multi-key object literals, explicit return types and visibility, `.js` extensions on relative imports, kebab-case filenames, `.spec.ts` tests.
6. **`@enbox/dwn-sdk-js` is the gold-standard package.** When a convention is ambiguous (errors, JSDoc, module layout, test shape, JSON Schema placement), follow `dwn-sdk-js` rather than any other package.

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

**Dependency direction (high level):**

- Core chain: `common` → `crypto` → `dids` → `dwn-sdk-js` → `dwn-clients` → `agent` → `auth` → `api`.
- Server chain: `dwn-sdk-js` → `dwn-sql-store` → `dwn-server` (which also consumes `dwn-clients`).
- `protocols` builds on `api` + `dwn-sdk-js`.
- `browser` sits above `agent` + `api` + `auth` + `dids`; it does **not** pull in `dwn-server` or `dwn-sql-store`.
- `agent` does **not** depend on `dwn-sql-store` — only `dwn-server` does. Agents talk to a DWN over `dwn-clients`.

Exact edges live in each package’s `package.json` (`workspace:*`).

## How apps use Enbox in practice

Downstream repos typically consume **npm releases** of scoped `@enbox/*` packages (not the monorepo path directly).

- **web-wallet** (package `@enbox/dweb-wallet`): Full stack — `agent`, `api`, `auth`, `browser`, `dwn-clients`, `protocols`, plus crypto/dids/common. Typical pattern: Vite + React, PWA, node stdlib browser shims, Vitest/Playwright.
- **nutsd** (package `@enbox/nutsd`): Narrower surface — e.g. **`@enbox/browser`** (and Cashu) for wallet/DID UX without pulling the full DWN server stack into the app bundle.

When changing public APIs, assume **multiple external apps** pin different semver ranges; follow the changeset workflow in `CLAUDE.md` for releases. `.changeset/config.json` sets `updateInternalDependencies: "patch"`, so bumping one package (e.g. `dwn-sdk-js` as `minor`) auto-patches every direct consumer in the graph — keep that in mind when drafting changeset files.

## What to run before proposing a PR

Minimum bar (from `CLAUDE.md`): **`bun run lint`**, **`bun run --filter @enbox/agent build`** (rebuild `dwn-sdk-js` first if you touched it), and **agent tests** with **`DID_DHT_GATEWAY_URI`** set. Full verification uses Docker test services and often a local DWN on port 3000 — details are in `CLAUDE.md` (“Local Test Infrastructure”).

In `turbo.json`, **`test:node`** declares `dependsOn: ["^build"]`, so it runs only after upstream workspace packages **`build`**. **`lint`** / **`lint:fix`** do not use that dependency — they are scheduled without an automatic `^build` first. Root **`turbo run test:node`** skips **`@enbox/dwn-sql-store`** because that package only defines **`test`**; run `bun run --filter @enbox/dwn-sql-store test` when you need its suite.

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
