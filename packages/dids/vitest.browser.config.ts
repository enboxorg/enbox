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
    // did-dht.ts references process.env at module scope
    'process.env.DID_DHT_GATEWAY_URI': JSON.stringify(''),
  },
  resolve: {
    alias: {
      'bun:test' : resolve(__dirname, '../../testing/bun-test-shim.ts'),
      'events'   : 'eventemitter3',
    },
  },
  test: {
    include : ['tests/**/*.test.ts'],
    exclude : [
      // LevelDB is a native (Node-only) module
      'tests/resolver/resolver-cache-level.test.ts',
      // did:dht source reads process.env and the tests need a Pkarr gateway
      'tests/methods/did-dht.test.ts',
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
