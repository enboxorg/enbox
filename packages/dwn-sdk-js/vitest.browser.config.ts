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
      // EventEmitterStream now uses mitt directly, but browser-level or other
      // packages in the dependency tree may still reference Node's events module.
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
      'lodash',
      'lodash/isPlainObject.js',
      'mockdate',
      'ms',
      'sinon',
      'uuid',

      // --- CJS transitive deps discovered via noDiscovery testing ---
      // ipfs / blockstore packages pull in CJS deps (err-code, etc.)
      'blockstore-core',
      'ipfs-unixfs-importer',
      'ipfs-unixfs-exporter',

      // @isaacs/ttlcache — CJS; via @enbox/crypto -> @enbox/common.
      // Use Vite's nested-dep `>` syntax to resolve through workspace symlinks.
      '@enbox/crypto > @enbox/common > @isaacs/ttlcache',

      // --- Dual-format packages (CJS default, ESM via exports) ---
      // Pre-bundling these avoids edge cases where Vite picks the CJS entry.
      '@js-temporal/polyfill',
      '@noble/ciphers/aes',
      '@noble/ciphers/chacha',
      '@noble/ciphers/crypto',
      '@noble/ciphers/utils',
      '@noble/ciphers/webcrypto',
      '@noble/curves/abstract/utils',
      '@noble/curves/ed25519',
      '@noble/curves/p256',
      '@noble/curves/secp256k1',
      '@noble/ed25519',
      '@noble/secp256k1',
      'lru-cache',
      'ulidx',
    ],
    holdUntilCrawlEnd: true,
  },
  test: {
    // Browser-compatible tests. Most are pure-logic; a few use TestStores which
    // resolve to IndexedDB-backed stores in browser mode (via level's browser
    // field). The 29 function-wrapped handler/feature/scenario tests are excluded
    // because they require the TestSuite orchestrator and would add ~978 tests.
    // See https://github.com/enboxorg/enbox/issues/236 for the full plan.
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
      'tests/utils/object.spec.ts',
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
      'tests/smt/sparse-merkle-tree.spec.ts',
      'tests/store/blockstore-mock.spec.ts',
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
      'tests/event-stream/event-emitter-stream.spec.ts',
      'tests/scenarios/aggregator.spec.ts',
    ],
    testTimeout : 15_000,
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
