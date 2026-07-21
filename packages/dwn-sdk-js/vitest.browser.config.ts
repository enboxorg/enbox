import { resolve } from 'node:path';

import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const isCI = !!process.env.CI;

// When BROWSER is set (e.g. by CI matrix), run only that browser and write
// coverage to a per-browser directory.  Otherwise run all browsers with a
// single merged coverage directory (the local-dev default).
const singleBrowser = process.env.BROWSER as 'chromium' | 'firefox' | 'webkit' | undefined;

const instances = singleBrowser
  ? [{ browser: singleBrowser }]
  : [
    { browser: 'chromium' as const },
    { browser: 'firefox' as const },
    ...(isCI ? [{ browser: 'webkit' as const }] : []),
  ];

const coverageDir = singleBrowser
  ? `./coverage-browser-${singleBrowser}`
  : './coverage-browser';

export default defineConfig({
  define: {
    'process.env' : '({})',
    'global'      : 'globalThis',
  },
  resolve: {
    alias: {
      'bun:test' : resolve(__dirname, '../../testing/bun-test-shim.ts'),
      // Polyfill Node events module for transitive dependencies that may use it.
      'events'   : 'eventemitter3',
    },
  },
  optimizeDeps: {
    // Disable automatic dependency discovery so Vite NEVER restarts the
    // optimizer mid-test-run. When Vite discovers an un-pre-bundled CJS dep
    // at runtime it restarts the optimizer; Chromium/WebKit handle restarts
    // gracefully but Firefox's strict ESM loader crashes with
    // "error loading dynamically imported module". This was the #1 source
    // of flaky Firefox CI failures (~14% of runs, random test file each time).
    //
    // With noDiscovery the optimizer only processes the explicit list below.
    // If a CJS dep is missing, the failure is immediate and deterministic
    // (not flaky), making it trivial to add the missing entry.
    noDiscovery: true,
    include: [
      // --- CJS packages imported directly from src/ or tests/ ---
      'abstract-level',
      'ajv',
      'ajv/dist/2020.js',
      'ajv/dist/runtime/ucs2length.js',
      'eventemitter3',
      'interface-store',
      'level',
      'sinon',
      'uuid',

      // --- CJS transitive deps discovered via noDiscovery testing ---
      // ipfs / blockstore packages pull in CJS deps (err-code, etc.)
      'blockstore-core',
      'ipfs-unixfs-importer',
      'ipfs-unixfs-exporter',

      // --- Dual-format packages (CJS default, ESM via exports) ---
      // Pre-bundling these avoids edge cases where Vite picks the CJS entry.
      '@noble/ciphers/aes.js',
      '@noble/ciphers/chacha.js',
      '@noble/ciphers/crypto.js',
      '@noble/ciphers/utils.js',
      '@noble/curves/ed25519.js',
      '@noble/curves/nist.js',
      '@noble/curves/secp256k1.js',
      '@noble/curves/utils.js',

      // --- Vitest coverage provider (loaded in-browser by the test runner) ---
      '@vitest/coverage-istanbul',
    ],
    holdUntilCrawlEnd: true,
  },
  test: {
    // Run test files sequentially. Multiple files (aggregator.spec.ts,
    // permissions.spec.ts) share IndexedDB state via the TestStores singleton.
    // Parallel execution causes clear() in one file to wipe data mid-test in
    // another, producing intermittent 400s and missing results — especially in
    // Firefox where IndexedDB transaction scheduling differs from Chromium.
    fileParallelism: false,
    // Browser-compatible tests. Pure-logic tests run individually; the 29
    // store-dependent handler/feature/scenario tests run via the TestSuite
    // orchestrator which injects IndexedDB-backed stores (via level's browser field).
    include: [
      'tests/utils/cid.spec.ts',
      // data-stream.spec.ts excluded: its 500KB×3 stream duplication test exceeds
      // the 15s timeout on WebKit in CI (~25s). DataStream is still covered
      // transitively by cid.spec.ts and the interfaces/ tests.
      'tests/utils/encryption.spec.ts',
      'tests/utils/encryption-callbacks.spec.ts',
      'tests/utils/filters.spec.ts',
      'tests/utils/hd-key.spec.ts',
      'tests/utils/jws.spec.ts',
      'tests/utils/memory-cache.spec.ts',
      'tests/utils/messages.spec.ts',
      // object.spec.ts removed: `@enbox/common` now owns these helpers
      // and tests them in `packages/common/tests/object.test.ts` (a
      // superset of the cases that lived here). Fuzz coverage stays in
      // `tests/fuzz/object.fuzz.spec.ts`.
      'tests/utils/private-key-signer.spec.ts',
      'tests/utils/records.spec.ts',
      'tests/utils/secp256k1.spec.ts',
      'tests/utils/secp256r1.spec.ts',
      'tests/utils/time.spec.ts',
      'tests/utils/url.spec.ts',
      'tests/validation/**/*.spec.ts',
      'tests/core/auth.spec.ts',
      'tests/core/message-reply.spec.ts',
      'tests/core/message.spec.ts',
      'tests/core/protocol-authorization.spec.ts',
      'tests/jose/jws/general.spec.ts',
      'tests/store/blockstore-mock.spec.ts',
      'tests/store/message-store-cross-context.spec.ts',
      'tests/interfaces/messages-get.spec.ts',
      'tests/interfaces/messages-subscribe.spec.ts',
      'tests/interfaces/protocols-configure.spec.ts',
      'tests/interfaces/protocols-query.spec.ts',
      'tests/interfaces/records-delete.spec.ts',
      'tests/interfaces/records-query.spec.ts',
      'tests/interfaces/records-read.spec.ts',
      'tests/interfaces/records-subscribe.spec.ts',
      'tests/interfaces/records-write.spec.ts',
      'tests/protocols/permission-grant.spec.ts',
      'tests/protocols/permission-request.spec.ts',
      'tests/protocols/permissions.spec.ts',

      'tests/scenarios/aggregator.spec.ts',

      // Store-dependent tests: 29 handler/feature/scenario test functions run via
      // the TestSuite orchestrator using level's browser package resolution.
      'tests/store-dependent-tests.spec.ts',
    ],
    testTimeout : 30_000,
    // Retry failed tests once in CI. Firefox's ESM loader can occasionally
    // crash on dynamic module imports even with noDiscovery enabled — a
    // single retry is enough to recover from transient loader failures
    // without masking real bugs (real failures are deterministic and fail both times).
    retry: isCI ? 1 : 0,
    coverage: {
      provider         : 'istanbul',
      reporter         : ['text', 'lcov'],
      reportsDirectory : coverageDir,
    },
    browser     : {
      enabled  : true,
      headless : true,
      provider : playwright(),
      instances,
    },
  },
});
