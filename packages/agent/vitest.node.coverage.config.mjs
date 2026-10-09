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
      'tests/sync-next-engine-integration.spec.ts',
      'tests/sync-next-engine.spec.ts',
      'tests/sync-next-progress-store.spec.ts',
      'tests/sync-next-pull-page-integration.spec.ts',
      'tests/sync-next-pull-page.spec.ts',
      'tests/sync-next-push-page-integration.spec.ts',
      'tests/sync-next-quarantine-retry.spec.ts',
      'tests/sync-next-runner.spec.ts',
      'tests/sync-messages.spec.ts',
      'tests/sync-role-replication-support.spec.ts',
    ],
    testTimeout : 10_000,
    coverage: {
      include: [
        'src/sync-durable-feed-reconciler.ts',
        'src/sync-link-recovery-coordinator.ts',
        'src/sync-next/engine.ts',
        'src/sync-next/progress-key.ts',
        'src/sync-next/progress-store.ts',
        'src/sync-next/pull-page.ts',
        'src/sync-next/quarantine-retry.ts',
        'src/sync-next/runner.ts',
        'src/sync-request-runner.ts',
        'src/sync-role-replication-support.ts',
        'src/sync-messages.ts',
      ],
      provider         : 'istanbul',
      reporter         : ['text', 'lcov'],
      reportsDirectory : 'coverage-branches',
    },
  },
});
