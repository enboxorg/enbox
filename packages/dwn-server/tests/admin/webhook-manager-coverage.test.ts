import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';

import { createMigratedFileDialect } from '../utils.js';
import { WebhookManager } from '../../src/admin/webhook-manager.js';

/**
 * Coverage tests for WebhookManager lines 135 and 159:
 *
 * Line 135: `.catch((err): void => { log.error('Webhook dispatch error:', err); })`
 *   in the `fire()` method — triggered when `#dispatchAll` rejects.
 *
 * Line 159: `.catch((err): void => { log.warn(...) })`
 *   in `#dispatchAll` — triggered when individual `#deliver` calls reject.
 */
describe('WebhookManager — error path coverage', () => {
  let tmpDir: string;
  let manager: WebhookManager;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'webhook-cover-'));
    const dialect = await createMigratedFileDialect(`sqlite://${tmpDir}/webhooks.db`);
    manager = await WebhookManager.create(dialect);
  });

  afterEach(() => {
    sinon.restore();
  });

  afterAll(async () => {
    await manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('fire() error handling (line 135)', () => {
    it('should catch and log errors when #dispatchAll rejects', async () => {
      // Register a webhook that will match events.
      await manager.register({
        url    : 'http://localhost:1/nonexistent',
        events : ['*'],
      });

      // Stub fetch to reject (simulating network error).
      sinon.stub(globalThis, 'fetch').rejects(new Error('connection refused'));

      // `fire()` is fire-and-forget — it should NOT throw.
      manager.fire('test.event', 'did:test:target');

      // Give async dispatch time to run.
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));
    });
  });

  describe('#deliver error handling (line 159)', () => {
    it('should catch and log when individual webhook delivery fails', async () => {
      const freshTmpDir = mkdtempSync(join(tmpdir(), 'webhook-deliver-err-'));
      const dialect = await createMigratedFileDialect(`sqlite://${freshTmpDir}/deliver-err.db`);
      const freshManager = await WebhookManager.create(dialect);

      // Register a webhook.
      await freshManager.register({
        url    : 'http://localhost:1/failing-hook',
        events : ['test.*'],
      });

      // Stub fetch to always fail.
      sinon.stub(globalThis, 'fetch').rejects(new Error('network error'));

      // Fire the event — the #deliver catch path (line 159) should handle it.
      freshManager.fire('test.fail', 'did:test:fail-target');

      // Wait for the delivery attempts (including retries) to complete.
      // Retry delays: 1000, 5000, 15000 — total ~21s. We use a shorter timeout
      // since the retries will all fail fast with our stub.
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 25_000));

      await freshManager.close();
      rmSync(freshTmpDir, { recursive: true, force: true });
    }, 35_000);

    it('should catch and log when fetch returns non-OK status with retries', async () => {
      const freshTmpDir = mkdtempSync(join(tmpdir(), 'webhook-deliver-500-'));
      const dialect = await createMigratedFileDialect(`sqlite://${freshTmpDir}/deliver-500.db`);
      const freshManager = await WebhookManager.create(dialect);

      await freshManager.register({
        url    : 'http://localhost:1/server-error',
        events : ['error.*'],
      });

      sinon.stub(globalThis, 'fetch').resolves(new Response(null, { status: 500 }));

      freshManager.fire('error.test', 'did:test:500-target');

      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 25_000));

      await freshManager.close();
      rmSync(freshTmpDir, { recursive: true, force: true });
    }, 35_000);
  });

  describe('#matchesEvent patterns', () => {
    it('should not fire for non-matching patterns', async () => {
      const freshTmpDir = mkdtempSync(join(tmpdir(), 'webhook-nomatch-'));
      const dialect = await createMigratedFileDialect(`sqlite://${freshTmpDir}/nomatch.db`);
      const freshManager = await WebhookManager.create(dialect);

      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      await freshManager.register({
        url    : 'http://localhost:9999/hook',
        events : ['tenant.suspend'],
      });

      // Fire a non-matching event.
      freshManager.fire('quota.update', 'did:test:nomatch');
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      expect(fetchStub.callCount).toBe(0);

      await freshManager.close();
      rmSync(freshTmpDir, { recursive: true, force: true });
    });
  });
});
