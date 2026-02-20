import { resolve } from 'node:path';

import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const isCI = !!process.env.CI;

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
      // noble — CJS format, direct deps of @enbox/dwn-sdk-js
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
      // CJS / mixed-format packages
      'ajv',
      'ajv/dist/2020.js',
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
    // Pure-logic and utility tests that do not depend on LevelDB stores.
    // Tests using TestStores are excluded (they instantiate Level-backed stores that
    // require IndexedDB transactions which are more complex in Vitest browser mode).
    include: [
      'tests/utils/url.spec.ts',
      'tests/utils/time.spec.ts',
      'tests/utils/object.spec.ts',
      'tests/utils/memory-cache.spec.ts',
      'tests/utils/jws.spec.ts',
      'tests/utils/hd-key.spec.ts',
      'tests/utils/filters.spec.ts',
      'tests/utils/secp256k1.spec.ts',
      'tests/utils/secp256r1.spec.ts',
      'tests/utils/encryption.spec.ts',
      'tests/utils/encryption-callbacks.spec.ts',
      'tests/validation/**/*.spec.ts',
      'tests/core/auth.spec.ts',
      'tests/core/message-reply.spec.ts',
      'tests/core/message.spec.ts',
      'tests/jose/jws/general.spec.ts',
      'tests/smt/sparse-merkle-tree.spec.ts',
      'tests/interfaces/records-read.spec.ts',
      'tests/interfaces/records-query.spec.ts',
      'tests/interfaces/records-delete.spec.ts',
      'tests/interfaces/records-subscribe.spec.ts',
      'tests/interfaces/protocols-configure.spec.ts',
      'tests/interfaces/protocols-query.spec.ts',
      'tests/interfaces/messages-subscribe.spec.ts',
      'tests/interfaces/messages-get.spec.ts',
      'tests/protocols/permission-request.spec.ts',
    ],
    testTimeout : 15_000,
    coverage: {
      provider         : 'istanbul',
      reporter         : ['text', 'lcov'],
      reportsDirectory : './coverage-browser',
    },
    browser     : {
      enabled  : true,
      headless : true,
      provider : playwright(),
      instances: [
        { browser: 'chromium' },
        { browser: 'firefox' },
        ...(isCI ? [{ browser: 'webkit' as const }] : []),
      ],
    },
  },
});
