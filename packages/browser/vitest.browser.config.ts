import { resolve } from 'node:path';

import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const isCI = !!process.env.CI;

export default defineConfig({
  define: {
    'process.env.DID_DHT_GATEWAY_URI': JSON.stringify(''),
  },
  resolve: {
    alias: {
      'bun:test' : resolve(__dirname, '../../testing/bun-test-shim.ts'),
      'events'   : 'eventemitter3',
    },
  },
  test: {
    include     : ['tests/**/*.spec.ts'],
    testTimeout : 15_000,
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
