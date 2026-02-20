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
    'process.env.DID_DHT_GATEWAY_URI' : JSON.stringify(''),
    'process.env.TEST_DWN_URL'        : JSON.stringify(''),
  },
  resolve: {
    alias: {
      'bun:test' : resolve(__dirname, '../../testing/bun-test-shim.ts'),
      // Polyfill Node events module for browser (used by dwn-sdk-js)
      'events'   : 'eventemitter3',
    },
  },
  optimizeDeps: {
    // Pre-bundle CJS deps to avoid mid-run optimizeDeps restarts that crash Firefox.
    include: [
      'ms',
    ],
    holdUntilCrawlEnd: true,
  },
  test: {
    // Only include browser-safe tests (no LevelDB, no PlatformAgentTestHarness).
    // JWE tests excluded: they transitively import `level` via dwn-sdk-js.
    include: [
      'tests/crypto-api.spec.ts',
      'tests/utils-internal.spec.ts',
      'tests/prototyping/crypto/algorithms/aes-kw.spec.ts',
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
