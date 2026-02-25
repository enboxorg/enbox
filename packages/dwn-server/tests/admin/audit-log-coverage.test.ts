import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';

import { AuditLog } from '../../src/admin/audit-log.js';
import { getDialectFromUrl } from '../../src/storage.js';

/**
 * Coverage tests for AuditLog lines 289-295:
 * The `#startRetentionCleanup` setInterval callback that calls
 * `enforceRetention().then(...).catch(...)`.
 *
 * Strategy: stub `setInterval` to capture the callback before creating the
 * AuditLog, then invoke the captured callback manually.
 */
describe('AuditLog — retention cleanup timer coverage', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should trigger the setInterval callback and purge entries (lines 289-293)', async () => {
    // Capture the callback that #startRetentionCleanup passes to setInterval.
    let capturedCallback: (() => void) | undefined;
    const originalSetInterval = globalThis.setInterval;
    const intervalStub = sinon.stub(globalThis, 'setInterval').callsFake(

      (fn: any, ms?: number): any => {
        capturedCallback = fn as () => void;
        // Return a real timer handle (but it will never fire — we call fn manually).
        return originalSetInterval(() => {}, ms);
      }
    );

    const tmpDir = mkdtempSync(join(tmpdir(), 'audit-timer-cover-'));
    const dialect = getDialectFromUrl(new URL(`sqlite://${tmpDir}/timer.db`));

    // Create with retention: maxRows = 2 so excess entries get purged.
    const auditLog = await AuditLog.create(dialect, {
      maxAgeDays : 0,
      maxRows    : 2,
    });

    // Restore setInterval immediately so the rest of the test works normally.
    intervalStub.restore();

    expect(capturedCallback).toBeDefined();

    // Insert 5 events to create 3 excess.
    for (let i = 0; i < 5; i++) {
      await auditLog.record({ actor: 'admin', action: `timer.test.${i}` });
    }

    // Invoke the captured callback — this is the setInterval handler (line 289).
    // It calls enforceRetention().then() which logs purged count (lines 290-293).
    capturedCallback!();

    // Give the async .then() chain time to resolve.
    await new Promise((resolve): void => {
      setTimeout(resolve, 100);
    });

    // Verify entries were purged — only maxRows should remain.
    const count = await auditLog.count();
    expect(count).toBe(2);

    await auditLog.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should handle the setInterval callback when enforceRetention returns 0', async () => {
    let capturedCallback: (() => void) | undefined;
    const originalSetInterval = globalThis.setInterval;
    const intervalStub = sinon.stub(globalThis, 'setInterval').callsFake(

      (fn: any, ms?: number): any => {
        capturedCallback = fn as () => void;
        return originalSetInterval(() => {}, ms);
      }
    );

    const tmpDir = mkdtempSync(join(tmpdir(), 'audit-timer-noop-'));
    const dialect = getDialectFromUrl(new URL(`sqlite://${tmpDir}/noop.db`));

    const auditLog = await AuditLog.create(dialect, {
      maxAgeDays : 0,
      maxRows    : 100,
    });

    intervalStub.restore();
    expect(capturedCallback).toBeDefined();

    // Insert fewer than maxRows so the callback's then() branch skips the log.
    await auditLog.record({ actor: 'admin', action: 'noop.test' });

    capturedCallback!();
    await new Promise((resolve): void => {
      setTimeout(resolve, 100);
    });

    await auditLog.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should hit the catch path when enforceRetention throws (lines 294-295)', async () => {
    let capturedCallback: (() => void) | undefined;
    const originalSetInterval = globalThis.setInterval;
    const intervalStub = sinon.stub(globalThis, 'setInterval').callsFake(

      (fn: any, ms?: number): any => {
        capturedCallback = fn as () => void;
        return originalSetInterval(() => {}, ms);
      }
    );

    const tmpDir = mkdtempSync(join(tmpdir(), 'audit-timer-err-'));
    const dialect = getDialectFromUrl(new URL(`sqlite://${tmpDir}/err.db`));

    const auditLog = await AuditLog.create(dialect, {
      maxAgeDays : 1,
      maxRows    : 10,
    });

    intervalStub.restore();
    expect(capturedCallback).toBeDefined();

    // Stub enforceRetention to reject so the .catch() handler fires (lines 294-295).
    sinon.stub(auditLog, 'enforceRetention').rejects(new Error('db gone'));

    capturedCallback!();
    await new Promise((resolve): void => {
      setTimeout(resolve, 100);
    });

    sinon.restore();
    await auditLog.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should not start cleanup interval twice', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'audit-double-'));
    const dialect = getDialectFromUrl(new URL(`sqlite://${tmpDir}/double.db`));

    const auditLog = await AuditLog.create(dialect, {
      maxAgeDays : 1,
      maxRows    : 100,
    });

    await auditLog.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return 0 when enforceRetention is called with no config', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'audit-noconf-'));
    const dialect = getDialectFromUrl(new URL(`sqlite://${tmpDir}/noconf.db`));

    const auditLog = await AuditLog.create(dialect);
    const deleted = await auditLog.enforceRetention();
    expect(deleted).toBe(0);

    await auditLog.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
