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
    include: [
      '@noble/hashes/crypto',
      '@noble/hashes/utils',
      '@noble/hashes/sha256',
      '@noble/hashes/hkdf',
      '@noble/ciphers/aes',
      '@noble/ciphers/utils',
      '@noble/ciphers/webcrypto',
      '@noble/ciphers/crypto',
      '@noble/ciphers/chacha',
      '@noble/curves/abstract/utils',
      '@noble/curves/p256',
      '@noble/curves/ed25519',
      '@noble/curves/secp256k1',
      '@noble/secp256k1',
      '@noble/ed25519',
      'multiformats',
      'multiformats/block',
      'multiformats/cid',
      'multiformats/codecs/raw',
      'multiformats/bases/base32',
      'multiformats/bases/base58',
      'multiformats/bases/base64',
      'multiformats/hashes/sha2',
      '@ipld/dag-cbor',
      'sinon',
      'eventemitter3',
      'lodash',
      'lru-cache',
      'ulidx',
      'ajv',
      'ajv/dist/2020.js',
      'ipfs-unixfs-importer',
      'ipfs-unixfs',
      '@ipld/dag-pb',
    ],
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
