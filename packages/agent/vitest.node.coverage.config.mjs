import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const configDirectory = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      'bun:test': resolve(configDirectory, '../../testing/bun-test-shim.ts'),
    },
  },
  test: {
    include: [
      'tests/sync-next-*.spec.ts',
      'tests/sync-messages.spec.ts',
    ],
    testTimeout : 10_000,
    coverage: {
      include: [
        'src/sync-next/**/*.ts',
        'src/sync-messages.ts',
      ],
      provider         : 'istanbul',
      reporter         : ['text', 'lcov'],
      reportsDirectory : 'coverage-branches',
    },
  },
});
