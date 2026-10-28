import type { ApplicationRuntime } from '../src/store/application.js';

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';

import { MemoryStorage } from '@enbox/auth';

import { createApplication } from '../src/store/application.js';
import { createConnectionStore } from '../src/connection-store.js';
import { defineProtocol } from '../src/define-protocol.js';
import { defineStore } from '../src/store/definition.js';
import { recordCodecs } from '../src/record-codec.js';
import { StoreRetiredError } from '../src/store/scope.js';
import { testDwnUrl } from './utils/test-config.js';

const NotesProtocol = defineProtocol({
  protocol  : 'https://example.com/protocols/application-store-connection',
  published : false,
  types     : { note: { dataFormats: ['application/json'], encryptionRequired: true } },
  structure : { note: {} },
} as const, { note: recordCodecs.json<{ title: string }>() });

const NotesStore = defineStore({
  protocols : { notes: NotesProtocol },
  create    : ({ protocols }) => ({ notes: protocols.notes.collection('note') }),
});

describe('application stores with the native connection lifecycle', () => {
  it('connects a real vault, persists records, restores its session and retires captured stores', async (): Promise<void> => {
    const dataPath = await mkdtemp(join(tmpdir(), 'enbox-application-connection-'));
    const storage = new MemoryStorage();
    const options = {
      dataPath,
      dwnEndpoints     : [testDwnUrl],
      localDwnStrategy : 'off' as const,
      monitor          : false as const,
      password         : 'application-integration-password',
      storage,
      sync             : 'off' as const,
    };
    const application = createApplication({
      stores: { notes: NotesStore }, connection: manifest => createConnectionStore({ ...options, application: manifest }),
    });
    let restoredApplication: ApplicationRuntime | undefined;
    let releaseNotes: (() => void) | undefined;
    try {
      const inactive = application.store(NotesStore);
      expect(inactive.notes.getSnapshot().status).toBe('idle');
      const initial = await application.initialize();
      expect(initial.phase).toBe('disconnected');

      const connected = await application.connection.connectVault({ createIdentity: true });
      if (connected.phase !== 'connected') {
        throw connected.error ?? new Error('Native vault connection did not establish an application session.');
      }
      const feature = application.store(NotesStore);
      expect(feature).not.toBe(inactive);
      releaseNotes = feature.notes.retain();
      await feature.notes.ready();
      const record = await feature.notes.create.run({ title: 'Persisted through native auth' });
      const recordId = record.id;
      expect(record.encryption).toBeDefined();
      expect(feature.notes.getSnapshot().records.map(row => row.record.id)).toContain(recordId);

      const connectedDid = connected.session.did;
      await application.dispose();
      expect(connected.session.signal.aborted).toBe(true);
      expect(feature.notes.getSnapshot().records).toEqual([]);
      await expect(feature.notes.create.run({ title: 'Retired scope' })).rejects.toBeInstanceOf(StoreRetiredError);

      restoredApplication = createApplication({
        stores: { notes: NotesStore }, connection: manifest => createConnectionStore({ ...options, application: manifest }),
      });
      const restored = await restoredApplication.initialize();
      if (restored.phase !== 'connected') {
        throw restored.error ?? new Error('Native initialization did not restore the persisted session.');
      }
      expect(restored.session.did).toBe(connectedDid);
      const restoredFeature = restoredApplication.store(NotesStore);
      expect(restoredFeature).not.toBe(feature);
      const persisted = await restoredFeature.notes.ready();
      expect(persisted.records.find(row => row.record.id === recordId)?.value.title).toBe('Persisted through native auth');
      await restoredApplication.dispose();
      expect(restored.session.signal.aborted).toBe(true);
    } finally {
      releaseNotes?.();
      try {
        await restoredApplication?.dispose();
      } finally {
        try {
          await application.dispose();
        } finally {
          await rm(dataPath, { recursive: true, force: true });
        }
      }
    }
  }, 30_000);
});
