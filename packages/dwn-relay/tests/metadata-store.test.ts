import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';

import type { DataMetadataEntry } from '../src/stores/relay-data-store.js';
import { MetadataStore } from '../src/stores/metadata-store.js';

describe('MetadataStore', () => {
  let tmpDir: string;
  let store: MetadataStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'metadata-test-'));
    store = new MetadataStore(join(tmpDir, 'metadata.sqlite'));
    store.open();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeEntry(overrides: Partial<DataMetadataEntry> = {}): DataMetadataEntry {
    return {
      tenant   : 'did:test:tenant1',
      recordId : 'rec1',
      dataCid  : 'cid1',
      dataSize : 1000,
      storedAt : Date.now(),
      synced   : false,
      ...overrides,
    };
  }

  // ─── Basic CRUD ─────────────────────────────────────────────────────

  describe('put and getAll', () => {
    it('should store and retrieve a single entry', () => {
      const entry = makeEntry();
      store.put(entry);

      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].tenant).toBe('did:test:tenant1');
      expect(all[0].recordId).toBe('rec1');
      expect(all[0].dataCid).toBe('cid1');
      expect(all[0].dataSize).toBe(1000);
      expect(all[0].synced).toBe(false);
    });

    it('should store multiple entries', () => {
      store.put(makeEntry({ recordId: 'rec1', dataCid: 'cid1' }));
      store.put(makeEntry({ recordId: 'rec2', dataCid: 'cid2', dataSize: 2000 }));
      store.put(makeEntry({ tenant: 'did:test:tenant2', recordId: 'rec3', dataCid: 'cid3' }));

      const all = store.getAll();
      expect(all).toHaveLength(3);
    });

    it('should replace entry on duplicate key', () => {
      store.put(makeEntry({ dataSize: 1000 }));
      store.put(makeEntry({ dataSize: 2000 }));

      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].dataSize).toBe(2000);
    });

    it('should store and retrieve protocol metadata', () => {
      store.put(makeEntry({ protocol: 'https://example.com/chat' }));

      const all = store.getAll();
      expect(all[0].protocol).toBe('https://example.com/chat');
    });

    it('should return undefined protocol as undefined', () => {
      store.put(makeEntry());

      const all = store.getAll();
      expect(all[0].protocol).toBeUndefined();
    });
  });

  // ─── Delete ─────────────────────────────────────────────────────────

  describe('delete', () => {
    it('should remove a specific entry', () => {
      store.put(makeEntry({ recordId: 'rec1', dataCid: 'cid1' }));
      store.put(makeEntry({ recordId: 'rec2', dataCid: 'cid2' }));

      store.delete('did:test:tenant1', 'rec1', 'cid1');

      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].recordId).toBe('rec2');
    });

    it('should handle deleting non-existent entry gracefully', () => {
      store.delete('did:test:tenant1', 'nonexistent', 'cid');
      // no error
    });
  });

  // ─── Mark synced ────────────────────────────────────────────────────

  describe('markSynced', () => {
    it('should mark a specific entry as synced', () => {
      store.put(makeEntry());

      store.markSynced('did:test:tenant1', 'rec1', 'cid1');

      const all = store.getAll();
      expect(all[0].synced).toBe(true);
    });

    it('should handle marking non-existent entry gracefully', () => {
      store.markSynced('did:test:tenant1', 'nonexistent', 'cid');
      // no error
    });
  });

  // ─── Mark tenant synced ─────────────────────────────────────────────

  describe('markTenantSynced', () => {
    it('should mark all entries for a tenant as synced', () => {
      store.put(makeEntry({ recordId: 'rec1', dataCid: 'cid1' }));
      store.put(makeEntry({ recordId: 'rec2', dataCid: 'cid2' }));
      store.put(makeEntry({ tenant: 'did:test:other', recordId: 'rec3', dataCid: 'cid3' }));

      store.markTenantSynced('did:test:tenant1');

      const all = store.getAll();
      const t1 = all.filter(e => e.tenant === 'did:test:tenant1');
      const t2 = all.filter(e => e.tenant === 'did:test:other');

      expect(t1).toHaveLength(2);
      expect(t1[0].synced).toBe(true);
      expect(t1[1].synced).toBe(true);
      expect(t2).toHaveLength(1);
      expect(t2[0].synced).toBe(false);
    });
  });

  // ─── Set protocol ───────────────────────────────────────────────────

  describe('setProtocol', () => {
    it('should set protocol on an existing entry', () => {
      store.put(makeEntry());

      store.setProtocol('did:test:tenant1', 'rec1', 'cid1', 'https://example.com/media');

      const all = store.getAll();
      expect(all[0].protocol).toBe('https://example.com/media');
    });
  });

  // ─── Clear ──────────────────────────────────────────────────────────

  describe('clear', () => {
    it('should remove all entries', () => {
      store.put(makeEntry({ recordId: 'rec1', dataCid: 'cid1' }));
      store.put(makeEntry({ recordId: 'rec2', dataCid: 'cid2' }));

      store.clear();

      expect(store.getAll()).toHaveLength(0);
    });
  });

  // ─── Aggregation queries ────────────────────────────────────────────

  describe('getTotalBytes', () => {
    it('should return total bytes across all entries', () => {
      store.put(makeEntry({ recordId: 'rec1', dataCid: 'cid1', dataSize: 1000 }));
      store.put(makeEntry({ recordId: 'rec2', dataCid: 'cid2', dataSize: 2000 }));

      expect(store.getTotalBytes()).toBe(3000);
    });

    it('should return 0 when empty', () => {
      expect(store.getTotalBytes()).toBe(0);
    });
  });

  describe('getTenantBytes', () => {
    it('should return per-tenant byte totals', () => {
      store.put(makeEntry({ recordId: 'rec1', dataCid: 'cid1', dataSize: 1000 }));
      store.put(makeEntry({ recordId: 'rec2', dataCid: 'cid2', dataSize: 2000 }));
      store.put(makeEntry({ tenant: 'did:test:tenant2', recordId: 'rec3', dataCid: 'cid3', dataSize: 500 }));

      const tenantBytes = store.getTenantBytes();
      expect(tenantBytes.get('did:test:tenant1')).toBe(3000);
      expect(tenantBytes.get('did:test:tenant2')).toBe(500);
    });
  });

  // ─── Persistence across open/close ──────────────────────────────────

  describe('persistence', () => {
    it('should persist data across close/reopen', () => {
      store.put(makeEntry({ recordId: 'rec1', dataCid: 'cid1', dataSize: 1000 }));
      store.put(makeEntry({ recordId: 'rec2', dataCid: 'cid2', dataSize: 2000 }));
      store.markSynced('did:test:tenant1', 'rec1', 'cid1');

      // Close and reopen
      store.close();
      store.open();

      const all = store.getAll();
      expect(all).toHaveLength(2);

      const synced = all.find(e => e.recordId === 'rec1');
      expect(synced?.synced).toBe(true);

      const unsynced = all.find(e => e.recordId === 'rec2');
      expect(unsynced?.synced).toBe(false);
    });

    it('should persist total bytes across close/reopen', () => {
      store.put(makeEntry({ dataSize: 5000 }));

      store.close();
      store.open();

      expect(store.getTotalBytes()).toBe(5000);
    });
  });
});
