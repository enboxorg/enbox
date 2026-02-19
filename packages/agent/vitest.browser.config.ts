import { resolve } from 'node:path';

import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const isCI = !!process.env.CI;

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
    include: [
      '@noble/hashes/crypto',
      '@noble/hashes/utils',
      '@noble/hashes/sha256',
      '@noble/ciphers/webcrypto',
      '@noble/ciphers/crypto',
      '@noble/ciphers/chacha',
      '@noble/curves/abstract/utils',
      '@noble/curves/p256',
      '@noble/curves/ed25519',
      '@noble/curves/secp256k1',
      'multiformats',
      'multiformats/bases/base32',
      'multiformats/bases/base58',
      'multiformats/bases/base64',
      '@isaacs/ttlcache',
      'ms',
    ],
  },
  test: {
    // Only include browser-safe tests (no LevelDB, no PlatformAgentTestHarness).
    // JWE tests excluded: they transitively import `level` via dwn-sdk-js.
    include: [
      'tests/crypto-api.spec.ts',
      'tests/utils-internal.spec.ts',
      'tests/prototyping/crypto/algorithms/aes-kw.spec.ts',
      'tests/prototyping/clients/dwn-server-info-cache.spec.ts',
    ],
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
