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
      // Polyfill Node events module for browser (used by EventEmitterStream)
      'events'   : 'eventemitter3',
    },
  },
  optimizeDeps: {
    // Pre-bundle CJS dependencies so Vite converts them to ESM upfront.
    // Without explicit inclusion, Vite may discover these mid-test-run and
    // trigger an optimizeDeps restart. Chromium and WebKit handle restarts
    // gracefully, but Firefox's strict ESM loader crashes with
    // "error loading dynamically imported module" — causing flaky CI failures.
    //
    // Only list packages that are (a) CJS or mixed-format AND (b) resolvable
    // from this package's node_modules. Entries that can't be resolved produce
    // "Failed to resolve dependency" warnings and are silently skipped.
    include: [
      // noble — CJS/dual-format, direct deps of @enbox/dwn-sdk-js
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
      // @js-temporal/polyfill — mixed CJS/ESM; its ESM entry imports jsbi (CJS).
      // Pre-bundling lets Vite convert both to ESM before Firefox loads them.
      '@js-temporal/polyfill',
      // ajv — CJS; the precompiled validators import a deep runtime subpath
      // that must also be pre-bundled (discovered mid-run otherwise).
      'ajv',
      'ajv/dist/2020.js',
      'ajv/dist/runtime/ucs2length.js',
      // @isaacs/ttlcache — CJS; transitive dep via @enbox/crypto -> @enbox/common.
      // Use Vite's nested-dep `>` syntax so Vite resolves it through the
      // workspace symlink chain rather than from this package's node_modules.
      '@enbox/crypto > @enbox/common > @isaacs/ttlcache',
      // CJS / mixed-format packages
      'eventemitter3',
      'level',
      'lodash',
      'lodash/isPlainObject.js',
      'lru-cache',
      'ms',
      'sinon',
      'ulidx',
    ],
    // Force Vite to hold the first optimization pass until ALL static imports
    // from test entry points have been crawled. This prevents the mid-run
    // discovery restarts that crash Firefox.
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
      // event-emitter-stream.spec.ts and scenarios/aggregator.spec.ts excluded:
      // both use EventEmitterStream which calls setMaxListeners() — a method
      // not provided by eventemitter3 (the browser polyfill for Node's events).
      // See https://github.com/enboxorg/enbox/issues/236 for the plan to fix.
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
