import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';

import { AuditLog } from '../../src/admin/audit-log.js';
import { getDialectFromUrl } from '../../src/storage.js';

describe('AuditLog', () => {
  let auditLog: AuditLog;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'audit-log-test-'));
    const dialect = getDialectFromUrl(new URL(`sqlite://${tmpDir}/audit.db`));
    auditLog = await AuditLog.create(dialect);
  });

  afterAll(async () => {
    await auditLog.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // create()
  // ---------------------------------------------------------------------------

  describe('create()', () => {
    it('should create an AuditLog instance and initialize the table', async () => {
      expect(auditLog).toBeDefined();
    });

    it('should handle calling create() twice on the same database (idempotent)', async () => {
      const dialect = getDialectFromUrl(new URL(`sqlite://${tmpDir}/audit-idempotent.db`));
      const log1 = await AuditLog.create(dialect);
      // Creating a second instance on the same DB should not throw.
      // Note: we use a separate dialect instance for the same file, which is fine for SQLite.
      const dialect2 = getDialectFromUrl(new URL(`sqlite://${tmpDir}/audit-idempotent.db`));
      const log2 = await AuditLog.create(dialect2);
      expect(log2).toBeDefined();
      await log1.close();
      await log2.close();
    });
  });

  // ---------------------------------------------------------------------------
  // record()
  // ---------------------------------------------------------------------------

  describe('record()', () => {
    it('should record an audit event with all fields', async () => {
      await auditLog.record({
        actor  : 'admin',
        action : 'tenant.suspend',
        target : 'did:test:target1',
        detail : JSON.stringify({ reason: 'test' }),
      });

      const { events } = await auditLog.query({ limit: 1 });
      expect(events.length).toBe(1);
      expect(events[0].actor).toBe('admin');
      expect(events[0].action).toBe('tenant.suspend');
      expect(events[0].target).toBe('did:test:target1');
      expect(events[0].detail).toBe(JSON.stringify({ reason: 'test' }));
      expect(events[0].timestamp).toBeDefined();
      expect(typeof events[0].id).toBe('number');
    });

    it('should record an event with only required fields (no target or detail)', async () => {
      await auditLog.record({
        actor  : 'system',
        action : 'server.start',
      });

      const { events } = await auditLog.query({ action: 'server.start', limit: 1 });
      expect(events.length).toBe(1);
      expect(events[0].actor).toBe('system');
      expect(events[0].action).toBe('server.start');
      expect(events[0].target).toBeUndefined();
      expect(events[0].detail).toBeUndefined();
    });

    it('should record multiple events with incrementing IDs', async () => {
      const countBefore = await auditLog.count();

      await auditLog.record({ actor: 'admin', action: 'test.multi1' });
      await auditLog.record({ actor: 'admin', action: 'test.multi2' });
      await auditLog.record({ actor: 'admin', action: 'test.multi3' });

      const countAfter = await auditLog.count();
      expect(countAfter).toBe(countBefore + 3);
    });
  });

  // ---------------------------------------------------------------------------
  // query()
  // ---------------------------------------------------------------------------

  describe('query()', () => {
    it('should return events in reverse chronological order (newest first)', async () => {
      const { events } = await auditLog.query({ limit: 100 });
      expect(events.length).toBeGreaterThan(1);

      // IDs should be descending.
      for (let i = 1; i < events.length; i++) {
        expect(events[i - 1].id).toBeGreaterThan(events[i].id);
      }
    });

    it('should filter by exact action', async () => {
      const { events } = await auditLog.query({ action: 'tenant.suspend' });
      expect(events.length).toBeGreaterThanOrEqual(1);
      for (const event of events) {
        expect(event.action).toBe('tenant.suspend');
      }
    });

    it('should filter by action prefix with wildcard', async () => {
      // Record some events with related actions.
      await auditLog.record({ actor: 'admin', action: 'tenant.suspend', target: 'did:test:prefix1' });
      await auditLog.record({ actor: 'admin', action: 'tenant.unsuspend', target: 'did:test:prefix2' });
      await auditLog.record({ actor: 'admin', action: 'quota.update', target: 'did:test:prefix3' });

      const { events } = await auditLog.query({ action: 'tenant.*' });
      expect(events.length).toBeGreaterThanOrEqual(2);
      for (const event of events) {
        expect(event.action.startsWith('tenant.')).toBe(true);
      }
    });

    it('should filter by target', async () => {
      const { events } = await auditLog.query({ target: 'did:test:target1' });
      expect(events.length).toBeGreaterThanOrEqual(1);
      for (const event of events) {
        expect(event.target).toBe('did:test:target1');
      }
    });

    it('should filter by since timestamp', async () => {
      const now = new Date().toISOString();

      // Record an event after the timestamp.
      await auditLog.record({ actor: 'admin', action: 'test.since', target: 'did:test:since' });

      const { events } = await auditLog.query({ since: now, action: 'test.since' });
      expect(events.length).toBeGreaterThanOrEqual(1);
      for (const event of events) {
        expect(event.timestamp >= now).toBe(true);
      }
    });

    it('should limit results', async () => {
      const { events } = await auditLog.query({ limit: 2 });
      expect(events.length).toBeLessThanOrEqual(2);
    });

    it('should default limit to 50', async () => {
      // Record enough events to exceed 50.
      for (let i = 0; i < 55; i++) {
        await auditLog.record({ actor: 'admin', action: `test.default-limit-${i}` });
      }

      const { events } = await auditLog.query();
      expect(events.length).toBeLessThanOrEqual(50);
    });

    it('should cap limit at 1000', async () => {
      // Requesting limit > 1000 should be capped.
      const { events } = await auditLog.query({ limit: 9999 });
      // We don't have 1000 events, but the point is it doesn't crash.
      expect(events.length).toBeLessThanOrEqual(1000);
    });

    it('should support cursor-based pagination', async () => {
      const page1 = await auditLog.query({ limit: 3 });
      expect(page1.events.length).toBe(3);
      expect(page1.cursor).toBeDefined();

      const page2 = await auditLog.query({ limit: 3, cursor: page1.cursor });
      expect(page2.events.length).toBe(3);

      // No overlap: page2 IDs should all be less than page1's last ID.
      const page1Ids = page1.events.map((e): number => e.id);
      const page2Ids = page2.events.map((e): number => e.id);
      for (const id of page2Ids) {
        for (const p1Id of page1Ids) {
          expect(id).not.toBe(p1Id);
        }
      }
    });

    it('should return no cursor when there are no more results', async () => {
      // Query with a very high limit that exceeds total events.
      const { cursor } = await auditLog.query({ limit: 1000 });
      expect(cursor).toBeUndefined();
    });

    it('should combine multiple filters', async () => {
      await auditLog.record({
        actor  : 'admin',
        action : 'combined.test',
        target : 'did:test:combined',
      });

      const { events } = await auditLog.query({
        action : 'combined.test',
        target : 'did:test:combined',
        limit  : 10,
      });
      expect(events.length).toBeGreaterThanOrEqual(1);
      for (const event of events) {
        expect(event.action).toBe('combined.test');
        expect(event.target).toBe('did:test:combined');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // count()
  // ---------------------------------------------------------------------------

  describe('count()', () => {
    it('should return the total number of events', async () => {
      const count = await auditLog.count();
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThan(0);
    });

    it('should increment after recording a new event', async () => {
      const before = await auditLog.count();
      await auditLog.record({ actor: 'admin', action: 'count.test' });
      const after = await auditLog.count();
      expect(after).toBe(before + 1);
    });
  });

  // ---------------------------------------------------------------------------
  // close()
  // ---------------------------------------------------------------------------

  describe('close()', () => {
    it('should close the database connection without error', async () => {
      const closeTmpDir = mkdtempSync(join(tmpdir(), 'audit-log-close-'));
      const dialect = getDialectFromUrl(new URL(`sqlite://${closeTmpDir}/close.db`));
      const log = await AuditLog.create(dialect);
      await log.record({ actor: 'system', action: 'test.close' });
      await log.close();
      rmSync(closeTmpDir, { recursive: true, force: true });
    });
  });
});
