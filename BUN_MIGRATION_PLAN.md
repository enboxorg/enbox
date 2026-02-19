# Bun Migration Plan

Full migration from Node.js/npm/pnpm to Bun as runtime, package manager, bundler, and test infrastructure.

## Decision Log

- **Runtime**: Bun replaces Node.js everywhere
- **Package Manager**: Bun replaces pnpm
- **Bundler**: esbuild retained for browser builds (Bun.build() doesn't support esbuild plugins); CJS bundles removed
- **Build Outputs**: ESM-only (CJS builds dropped)
- **better-sqlite3**: Replaced with bun:sqlite via adapter
- **level/classic-level**: Kept as-is; test under Bun's N-API compat at runtime
- **CI Workflows**: All 13 workflow files updated
- **Polyfills removed**: cross-fetch, node-fetch (Bun has native fetch)

---

## Phase 1: Package Manager & Runtime Config -- DONE
- [x] 1.1 Deleted `pnpm-workspace.yaml`, `.pnpmrc`, `pnpm-lock.yaml`
- [x] 1.2 Created `bunfig.toml`
- [x] 1.3 Updated root `package.json` (engines, removed volta, updated scripts)
- [x] 1.4 Deleted `.nvmrc`, updated `.tool-versions` to reference bun
- [x] 1.5 Deleted `packages/dwn-sql-store/.nvmrc`
- [x] 1.6 `bun install` to be run to generate `bun.lockb`

## Phase 2: Script Updates (all 13 package.json files) -- DONE
- [x] 2.1 Root package.json: `pnpm --recursive` -> `bun run --filter`
- [x] 2.2 All packages: `node build/...` -> `bun build/...`
- [x] 2.3 dwn-sdk-js: `npm run X` -> `bun run X`
- [x] 2.4 All: `npx X` -> `bunx X`
- [x] 2.5 All: Removed `c8` coverage wrapper (direct mocha/bunx mocha)
- [x] 2.6 Dropped CJS build scripts from 7 packages, deleted `tsconfig.cjs.json` files
- [x] 2.7 Removed `better-sqlite3` rebuild logic from postinstall

## Phase 3: Replace better-sqlite3 with bun:sqlite -- DONE
- [x] 3.1 Created `bun-sqlite-adapter.ts` in dwn-sql-store
- [x] 3.2 Updated `dwn-server/src/storage.ts` to use adapter
- [x] 3.3 Updated `dwn-sql-store/tests/test-dialects.ts` to use adapter
- [x] 3.4 Removed `better-sqlite3` and `@types/better-sqlite3` from all deps
- [x] 3.5 Deleted native rebuild scripts
- [x] 3.6 Removed `prebuild`, `rebuild:native`, `postinstall` from root

## Phase 4: level/classic-level -- DEFERRED TO RUNTIME
- [x] 4.1 Left as-is; will test under Bun's N-API compat at first `bun install`
- [x] 4.2 Fallback plan documented: bun:sqlite-backed AbstractLevel adapter

## Phase 5: Build System -- PARTIAL
- [x] 5.1 CJS bundle scripts deleted (6 files: `cjs-bundle.js`, `create-cjs-bundle.cjs`)
- [x] 5.2 CJS tsconfig files deleted (7 `tsconfig.cjs.json` files)
- [x] 5.3 esbuild retained for browser builds (plugin compat needed)
- [ ] 5.4 Future: migrate browser builds to Bun.build() when plugin compat improves

## Phase 6: Update Helper Scripts -- DONE
- [x] 6.1 `scripts/ci-setup.sh` -- pnpm -> bun
- [x] 6.2 `packages/dwn-server/entrypoint.sh` -- node -> bun
- [x] 6.3 `packages/dwn-sdk-js/build/publish-unstable.sh` -- npm -> bun

## Phase 7: CI/CD Workflows -- DONE
- [x] 7.1 3 root workflows updated
- [x] 7.2 5 dwn-sdk-js workflows updated (4 modified, 2 skipped - no node refs)
- [x] 7.3 3 dwn-server workflows updated (2 modified, 1 skipped - docker only)
- [x] 7.4 2 dwn-sql-store workflows updated
- [x] 7.5 npm publish kept for provenance support

## Phase 8: Docker & Deployment -- DONE
- [x] 8.1 Dockerfile: `oven/bun:1` base image, removed corepack, bun commands
- [x] 8.2 entrypoint.sh: `exec bun`
- [x] 8.3 .dockerignore: removed npm/yarn log refs
- [x] 8.4 Fly.io configs: verified no changes needed (Dockerfile builder)

## Phase 9: Cleanup & Polish -- DONE
- [x] 9.1 Removed `cross-fetch` from dwn-sdk-js deps
- [x] 9.2 Removed `node-fetch` from dwn-server deps and all test imports
- [x] 9.3 Removed `npkill` devDependency from root
- [x] 9.4 Fixed `process.env.npm_package_*` refs in dwn-server config.ts
- [x] 9.5 Added `@types/bun` to dwn-sql-store devDeps

## Phase 10: Test Framework Migration -- IN PROGRESS

Migrating from Mocha/Chai to `bun:test` across packages.

- [x] 10.1 `@enbox/common` — migrated to `bun test`
- [x] 10.2 `@enbox/crypto` — migrated to `bun test`
- [x] 10.3 `@enbox/dids` — migrated to `bun test`
- [x] 10.4 `@enbox/dwn-sdk-js` — migrated to `bun test`
- [x] 10.5 `@enbox/dwn-server` — migrated to `bun test`
- [x] 10.6 `@enbox/dwn-sql-store` — migrated to `bun test`
- [ ] 10.7 `@enbox/agent` — still uses Mocha + Chai + Sinon
- [ ] 10.8 `@enbox/api` — still uses Mocha + Chai

## Risk Register

| Risk | Severity | Status |
|------|----------|--------|
| classic-level N-API compat | HIGH | Test at runtime; fallback plan ready |
| bun:sqlite API diffs from better-sqlite3 | MEDIUM | Resolved via adapter |
| Mocha/Chai ESM loader under Bun | MEDIUM | Works; agent/api still on Mocha |
| npm publish provenance support | LOW | Kept npm for publish workflows |
| esbuild browser plugin compat | LOW | Kept esbuild for now |
