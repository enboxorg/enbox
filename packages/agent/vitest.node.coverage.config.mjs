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
      'tests/sync-durable-feed-reconciler.spec.ts',
      'tests/sync-link-recovery-coordinator.spec.ts',
      'tests/sync-next-ledger-store.spec.ts',
      'tests/sync-next-pull-page.spec.ts',
      'tests/sync-next-quarantine-codec.spec.ts',
      'tests/sync-messages.spec.ts',
    ],
    testTimeout : 10_000,
    coverage: {
      include: [
        'src/sync-durable-feed-reconciler.ts',
        'src/sync-link-recovery-coordinator.ts',
        'src/sync-next/ledger-key.ts',
        'src/sync-next/ledger-store.ts',
        'src/sync-next/pull-page.ts',
        'src/sync-next/quarantine-codec.ts',
        'src/sync-messages.ts',
      ],
      provider         : 'istanbul',
      reporter         : ['text', 'lcov'],
      reportsDirectory : 'coverage-branches',
    },
  },
});
