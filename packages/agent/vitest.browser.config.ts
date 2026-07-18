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
    // Disable automatic dependency discovery so that Vite NEVER restarts the
    // optimizer mid-test-run (Firefox crashes on optimizer restarts).
    // See packages/dwn-sdk-js/vitest.browser.config.ts for full explanation.
    noDiscovery: true,
    include: [
      // --- CJS packages reachable from agent browser test imports ---
      'abstract-level',
      'level',
      'ms',
    ],
    holdUntilCrawlEnd: true,
  },
  test: {
    // Only include browser-safe tests (no LevelDB, no PlatformAgentTestHarness).
    include: [
      'tests/crypto-api.spec.ts',
      'tests/sync-cross-context-lock.spec.ts',
      'tests/utils-internal.spec.ts',
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
