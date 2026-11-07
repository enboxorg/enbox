import { describe, expect, it } from 'bun:test';

import { createEnboxTestContext } from '../src/testing.js';
import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineModule } from '../src/define-module.js';
import { recordCodecs } from '../src/record-codec.js';

const Notebook = defineModule({
  definition: {
    module    : 'https://example.com/context-owner/notebook', published : false,
    types     : { notebook: { dataFormats: ['application/json'] }, page: { dataFormats: ['application/json'] } },
    structure : { notebook: { page: {} } },
  },
  codecs: { notebook: recordCodecs.json<{ name: string }>(), page: recordCodecs.json<{ title: string }>() },
});
const Realtime = defineModule({
  definition: {
    module    : 'https://example.com/context-owner/realtime', published : false,
    uses      : { notebook: Notebook.definition.module },
    types     : {
      live            : { dataFormats: ['application/json'], encryptionRequired: true },
      session         : { dataFormats: ['application/json'] },
      privateMetadata : { dataFormats: ['application/json'] },
    },
    structure: { page: { $ref : 'notebook:notebook/page', live : {
      $recordLimit: { max: 1 }, session: { $immutable: true },
    }, privateMetadata: {} } },
  },
  codecs: {
    live            : recordCodecs.json<{ topic: string }>(), session         : recordCodecs.json<{ peer: string }>(),
    privateMetadata : recordCodecs.json<{ value: string }>(),
  },
  dependencies: { notebook: Notebook },
});

describe('owner context module bindings', () => {
  it('binds owner-only consumer records below an exact nested root without requiring membership roles', async () => {
    const test = await createEnboxTestContext({ application: defineApplicationManifest({ modules: [Notebook, Realtime] }) });
    try {
      const notes = test.enbox.using(Notebook);
      const notebook = await notes.records.create('notebook', { data: { name: 'Notebook' } });
      const page = await notes.records.create('notebook/page', { data: { title: 'Page' }, parentContextId: notebook.contextId });
      const other = await notes.records.create('notebook/page', { data: { title: 'Other' }, parentContextId: notebook.contextId });
      const context = await notes.contexts.withModules({ realtime: Realtime }).open('notebook/page', page.contextId);
      expect('members' in context).toBe(false);
      const realtime = context.using(Realtime);
      expect(realtime.path).toBe('page');
      const live = await realtime.records.set('page/live', { data: { topic: 'first' } });
      expect(live.parentId).toBe(page.id);
      expect(live.encryption).toBeDefined();
      await realtime.records.patch('page/live', live.id, { topic: 'second' });
      const read = await realtime.records.read('page/live', { filter: { recordId: live.id } });
      expect(await read!.value()).toEqual({ topic: 'second' });
      expect(await realtime.records.count('page/live')).toBe(1);
      const metadata = await realtime.records.create('page/privateMetadata', { data: { value: 'owner only' } });
      expect(metadata.parentId).toBe(page.id);
      const peer = await realtime.records.create('page/live/session', { data: { peer: 'peer-key' }, parentContextId: live.contextId });
      expect(peer.parentId).toBe(live.id);
      await expect(realtime.records.create('page/live/session', { data: { peer: 'no-parent' } })).rejects.toThrow('direct parent context');
      await expect(realtime.records.query('page/live', { within: other.contextId })).rejects.toThrow('escape their context');
      const view = await realtime.records.observe('page/live', { materialize: true, pagination: { limit: 1 } });
      try {
        expect((await view.ready()).records[0].value).toEqual({ topic: 'second' });
        await realtime.records.set('page/live', { data: { topic: 'third' } });
        expect((await view.refresh()).records[0].value).toEqual({ topic: 'third' });
      } finally {
        await view.close();
      }
      await realtime.records.delete('page/live/session', { recordId: peer.id, within: live.contextId });
      expect(await realtime.records.count('page/live/session', { within: live.contextId })).toBe(0);
    } finally {
      await test.close();
    }
  });

});
