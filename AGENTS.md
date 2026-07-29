# Agent guide — Enbox monorepo

Single source of truth for agents and contributors working in this repo. Claude Code, Cursor, Aider, Codex, and any other agent should read this file before doing work. `CLAUDE.md` exists only to redirect Claude Code here so we maintain one document, not two.

## What this repository is

Enbox is a **Bun** monorepo for **Decentralized Web Nodes (DWN)**, **DIDs** (`did:dht`, `did:jwk`), and **application SDKs**. It contains:

- A spec-aligned **DWN engine** (`@enbox/dwn-sdk-js`) and **SQL-backed stores** (`@enbox/dwn-sql-store`).
- A production-style **DWN server** (`@enbox/dwn-server`) with HTTP/WebSocket APIs, registration, and admin features.
- **Client libraries**: low-level DWN clients (`@enbox/dwn-clients`), an **agent** with encrypted vault and DWN-backed stores (`@enbox/agent`), a shared **connect handshake kernel** (`@enbox/connect`), **headless auth** (`@enbox/auth`), a **high-level SDK** (`@enbox/api`), **browser helpers** (`@enbox/browser`), and **CLI helpers** (`@enbox/cli`).
- **Shared protocol definitions** (`@enbox/protocols`) and optional **codegen** (`@enbox/protocol-codegen`).
- **`apps/docs`**: the public documentation site (Fumadocs + Next.js); it uses its own linter (Biome), not the ESLint graph used by packages.

## Inviolable Rules

### Never modify production code to satisfy tests

Production code must NEVER be weakened, loosened, or given special-case handling to make a test pass. This includes adding defensive null/undefined checks, try/catch blocks, early returns, or any other logic whose sole purpose is to handle conditions that only arise in stubbed/mocked test environments. This is how security vulnerabilities are born.

If a test fails because new production code interacts badly with a stubbed environment, the fix belongs **entirely in the test**: update the stubs to properly simulate reality, or stub the new production method directly on the handler/class instance. The production code path must remain exactly as strict as the real-world scenario demands.

## Contributor Workflow

The workflow below is non-optional. Follow it for every change, no matter how small.

### 1. Always work in a fresh worktree off the latest base branch

Never run destructive operations (rebase, force-push, branch reset) on the repo's main clone — use a dedicated worktree per task so your in-flight work is always isolated. Default base branch is **`main`** unless the user explicitly requests another branch.

```bash
cd /path/to/enbox            # the main clone
git fetch origin             # always refresh first
git worktree add ../enbox-<short-task-name> -b <type>/<short-desc> origin/main
cd ../enbox-<short-task-name>
bun install                  # first-time per worktree
```

If the user nominates a different base (`release/x.y`, a feature integration branch, etc.), substitute it for `origin/main` above. When the task is done and merged, clean up:

```bash
git worktree remove ../enbox-<short-task-name>
git branch -d <type>/<short-desc>   # only after the PR is merged
```

Branch naming follows the existing convention in `git log`: `fix/...`, `feat/...`, `chore/...`, `docs/...`, `perf/...`. Keep it concise.

### 2. Open a PR — do not push to `main`

`main` is protected. Every change — including doc-only updates and one-line fixes — goes through a pull request:

1. Commit with a conventional message (`<type>(<scope>): <summary>`) matching the log (e.g. `fix(agent): …`, `feat(auth): …`, `docs: …`, `chore(deps): …`).
2. Push your branch to `origin` (never force-push shared branches).
3. Open the PR against the requested base branch (default `main`) with `gh pr create`.
4. Write a concise, reviewer-focused PR body:
   - State what changed and why. Include behavior, API, compatibility, migration,
     rollout, or design details only when they help review the specific change.
   - Do **not** add a **Test plan** or **Validation** section for routine CI work
     such as builds, lint, typechecks, standard test suites, coverage, or other
     checks required of every PR. CI is the authoritative record for those.
   - Mention validation only when it is non-standard or manual and gives the
     reviewer evidence CI cannot provide, such as a visual check, benchmark,
     hardware test, or reproduction of the reported bug.
   - Never include unrelated local failures, environment limitations, expected
     CI behavior, implementation chronology, or commentary about the work
     process.
   - Omit empty or boilerplate sections. A short summary is sufficient for most
     PRs; add migration or rollout notes only when they actually exist.

#### GitHub CLI (`gh`) — use REST API for mutations

`gh pr edit --body` silently fails due to a GraphQL Projects Classic deprecation issue. When updating PR bodies (or any mutation that fails silently), use the REST API instead:

```bash
# Write body to a temp file, then:
gh api repos/enboxorg/enbox/pulls/<PR_NUMBER> -X PATCH -F body=@pr-body.md
```

### 3. Verify CI — never walk away from a red pipeline

Opening a PR is not the end of the job. Watch CI through to green:

```bash
gh pr checks <PR_NUMBER> --watch        # live tail until all checks finish
gh run view <run-id> --log-failed       # inspect a failed workflow
gh pr view <PR_NUMBER> --json statusCheckRollup
```

If CI fails:

- **Reproduce locally first.** Match the failing command (lint, build, `test:node`, coverage, docs build, deploy) exactly. CI log paths map 1:1 to the `scripts/` and root `package.json` entries.
- **Fix forward in the same PR** — do not merge with known failures and do not disable checks.
- **Transient failures:** re-run with `gh run rerun <run-id> --failed` only after you've confirmed the failure is genuinely environmental (e.g. registry flake). Document the rationale in a PR comment; never silently re-run to mask a real bug.
- **Quality Gate (SonarCloud) / coverage regressions** count as CI failures — address them, don't override.

Merging the PR is the final step of the task, not opening it. **Do not merge a PR unless the user explicitly asks you to merge it.** Once CI is green, report that the PR is ready and wait for approval.

### 4. Style is non-negotiable — match the codebase, not your preference

Code style in this repo is **strictly enforced** and routinely corrects drift. Always:

- Run `bun run lint` locally before pushing; run `bun run lint:fix` to auto-fix the fixable subset. The shared flat config (`eslint.config.cjs`) is the source of truth for every package except `apps/docs` (Biome).
- When ESLint reports auto-fixable formatting/import/key-spacing issues, run the appropriate autofix command first (`bun run lint:fix` from the root, or the matching package-scoped lint fix if you are intentionally narrowing scope). Inspect the resulting diff, then manually edit only the remaining non-fixable issues.
- Follow the conventions in [Coding Style](#coding-style) and [Test Style](#test-style) below: type-import grouping, colon alignment in multi-key object literals, explicit return types and visibility modifiers, `.js` extensions on relative imports, kebab-case files, `.spec.ts` tests, etc.
- Read the diff you're producing. Style drift in a PR (inconsistent quote style, stray `any`, unsorted imports, missing return types) is the single most common reason PRs get bounced. ESLint catches most of it; a careful human review catches the rest.

### 5. When in doubt, read `dwn-sdk-js`

`@enbox/dwn-sdk-js` is the **gold-standard package** in this monorepo — the oldest, the most reviewed, and the template every other package is measured against for both style and structure. When a convention is ambiguous (error types, JSDoc density, module layout, test shape, `DwnError` + `DwnErrorCode`, JSON Schema organization, `todo-plz` usage), **follow `dwn-sdk-js`** rather than whatever another package happens to do.

## Monorepo Overview

Bun workspace monorepo for decentralized web infrastructure. Runtime is **Bun** (>=1.0.0). The repo root pins a **`packageManager`** field (see root `package.json`) so local Bun matches CI and lockfile expectations.

**Task orchestration:** `bun run build`, `bun run lint`, and `bun run test:node` at the repo root invoke **Turbo** (`turbo.json`, pinned to `turbo@2.8.13` in root `devDependencies`):

- **`build`:** `dependsOn: ["^build"]`, `outputs: ["dist/**"]` — each package builds after its workspace dependencies.
- **`test:node`:** `dependsOn: ["^build"]`, `cache: false` — tests run after upstream packages in the graph have built (matches CI type-check expectations).
- **`lint` / `lint:fix`:** no `dependsOn` in `turbo.json` — they do **not** automatically run `^build` first. If a package's ESLint setup assumes fresh `dist/` (rare), run `bun run build` before `bun run lint`.

Root filter semantics:

- `bun run build` excludes `@enbox/docs` (uses Biome/Next.js) **and** `@enbox/electrobun-dwn` (private desktop shell). Build `electrobun-dwn` explicitly with `bun run --filter @enbox/electrobun-dwn build` when working on it.
- `bun run lint` / `lint:fix` exclude only `@enbox/docs`.
- `bun run test:node` excludes only `@enbox/docs`. Turbo schedules `test:node` only in packages that **define** that script. **`@enbox/dwn-sql-store`** exposes **`test`** but not **`test:node`**, so it is omitted from root `turbo run test:node` — run `bun run --filter @enbox/dwn-sql-store test`. **`@enbox/dwn-server`** **does** define **`test:node`** and is included. **`@enbox/dwn-server-admin-ui`** defines a no-op **`test:node`** stub; **`@enbox/electrobun-dwn`** has no **`test:node`** script.

### Workspace packages

Published / primary packages live under `packages/`. Root `package.json` lists all **workspace members**.

| Package | One-line role |
|---|---|
| `@enbox/common` | Shared utilities, caches, LevelDB helpers |
| `@enbox/crypto` | Cryptographic primitives and JWE |
| `@enbox/dids` | DID creation, resolution, `did:dht` (Pkarr gateway required for tests) |
| `@enbox/dwn-sdk-js` | DWN protocol implementation (style reference for TS/ESLint) |
| `@enbox/dwn-sql-store` | SQL MessageStore/DataStore + **DWN** Kysely migrations |
| `@enbox/dwn-clients` | DWN JSON-RPC / client transport |
| `@enbox/connect` | Connect handshake kernel — JWE envelope, JWT, wallet URI, relay transport, client/provider state machines |
| `@enbox/dwn-server` | Runnable DWN server; **server** Kysely migrations separate from DWN store migrations |
| `@enbox/agent` | `EnboxUserAgent`, vault, DWN data stores, sync, connect approval ceremony |
| `@enbox/auth` | `AuthManager`, sessions, password/connect flows, storage adapters |
| `@enbox/api` | App-facing SDK; composes agent + auth |
| `@enbox/browser` | Browser connect handlers, popup postMessage transports, DWeb wiring (builds on agent, api, auth, connect) |
| `@enbox/cli` | Terminal connect handlers and CLI entrypoint helpers (builds on agent, api, auth) |
| `@enbox/protocols` | Reusable protocol definitions for the ecosystem |
| `@enbox/protocol-codegen` | CLI to generate TS from schemas / protocols |
| `@enbox/dwn-server-admin-ui` | Bundled Preact admin UI assets for the server |
| `@enbox/local-node` | Shell-agnostic local DWN node runtime and headless CLI |
| `@enbox/electrobun-dwn` | **Private** desktop wrapper embedding the server |

### Package dependency graph (build order)

Core stack (simplified — follow `workspace:*` in each `package.json` for exact edges):

```
@enbox/common (TtlCache, LevelStore, shared utilities)
  @enbox/crypto (Ed25519, X25519, secp256k1, AES, JWE)
    @enbox/dids (did:dht, did:jwk, resolution)
      @enbox/dwn-sdk-js (DWN protocol engine, handlers, in-memory stores, JSON Schemas)
        @enbox/dwn-sql-store (Postgres/MySQL/SQLite DWN stores, Kysely migrations)
        @enbox/connect (connect handshake kernel — envelope, JWT, wallet URI, relay transport, client/provider)
        @enbox/dwn-clients (DWN JSON-RPC / transport clients)
          @enbox/dwn-server (HTTP/WebSocket DWN server, registration, admin API — uses dwn-sdk-js + dwn-sql-store + dwn-clients)
          @enbox/agent (identity vault, DWN-backed stores, sync, connect approval ceremony — uses dwn-sdk-js + dwn-clients + connect)
            @enbox/local-node (local-profile server runtime — uses agent discovery helpers + dwn-server)
            @enbox/auth (AuthManager, sessions, connect flows — uses agent + connect + dwn-sdk-js + dwn-clients)
              @enbox/api (high-level app SDK — uses agent + auth + dwn-clients)
                @enbox/protocols (published protocol definitions — uses api + dwn-sdk-js)
                @enbox/browser (BrowserConnectHandler, popup postMessage transports — uses agent + api + auth + connect + dids)
                @enbox/cli (CliConnectHandler, terminal helpers — uses agent + api + auth)
```

Notes on the graph:

- `@enbox/agent` does **not** depend on `@enbox/dwn-sql-store`; only `@enbox/dwn-server` does. The agent talks to a DWN over `@enbox/dwn-clients`.
- `@enbox/auth` depends directly on `@enbox/agent`, `@enbox/connect`, `@enbox/dwn-sdk-js`, and `@enbox/dwn-clients` (plus `common`/`crypto`/`dids`).
- `@enbox/connect` is the isomorphic connect-handshake kernel: ONE JWE envelope (ECDH-ES/X25519 + XC20P via `@enbox/crypto`, PIN folded into the KDF) and payload schema over per-channel transports. The relay transport lives in the kernel; the popup postMessage transports live in `@enbox/browser`; the wallet-side approval ceremony (`executeConnectApproval` — grants, revocations, grantKey delivery) lives in `@enbox/agent` because it needs agent internals. The relay endpoints on `dwn-server` store opaque ciphertext only.
- `@enbox/browser` composes `agent` + `api` + `auth` + `connect` + `dids`; it does not pull in `dwn-server` or `dwn-sql-store`.
- `@enbox/cli` composes `agent` + `api` + `auth` with Node/Bun-only terminal dependencies; it does not expose a browser bundle.
- `@enbox/local-node` composes `agent` discovery helpers with `dwn-server`; it is shell-agnostic local-node runtime code, not browser code.

Build from the bottom up. If you change `dwn-sdk-js`, rebuild it before building `agent`:

```bash
bun run --filter @enbox/dwn-sdk-js build
bun run --filter @enbox/agent build
```

Most packages expose a `build:browser` script, but it means different things:

- **`@enbox/agent`**, **`@enbox/api`**, **`@enbox/auth`**, and **`@enbox/browser`** emit bundled `dist/browser.mjs` artifacts via `build/browser-bundle.js` (esbuild). `agent`, `api`, and `browser` expose those artifacts from their browser-conditioned root exports; `auth` exposes its browser-safe surface from `@enbox/auth/browser` and from the root browser condition.
- **`@enbox/common`**, **`@enbox/crypto`**, and **`@enbox/dids`** expose `build:browser` for their browser bundle artifacts.
- **`@enbox/dwn-sdk-js`** emits `dist/browser.mjs` via its `bundle` script, not a `build:browser` script.
- **`@enbox/cli`**, **`@enbox/connect`**, **`@enbox/dwn-clients`**, **`@enbox/dwn-server`**, **`@enbox/dwn-sql-store`**, **`@enbox/local-node`**, **`@enbox/protocols`**, and **`@enbox/protocol-codegen`** do not define `build:browser`.

Browser storage rule: do not replace the browser Level stack with SQLite or in-memory stores. In browsers, `level` resolves to `browser-level` over IndexedDB, which is required for concurrent writes from tabs, workers, and service workers on the same origin.

Browser service-worker rule: **every Enbox browser dapp MUST register a service worker that calls `activatePolyfills()`** (from `@enbox/browser`). It is the DWeb network stack — DRLs (DWN-addressed URLs: avatars, attachments, `dweb` links) do not resolve without it, and the failure is silent: no build, type-check, test, or happy-path demo catches the omission; DRL fetches just die as ordinary network errors. It is not optional PWA tooling, despite the API name and the usual delivery vehicle (`vite-plugin-pwa`). Wiring patterns, build traps (worker format, precache cap, `process` shim), header pitfalls (COOP silently breaks the wallet popup ceremony), and the scaffold checklist live in [`docs/architecture/browser-dapps.md`](docs/architecture/browser-dapps.md).

### Key directories

| Path | Purpose |
|---|---|
| `packages/agent/src/` | Agent framework source |
| `packages/agent/tests/` | Agent tests (bun:test + Sinon) |
| `packages/agent/src/store-data.ts` | Base `DwnDataStore` class (protocol-backed storage with encryption) |
| `packages/agent/src/store-key.ts` | `DwnKeyStore` — encrypted private key storage |
| `packages/agent/src/store-data-protocols.ts` | Protocol definitions (`JwkProtocolDefinition`, `IdentityProtocolDefinition`) |
| `packages/agent/src/dwn-api.ts` | `AgentDwnApi` — DWN operations, encryption callbacks, participant detection |
| `packages/agent/src/hd-identity-vault.ts` | `HdIdentityVault` — seed phrase / password vault for agent DID |
| `packages/agent/src/test-harness.ts` | `PlatformAgentTestHarness` — test infrastructure (exported as public API) |
| `packages/dwn-sdk-js/src/` | DWN SDK source (gold-standard for style) |
| `packages/dwn-sdk-js/json-schemas/` | JSON Schema definitions for DWN messages |
| `packages/dwn-clients/src/` | DWN client transport / JSON-RPC |
| `packages/connect/src/` | Connect handshake kernel — envelope, JWT, wallet URI, relay transport, `ConnectClient`/`ConnectProvider` |
| `packages/agent/src/connect-approval.ts` | `executeConnectApproval` — the single wallet-side approval ceremony (grants, revocations, grantKey delivery) |
| `packages/auth/src/` | `AuthManager`, storage adapters, connect and discovery helpers |
| `packages/cli/src/` | CLI connect handler and terminal wallet approval helpers |
| `packages/local-node/src/` | Shell-agnostic local DWN node runtime and headless CLI |
| `packages/protocols/src/` | Shared protocol definitions consumed by apps |
| `packages/protocol-codegen/src/` | Codegen CLI implementation |
| `packages/dwn-server-admin-ui/` | Admin UI bundle source and build scripts |
| `packages/electrobun-dwn/` | Electrobun-embedded local DWN (private package) |
| `apps/docs/` | Documentation site (Fumadocs + Next.js, deployed to Cloudflare Pages) |
| `apps/docs/content/docs/` | MDX content (guides + API reference) |
| `apps/docs/src/` | Next.js app source (layouts, components, styles) |
| `docs/` | Existing markdown docs (HOSTING.md, TESTING.md, architecture/) |
| `scripts/` | CI / release helpers — `publish.sh`, `ci-setup.sh`, `run-node-coverage.sh`, `run-browser-coverage.sh`, `merge-lcov.mjs`, `test-with-server.sh` |
| `build/` | Shared build helpers — `browser-bundle.js` (esbuild browser bundler for `@enbox/agent` / `@enbox/api`) |
| `turbo.json`, `eslint.config.cjs` | Root Turbo task graph and shared ESLint flat config used by every package except `apps/docs` (which uses Biome) |

### How apps use Enbox in practice

Downstream repos typically consume **npm releases** of scoped `@enbox/*` packages (not the monorepo path directly).

- **web-wallet** (package `@enbox/dweb-wallet`): Full stack — `agent`, `api`, `auth`, `browser`, `dwn-clients`, `protocols`, plus crypto/dids/common. Typical pattern: Vite + React, PWA, browser-conditioned Enbox entrypoints, Vitest/Playwright.
- **nutsd** (package `@enbox/nutsd`): Narrower surface — e.g. **`@enbox/browser`** (and Cashu) for wallet/DID UX without pulling the full DWN server stack into the app bundle.

When changing public APIs, assume **multiple external apps** pin different semver ranges and follow the changeset workflow below. Enbox is greenfield: every releasable package change uses a `patch` changeset, including new and breaking APIs.

### Where to make common kinds of changes

| Goal | Likely packages / paths |
|---|---|
| DWN protocol, message handlers, in-memory stores | `packages/dwn-sdk-js/` |
| Postgres/MySQL/SQLite persistence, DWN schema migrations | `packages/dwn-sql-store/src/migrations/` |
| HTTP API, tenant registration, server-only tables | `packages/dwn-server/` (+ server migrations) |
| Agent vault, DWN-backed stores, sync | `packages/agent/src/` |
| Login/session/connect, `AuthManager` | `packages/auth/src/` |
| High-level APIs for apps | `packages/api/src/` |
| CLI wallet connect, terminal QR/link flows | `packages/cli/src/` |
| Local DWN node runtime, pairing broker, discovery file writer | `packages/local-node/` |
| Connect handshake (envelope, transports, pairing) | `packages/connect/src/`, `packages/agent/src/connect-approval.ts` |
| `dwn://` discovery, browser connect | `packages/browser/src/`, `packages/auth/src/discovery.ts` |
| Shared protocol definitions | `packages/protocols/` |
| Docs site content | `apps/docs/content/docs/` |

## Pre-Push Requirements

Before any commits get pushed and PRs opened, ALL of the following MUST pass:

1. **Lint** — `bun run lint` (use `bun run lint:fix` to auto-fix issues)
2. **Build** — `bun run --filter @enbox/agent build` (rebuild `dwn-sdk-js` first if changed)
3. **Tests** — bring up the dev environment once with `bun run dev:ensure` (gateway + live-reload `:3000` server + `.env.test`), then `bun run test:node` from `packages/agent/`. Without `dev:ensure`, export the vars manually: `export DID_DHT_GATEWAY_URI=http://localhost:7527 DID_DHT_ALLOW_PRIVATE_GATEWAY=1` (note: the `e2e-*` specs still need a `:3000` server).

Do not push or open a PR until all three checks pass locally. See [Local Test Infrastructure](#local-test-infrastructure) for required services.

## Running Tests

Most packages use **`bun test`** (Bun's native test runner). **`@enbox/browser`** uses **Vitest** with the browser runner instead (see table below).

### One command to start the dev environment

Before running any suite that needs the did:dht gateway or a remote DWN (`agent`, `api`, `dids`, `dwn-clients`, `dwn-server`), bring up the local dev environment **once** instead of starting services by hand:

```bash
bun run dev          # humans: gateway + live-reload DWN server, then tail server logs
bun run dev:ensure   # agents/CI: same, but idempotent and returns immediately
bun run dev:status   # show gateway / DWN server / container state
bun run dev:down     # stop the dev DWN server
```

`scripts/dev.sh` (what those wrap):

- ensures the **did:dht gateway** (Pkarr relay) is reachable — it is external infra, started if down but never rebuilt;
- runs the **DWN server on `:3000` straight from TypeScript source under `bun --watch`**, so edits to `packages/dwn-server` reload live with no build step (storage is ephemeral LevelDB + an in-memory SQLite TTL cache — no database container needed);
- writes a git-ignored **`.env.test`** into each test package, which `bun test` auto-loads — so `DID_DHT_GATEWAY_URI`, `DID_DHT_ALLOW_PRIVATE_GATEWAY`, `TEST_DWN_URL`, and `NATS_URL` are set with **no manual exports**.

After `bun run dev:ensure`, just run the suite — the `export DID_DHT_*` lines elsewhere in this doc become an optional fallback. For the DB-backed suites (`dwn-sql-store`, `dwn-server`), also run `scripts/dev.sh infra` to bring up Postgres x2 / MySQL / NATS / MinIO. Full details: [`docs/TESTING.md`](docs/TESTING.md).

### Test framework by package

| Package | Runner | Command (from package dir) |
|---|---|---|
| `@enbox/agent` | `bun test` | `bun run test:node` |
| `@enbox/api` | `bun test` | `bun run test:node` |
| `@enbox/dwn-sdk-js` | `bun test` | `bun run test:node` |
| `@enbox/dwn-server` | `bun test` | `bun run test:node` |
| `@enbox/dwn-sql-store` | `bun test` | `bun run test` (no `test:node` script — not in root `turbo run test:node`) |
| `@enbox/common` | `bun test` | `bun run test:node` |
| `@enbox/crypto` | `bun test` | `bun run test:node` |
| `@enbox/dids` | `bun test` | `bun run test:node` |
| `@enbox/auth` | `bun test` | `bun run test:node` |
| `@enbox/cli` | `bun test` | `bun run test:node` |
| `@enbox/local-node` | `bun test` | `bun run test:node` |
| `@enbox/dwn-clients` | `bun test` | `bun run test:node` |
| `@enbox/connect` | `bun test` | `bun run test:node` |
| `@enbox/protocols` | `bun test` | `bun run test:node` |
| `@enbox/protocol-codegen` | `bun test` | `bun run test:node` |
| `@enbox/browser` | Vitest (browser runner) | `bun run test:browser` — **no `test:node` suite**; browser-only via `@vitest/browser-playwright` |

### Agent / API / Auth tests (bun:test)

**Important:** these suites need `DID_DHT_GATEWAY_URI` and `DID_DHT_ALLOW_PRIVATE_GATEWAY=1` (the local Pkarr relay), and the `agent`/`api` `e2e-*` suites also need a DWN server on `:3000`. `bun run dev:ensure` sets all of this up — the gateway, the live-reload `:3000` server, and a `.env.test` that supplies these vars automatically. Run it once and skip the manual exports below. (Without these vars, a large subset of tests fail with Pkarr / `did:dht` publishing errors or local-gateway URL validation errors; without the `:3000` server, the `e2e-*` specs fail to connect.)

The manual equivalent, if you are not using `dev:ensure`:

```bash
export DID_DHT_GATEWAY_URI=http://localhost:7527
export DID_DHT_ALLOW_PRIVATE_GATEWAY=1

# Full agent test suite (from packages/agent/):
bun run test:node

# Single test file (from packages/agent/):
bun test tests/store-key.spec.ts
```

### DWN SDK / other packages (bun test)

```bash
# Full DWN SDK test suite (from packages/dwn-sdk-js/):
bun run test:node

# DWN SDK tests with name filter:
GREP="ProtocolsConfigure" bun run test:node-grep
# Which runs: bun test .spec.ts -t $GREP

# Run all tests across the monorepo (from repo root):
bun run test:node

# Lint all packages (from repo root):
bun run lint
```

## Local test infrastructure

For everyday local work, `bun run dev` / `bun run dev:ensure` (see [One command to start the dev environment](#one-command-to-start-the-dev-environment)) handles the gateway, the live-reload `:3000` DWN server, and the test env vars. Setting up the underlying Docker services (Pkarr relay, Postgres x2, MySQL, NATS, MinIO), the required environment variables (`DID_DHT_GATEWAY_URI`, `DID_DHT_ALLOW_PRIVATE_GATEWAY`, `NATS_URL`), running a local DWN server on `:3000` by hand, browser-test setup, and the CI coverage pipeline all live in [`docs/TESTING.md`](docs/TESTING.md). Read it before running the full test suite for `agent`, `api`, `auth`, `dids`, `dwn-server`, or `dwn-sql-store`, or before debugging a `Failed to put Pkarr record` error.

## Releasing & Publishing Packages

Packages are published to npm via **Changesets** and CI. **NEVER bump versions manually in `package.json`** — use the changeset workflow instead.

### How it works

1. **Create a patch changeset** describing the changes:
   ```bash
   bun changeset
   ```
   This interactively creates a `.changeset/<random-name>.md` file. Select the affected packages and use `patch` for each one.

2. **Commit and push** the changeset file(s) to `main` (directly or via PR).

3. **CI creates a "Version Packages" PR** — the `release.yml` workflow detects pending changesets and opens a PR that bumps all `package.json` versions, updates changelogs, and regenerates the lockfile.

4. **Merge the Version Packages PR** — CI then runs `scripts/publish.sh` which resolves `workspace:*` deps to real versions, packs each package with `bun pm pack`, and publishes tarballs via `npm publish`.

### Key details

- **Changeset config** is in `.changeset/config.json`.
- **`@enbox/dwn-relay`** has been moved to its own repository at <https://github.com/enboxorg/dwn-relay>.
- **`updateInternalDependencies: "patch"`** — when a dependency gets bumped, its dependents automatically get a patch bump too.
- **`scripts/publish.sh`** handles the Bun `workspace:*` → real version resolution that changesets' built-in publish cannot do.
- The publish script **skips already-published versions** (idempotent).
- Git tags are created automatically in the format `@enbox/<package>@<version>`.
- npm auth is handled via `NPM_TOKEN` secret in CI.

### IMPORTANT: Do NOT run `changeset version` locally

**Never run `bunx changeset version` locally.** This command consumes the changeset files, bumps `package.json` versions, and updates changelogs — that is CI's job. If you accidentally run it, revert with `git checkout -- packages/ .changeset/`.

The correct local workflow is:
1. Create the `.changeset/<name>.md` file (manually or via `bun changeset`)
2. Commit the changeset file
3. Push to `main`
4. CI handles the rest

### Agent-friendly changeset creation

Since `bun changeset` is interactive (not supported in agents), create the changeset file directly:

```bash
cat > .changeset/my-changeset.md << 'EOF'
---
"@enbox/dwn-sdk-js": patch
"@enbox/agent": patch
---

feat: add new protocol feature and update agent to use it
EOF
```

Use `bunx changeset status` to verify the changeset is valid before committing.

### Version policy for this project

| Change type | Bump | Examples |
|---|---|---|
| New feature / new API | `patch` | New protocol directive, new sync engine, new public method |
| Bug fix / security fix | `patch` | SSRF protection, escape LIKE wildcards, crash fix |
| Breaking change | `patch` | Removed public API, changed wire format, renamed exports — greenfield project, breaking changes are expected |
| Test-only changes | No bump needed | Don't include test-only packages in the changeset |

### Example changeset file

```markdown
---
"@enbox/dwn-clients": patch
"@enbox/api": patch
---

feat: add provider-auth-v0 client methods and Enbox.connect() integration
```

## Coding Style

Style is derived from `dwn-sdk-js` (gold standard). ESLint enforces most rules.

**Linter boundary:** every workspace package uses the shared ESLint flat config at the repo root (`eslint.config.cjs`); `apps/docs` is the only member that uses **Biome** instead and is explicitly filtered out of `bun run lint` / `lint:fix`. Do not run `eslint` against `apps/docs` and do not run Biome against `packages/*`.

### Imports

Type imports first (grouped), then value imports. Both groups alphabetically sorted. All relative imports use `.js` extension.

```typescript
import type { Filter } from '../types/query-types.js';
import type { ProtocolDefinition, ProtocolRuleSet } from '../types/protocols-types.js';

import { DwnError, DwnErrorCode } from './dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
```

### Object property alignment

Align colons when an object literal has multiple keys. This is enforced by ESLint `key-spacing` with `align.on: 'colon'`.

```typescript
const result = await agent.dwn.processRequest({
  author        : tenantDid,
  target        : tenantDid,
  messageType   : DwnInterface.RecordsWrite,
  messageParams : { ...this._recordProperties },
});
```

### Naming conventions

| Element | Convention | Example |
|---|---|---|
| Classes | PascalCase | `DwnKeyStore`, `AgentDwnApi`, `ProtocolsConfigure` |
| Methods/functions | camelCase | `processRequest()`, `getEncryptionKeyDeriver()` |
| Private fields | `_` prefix | `private _agent`, `private _cache` |
| Boolean getters | `is` prefix | `get isLocked()`, `get isSignedByAuthorDelegate()` |
| Enum members | PascalCase | `ProtocolAction.Create`, `DwnInterface.RecordsWrite` |
| Files | kebab-case | `store-data.ts`, `dwn-api.ts`, `local-key-manager.ts` |
| Test files | kebab-case + `.spec.ts` | `store-key.spec.ts`, `dwn-api.spec.ts` |

### Types, interfaces, enums

- **`type`** for data shapes (DTOs, messages, options, descriptors, results)
- **`interface`** for service contracts (stores, signers, handlers — things with implementations)
- **`enum`** for finite domain-specific value sets
- Intersection types (`&`) for extending message types

```typescript
// type — data shape
export type DataStoreGetParams = DataStoreTenantParams & { id: string; useCache?: boolean; };

// interface — service contract
export interface AgentDataStore<TStoreObject> {
  delete(params: DataStoreDeleteParams): Promise<boolean>;
  get(params: DataStoreGetParams): Promise<TStoreObject | undefined>;
}

// enum — finite set
export enum DwnInterface { RecordsWrite = 'RecordsWrite', RecordsRead = 'RecordsRead' }
```

### Functions and methods

- Explicit return types on ALL functions and methods
- Explicit `public`/`private`/`protected` on all class members
- Static factory pattern preferred over public constructors (`static async create()`)
- Curly braces required for all control flow: `if (x) { return y; }`
- `prefer-const` for all non-reassigned variables
- `undefined` checks use strict equality: `if (schema !== undefined)`
- Early-return guard clauses for preconditions

### Error handling

In `dwn-sdk-js`: use `DwnError` with typed `DwnErrorCode` enum and lowercase message:
```typescript
throw new DwnError(DwnErrorCode.ProtocolAuthorizationProtocolNotFound, `unable to find protocol definition for ${protocolUri}`);
```

In `agent`: use standard `Error` with descriptive class-prefixed messages:
```typescript
throw new Error(`AgentDwnApi: DID '${didUri}' does not have a keyAgreement verification method.`);
```

### JSDoc

Brief JSDoc on public methods and complex private methods. Use `@param`, `@returns`, `@throws` where appropriate.

```typescript
/**
 * Install the protocol for the given tenant using a `ProtocolsConfigure` message.
 * When any type in the protocol definition has `encryptionRequired: true`,
 * `$encryption` keys are derived and injected into the protocol definition.
 */
private async installProtocol(tenant: string, agent: EnboxPlatformAgent): Promise<void> {
```

### ESLint rules summary

- Imports alphabetically sorted, type imports grouped first
- Arrow functions in callbacks need explicit return types
- Single-line if statements need curly braces
- Object properties align colons when multiple keys
- Max line length: 150 characters (strings exempted)
- Semicolons required, single quotes, trailing commas in multi-line
- `TODO` comments must reference a GitHub issue (enforced in `dwn-sdk-js` and `dwn-server` via `eslint-plugin-todo-plz`)

## Test Style

### Frameworks

All packages use **`bun test`** (`import { describe, expect, it } from 'bun:test'`). Assertions use `expect(...).toBe(...)`, `expect(...).toThrow(...)`, etc. Sinon is used for mocks/stubs in `agent` and `api` packages.

Files use `.spec.ts` suffix in all packages.

### Test structure

`describe` blocks match class/module names. Nested `describe` for method or feature groups. Test descriptions start with `should` or use short verb-phrases.

```typescript
describe('DwnKeyStore', () => {
  describe('encryption at rest', () => {
    it('should encrypt key records in the DWN and decrypts them on read', async () => { ... });
  });

  describe('encryption required — Ed25519-only agent DID rejection', () => {
    it('should throw when generating a key with an Ed25519-only agent DID', async () => { ... });
  });
});
```

### bun:test patterns (dwn-sdk-js, common, crypto, dids, etc.)

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import sinon from 'sinon';

describe('ComponentName', () => {
  beforeEach(() => { /* setup */ });
  afterAll(() => { /* cleanup */ });

  it('should do something', async () => {
    expect(result).toBe(expected);
  });

  it('should throw on invalid input', () => {
    expect(() => doSomething()).toThrow(DwnErrorCode.SomeErrorCode);
  });

  it('should reject async errors', async () => {
    await expect(asyncOperation()).rejects.toThrow('error message');
  });
});
```

### Agent test harness pattern (agent/api)

Agent tests use `PlatformAgentTestHarness` with `TestAgent`:

```typescript
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';

describe('ComponentName', () => {
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'memory',  // 'memory' for fast tests, 'dwn' for integration
      testDataLocation : '__TESTDATA__/unique-name'  // avoid LevelDB conflicts
    });
  });

  beforeEach(async () => {
    await testHarness.clearStorage();
    await testHarness.createAgentDid();  // creates did:jwk with Ed25519 + X25519
  });

  afterAll(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  it('should do something', async () => {
    const result = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
    expect(result).toBeDefined();
  });
});
```

For full agent lifecycle tests (vault + DWN stores), use `EnboxUserAgent` instead of `TestAgent`:

```typescript
import { EnboxUserAgent } from '../src/enbox-user-agent.js';

const harness = await PlatformAgentTestHarness.setup({
  agentClass  : EnboxUserAgent,
  agentStores : 'dwn',
});
await harness.agent.initialize({ password: 'test' });
await harness.agent.start({ password: 'test' });
```

### Error assertions

```typescript
expect(() => syncOperation()).toThrow(DwnErrorCode.SomeErrorCode);
await expect(asyncOperation()).rejects.toThrow('error message');
```

### Test isolation

- Use unique `testDataLocation` per describe block to avoid LevelDB lock conflicts
- Clean up in `afterEach`/`afterAll` hooks — always close LevelDB handles
- Test data via helper functions and inline construction, not fixture files

## Architecture Notes

### Two-layer encryption

1. **Layer 1 — Vault** (`HdIdentityVault`): 12-word BIP-39 seed phrase derives HD keys. Password encrypts the agent's `PortableDid` as CompactJWE (AES-256-GCM via PBKDF2). Stored in `VAULT_STORE` LevelDB. In production, `HdIdentityVault.initialize()` always creates the agent DID as `did:dht` with both Ed25519 (`#sig`) and X25519 (`#enc`).

2. **Layer 2 — DWN record-level** (`DwnKeyStore`): Records with `encryptionRequired: true` in their protocol type definition are encrypted through the DWN message `encryption` envelope: record data is encrypted with a random AES-256-CTR data key, which is wrapped (X25519-HKDF-SHA256+A256KW) to the per-protocol-path X25519 public key — plus role-audience keys where the protocol defines `$role` participants. Those per-path public keys are derived from the tenant's X25519 `#enc` key and injected as `$keyAgreement` blocks into the protocol definition at install time — if the tenant DID lacks an X25519 keyAgreement key, installation fails with no plaintext fallback.

Recovery path: seed phrase -> agent DID (deterministic) -> `#enc` key -> decrypt DWN key records.

### Store inheritance

```
AgentDataStore<T> (interface)
  DwnDataStore<T>       (base — protocol-backed DWN storage with encryption support)
    DwnKeyStore         (Jwk, JwkProtocolDefinition, encryptionRequired: true)
    DwnDidStore         (PortableDid, IdentityProtocolDefinition)
    DwnIdentityStore    (IdentityMetadata, IdentityProtocolDefinition)
  InMemoryDataStore<T>  (base — Map-backed)
    InMemoryKeyStore
    InMemoryDidStore
    InMemoryIdentityStore
```

Subclasses override: `name`, `_recordProtocolDefinition`, `_recordProperties`, `getAllRecords()`.

### Agent DID vs tenant DID

The **agent DID** (`agent.agentDid`) is the agent's own identity. The **tenant DID** is the context for store operations. Multi-tenancy is resolved via `getDataStoreTenant()` with priority: explicit tenant > agent DID > DID URI parameter. Store keys use `TENANT_SEPARATOR` (`^`).

## Browser dapp architecture

What a browser app on `@enbox/browser` must ship — the **required** service worker (`activatePolyfills()` / DRL resolution) and how to verify it actually runs, the bundler shims, the IndexedDB storage rule, and the two hosting headers that silently break Enbox flows — lives in [`docs/architecture/browser-dapps.md`](docs/architecture/browser-dapps.md). Read it before scaffolding a new browser dapp or reviewing one; the checklist at the end is the scaffold gate. The most common failure it exists to prevent: shipping without the service worker because it was miscategorized as optional PWA tooling.

## Sync engine vocabulary

The sync subsystem has a canonical vocabulary — one name per concept, one meaning per word — in [`docs/architecture/sync-vocabulary.md`](docs/architecture/sync-vocabulary.md). Read it before adding to or renaming anything in `packages/agent/src/sync-*.ts`. It also records the two splits left knowingly unconverged, and why. A synonym you find in the code is a bug in the code, not a missing entry in the table.

## SQL schema migrations

Conventions and patterns for Kysely-backed schema changes (DWN store domain + server store domain) live in [`docs/MIGRATIONS.md`](docs/MIGRATIONS.md). Read it before adding a migration, editing `packages/dwn-sql-store/src/migrations/` or `packages/dwn-server/src/migrations/`, or changing any store's `open()` / `initialize()` flow.

## Private operations

Deployment material — AWS/Terraform infrastructure, the Fly.io config, and the CI deploy pipeline — is intentionally not tracked in this public monorepo. Internal operational runbooks, Terraform modules, deployment architecture, and deploy workflows live in the private `enboxorg/enbox-internal` repository. Self-hosting the server is documented publicly in [`docs/HOSTING.md`](docs/HOSTING.md) and the docs site.

## Documentation site

Build/dev commands, MDX content layout, Fumadocs theming, and Cloudflare Pages deployment for the public docs site live in [`apps/docs/README.md`](apps/docs/README.md). Read it before editing `apps/docs/content/docs/`, changing the docs layout/theme, or debugging the docs CI workflow. The docs site is excluded from the monorepo's `bun run build`, `bun run lint`, and `bun run test:node` and uses Biome + Next.js instead.

## Related infrastructure

- **Pkarr / DHT gateway** for `did:dht` tests: `docker-compose.test.yaml` (see [`docs/TESTING.md`](docs/TESTING.md)).
- **Hosted DWN** (AWS): operational material lives in the private `enboxorg/enbox-internal` repository.
- **dwn-relay** is a **separate** repository (`enboxorg/dwn-relay`), not this monorepo.
