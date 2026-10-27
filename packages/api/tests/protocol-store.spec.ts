import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import type { EnboxTestContext } from '../src/testing.js';
import type { StoreScope } from '../src/store/scope.js';

import sinon from 'sinon';
import { describe, expect, it } from 'bun:test';

import { createApplication } from '../src/store/application.js';
import { createConnectionStore } from '../src/connection-store.js';
import { createEnboxTestContext } from '../src/testing.js';
import { createProtocolStore } from '../src/store/protocol-store.js';
import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineProtocol } from '../src/define-protocol.js';
import { defineStore } from '../src/store/definition.js';
import { recordCodecs } from '../src/record-codec.js';
import { StoreNotConnectedError, StoreRetiredError } from '../src/store/scope.js';

const Definition = {
  protocol  : 'https://example.com/protocols/domain-store',
  published : true,
  types     : {
    folder   : { dataFormats: ['application/json'] },
    note     : { dataFormats: ['application/json'] },
    settings : { dataFormats: ['application/json'] },
  },
  structure: {
    folder   : { note: {}, settings: { $recordLimit: { max: 1 } } },
    note     : {},
    settings : { $recordLimit: { max: 1 } },
  },
} as const satisfies ProtocolDefinition;

const Protocol = defineProtocol(Definition, {
  folder   : recordCodecs.json<{ title: string }>(),
  note     : recordCodecs.json<{ title: string; completed: boolean }>(),
  settings : recordCodecs.json<{ title: string }>(),
});
const OtherProtocol = defineProtocol({ ...Definition, protocol: `${Definition.protocol}/other` }, Protocol.codecs);
const application = defineApplicationManifest({ protocols: [Protocol] });

function storeFixture(context: EnboxTestContext): {
  store: ReturnType<typeof createProtocolStore<typeof Protocol>>;
  retire(): Promise<void>;
} {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([context.session.signal, lifetime.signal]);
  const closes: Array<() => void | Promise<void>> = [];
  const scope: StoreScope = {
    signal,
    assertCurrent: (): void => {
      if (signal.aborted) { throw new StoreRetiredError(); }
    },
    getEnbox : () => { scope.assertCurrent(); return context.enbox; },
    onClose  : (close): (() => void) => {
      closes.push(close);
      return (): void => {
        const index = closes.indexOf(close);
        if (index !== -1) { closes.splice(index, 1); }
      };
    },
  };
  return {
    store  : createProtocolStore(Protocol, scope),
    retire : async (): Promise<void> => {
      lifetime.abort();
      await Promise.all(closes.map(close => close()));
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) { return; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Native collection did not publish the expected records.');
}

describe('protocol stores with a real local DWN', () => {
  it('allows native access to be captured in an inactive feature factory', async () => {
    const Feature = defineStore({
      protocols: { notes: Protocol },
      create({ protocols, command }) {
        const { native } = protocols.notes;
        return { native, count: command(() => native().records.count('note')) };
      },
    });
    const app = createApplication({ stores: { notes: Feature }, connection: manifest => createConnectionStore({ application: manifest }) });
    try {
      const feature = app.store(Feature);
      expect(typeof feature.native).toBe('function');
      expect(() => feature.native()).toThrow(StoreNotConnectedError);
      await expect(feature.count.run()).rejects.toBeInstanceOf(StoreNotConnectedError);
    } finally {
      await app.dispose();
    }
  });

  it('never deletes IDs outside the collection protocol, path, or direct parent', async () => {
    const context = await createEnboxTestContext({
      application: defineApplicationManifest({ protocols: [Protocol, OtherProtocol] }),
    });
    const fixture = storeFixture(context);
    try {
      const folders = fixture.store.collection('folder');
      const notes = fixture.store.collection('note');
      const folder = await folders.create.run({ title: 'Parent' });
      const rootNote = await notes.create.run({ title: 'Root note', completed: false });
      const nested = fixture.store.collection('folder/note').within(folder.contextId);
      const child = await nested.create.run({ title: 'Child', completed: false });
      const foreign = context.enbox.using(OtherProtocol).records;
      const foreignNote = await foreign.create('note', { data: { title: 'Other protocol', completed: false } });

      await notes.delete.run(folder.id);
      await notes.delete.run(child.id);
      await notes.delete.run(foreignNote.id);
      await nested.delete.run(rootNote.id);
      await nested.delete.run(foreignNote.id);

      expect(await context.enbox.using(Protocol).records.read('folder', folder.id)).toBeDefined();
      expect(await context.enbox.using(Protocol).records.read('note', rootNote.id)).toBeDefined();
      expect(await context.enbox.using(Protocol).records.read('folder/note', child.id)).toBeDefined();
      expect(await foreign.read('note', foreignNote.id)).toBeDefined();
    } finally {
      await fixture.retire();
      await context.close();
    }
  });

  it('rejects invalid mutation IDs instead of selecting an unrelated record', async () => {
    const context = await createEnboxTestContext({ application });
    const fixture = storeFixture(context);
    try {
      const folder = await fixture.store.collection('folder').create.run({ title: 'Parent' });
      const root = fixture.store.collection('note');
      const nested = fixture.store.collection('folder/note').within(folder.contextId);
      for (const [path, collection] of [['note', root], ['folder/note', nested]] as const) {
        const first = await collection.create.run({ title: 'First', completed: false });
        const second = await collection.create.run({ title: 'Second', completed: false });
        for (const id of [undefined, '', null, false, 0, {}, []]) {
          await expect(Reflect.apply(collection.patch.run, undefined, [{ id, patch: { title: 'Wrong record changed' } }]))
            .rejects.toThrow('record ID must be a non-empty string');
          await expect(Reflect.apply(collection.delete.run, undefined, [id]))
            .rejects.toThrow('record ID must be a non-empty string');
        }
        expect(await (await context.enbox.using(Protocol).records.read(path, first.id))?.value())
          .toEqual({ title: 'First', completed: false });
        expect(await (await context.enbox.using(Protocol).records.read(path, second.id))?.value())
          .toEqual({ title: 'Second', completed: false });
      }
    } finally {
      await fixture.retire();
      await context.close();
    }
  });

  it('requires a successful scoped read before delete and skips absent records', async () => {
    const context = await createEnboxTestContext({ application });
    const fixture = storeFixture(context);
    const notes = fixture.store.collection('note');
    const dwn = context.enbox.using(Protocol).dwn;
    const records = dwn.records;
    const deleted = sinon.spy(records.delete);
    let readFailure: Error | undefined;
    const stub = sinon.stub(dwn, 'records').get(() => ({
      ...records,
      read: async (request: Parameters<typeof records.read>[0]): ReturnType<typeof records.read> => {
        if (readFailure !== undefined) { throw readFailure; }
        return records.read(request);
      },
      delete: deleted,
    }));
    try {
      const record = await notes.create.run({ title: 'Retained on read failure', completed: false });
      await notes.delete.run('missing-record');
      expect(deleted.called).toBe(false);
      readFailure = new Error('Read authorization unavailable');
      await expect(notes.delete.run(record.id)).rejects.toBe(readFailure);
      expect(notes.delete.getSnapshot().error).toBe(readFailure);
      expect(deleted.called).toBe(false);
      readFailure = undefined;
      expect(await context.enbox.using(Protocol).records.read('note', record.id)).toBeDefined();
      await notes.delete.run(record.id);
      expect(deleted.calledOnce).toBe(true);
      expect(await context.enbox.using(Protocol).records.read('note', record.id)).toBeUndefined();
    } finally {
      stub.restore();
      await fixture.retire();
      await context.close();
    }
  });

  it('rejects singleton paths instead of exposing collection create semantics', async () => {
    const context = await createEnboxTestContext({ application });
    const fixture = storeFixture(context);
    try {
      expect(() => fixture.store.collection('settings' as never)).toThrow('singleton');
      expect(() => fixture.store.collection('folder/settings' as never)).toThrow('singleton');
      const records = fixture.store.native().records;
      const first = await records.set('settings', { data: { title: 'First' } });
      const replaced = await records.set('settings', { data: { title: 'Replaced' } });
      expect(replaced.id).toBe(first.id);
      expect(await replaced.value()).toEqual({ title: 'Replaced' });
      const folder = await fixture.store.collection('folder').create.run({ title: 'Parent' });
      const child = await records.set('folder/settings', { within: folder.contextId, data: { title: 'Child' } });
      const replacedChild = await records.set('folder/settings', { within: folder.contextId, data: { title: 'Child replaced' } });
      expect(replacedChild.id).toBe(child.id);
      expect(await replacedChild.value()).toEqual({ title: 'Child replaced' });
    } finally {
      await fixture.retire();
      await context.close();
    }
  });

  it('rejects malformed loadAll values before interning bounded selections', async () => {
    const context = await createEnboxTestContext({ application });
    const fixture = storeFixture(context);
    try {
      for (const loadAll of ['yes', 1, null, [], {}]) {
        expect(() => fixture.store.collection('note', { loadAll: loadAll as never, pagination: { limit: 1 } })).toThrow(TypeError);
      }
      const notes = fixture.store.collection('note');
      for (let index = 0; index < 3; index += 1) {
        await notes.create.run({ title: `Note ${index}`, completed: false });
      }
      const bounded = fixture.store.collection('note', { pagination: { limit: 1 }, loadAll: false });
      const complete = fixture.store.collection('note', { pagination: { limit: 1 }, loadAll: true });
      expect(bounded).not.toBe(complete);
      const [boundedState, completeState] = await Promise.all([bounded.ready(), complete.ready()]);
      expect(boundedState.records).toHaveLength(1);
      expect(completeState.records).toHaveLength(3);
    } finally {
      await fixture.retire();
      await context.close();
    }
  });

  it('shares inert selections and delegates materialization, mutations and pagination to native views', async () => {
    const context = await createEnboxTestContext({ application });
    const fixture = storeFixture(context);
    try {
      const notes = fixture.store.collection('note', { pagination: { limit: 1 } });
      expect(notes).toBe(fixture.store.collection('note', { pagination: { limit: 1 } }));
      const defaults = fixture.store.collection('note');
      expect(defaults).toBe(fixture.store.collection('note', { filter: {} }));
      expect(defaults).toBe(fixture.store.collection('note', { loadAll: false, pagination: { limit: 20 }, filter: {} }));
      expect(fixture.store.collection('note', { filter: { recordId: 'record', published: true } })).toBe(
        fixture.store.collection('note', { pagination: { limit: 20 }, filter: { published: true, recordId: 'record' } }),
      );
      expect(notes.getSnapshot().status).toBe('idle');
      const release = notes.retain();
      await notes.ready();
      const first = await notes.create.run({ title: 'First', completed: false });
      expect(notes.getSnapshot().records.some(row => row.record.id === first.id)).toBe(true);
      const second = await notes.create.run({ title: 'Second', completed: false });
      await waitFor(() => notes.getSnapshot().records.length === 1 && notes.getSnapshot().hasMore);
      expect(notes.getSnapshot().records[0].record.id).toBe(first.id);
      await notes.loadMore();
      expect(notes.getSnapshot().records).toHaveLength(2);
      expect(notes.getSnapshot().records.map(row => row.record.id)).toContain(second.id);

      await notes.patch.run({ id: first.id, patch: { completed: true } });
      expect(notes.getSnapshot().records.some(row => row.record.id === first.id && row.value.completed)).toBe(true);
      await notes.delete.run(first.id);
      expect(notes.getSnapshot().records).toHaveLength(1);
      expect(notes.getSnapshot().records[0].record.id).toBe(second.id);
      release();
      expect(notes.getSnapshot().status).toBe('idle');
    } finally {
      await fixture.retire();
      await context.close();
    }
  });

  it('shares command progress across read windows and refreshes every active selection after writes', async () => {
    const context = await createEnboxTestContext({ application });
    const fixture = storeFixture(context);
    try {
      const short = fixture.store.collection('note', { pagination: { limit: 1 } });
      const longer = fixture.store.collection('note', { pagination: { limit: 10 } });
      expect(short).not.toBe(longer);
      expect(short.create).toBe(longer.create);
      expect(short.patch).toBe(longer.patch);
      expect(short.delete).toBe(longer.delete);
      const releaseShort = short.retain();
      const releaseLonger = longer.retain();
      await Promise.all([short.ready(), longer.ready()]);
      await short.create.run({ title: 'Visible immediately', completed: false });
      expect(short.getSnapshot().records).toHaveLength(1);
      expect(longer.getSnapshot().records).toHaveLength(1);
      releaseShort();
      releaseLonger();
    } finally {
      await fixture.retire();
      await context.close();
    }
  });

  it('requires direct parent scope and rejects mutation of a sibling collection', async () => {
    const context = await createEnboxTestContext({ application });
    const fixture = storeFixture(context);
    try {
      const firstFolder = await fixture.store.collection('folder').create.run({ title: 'First folder' });
      const secondFolder = await fixture.store.collection('folder').create.run({ title: 'Second folder' });
      const family = fixture.store.collection('folder/note');
      const first = family.within(firstFolder.contextId);
      const second = family.within(secondFolder.contextId);
      expect(first).toBe(family.within(firstFolder.contextId));
      expect(first).not.toBe(second);
      expect(() => family.within(`${firstFolder.contextId}/child`)).toThrow();
      const created = await first.create.run({ title: 'Scoped note', completed: false });
      expect(created.contextId.split('/').slice(0, -1).join('/')).toBe(firstFolder.contextId);
      await expect(second.patch.run({ id: created.id, patch: { title: 'Wrong parent' } })).rejects.toThrow('another parent context');
      await expect(second.delete.run(created.id)).rejects.toThrow('another parent context');
      expect(await (await fixture.store.native().records.read('folder/note', created.id))?.value()).toEqual({ title: 'Scoped note', completed: false });
      await first.delete.run(created.id);
      expect(await fixture.store.native().records.read('folder/note', created.id)).toBeUndefined();
    } finally {
      await fixture.retire();
      await context.close();
    }
  });

  it('does not retarget captured commands after the authorization scope closes', async () => {
    const context = await createEnboxTestContext({ application });
    const fixture = storeFixture(context);
    try {
      const notes = fixture.store.collection('note');
      await fixture.retire();
      await expect(notes.create.run({ title: 'Stale', completed: false })).rejects.toBeInstanceOf(StoreRetiredError);
      expect(await context.enbox.using(Protocol).records.count('note')).toBe(0);
    } finally { await context.close(); }
  });

  it('keeps committed writes successful when the subsequent canonical reread fails', async () => {
    const context = await createEnboxTestContext({ application });
    const fixture = storeFixture(context);
    const notes = fixture.store.collection('note');
    const release = notes.retain();
    let restore = (): void => {};
    try {
      await notes.ready();
      const dwn = context.enbox.using(Protocol).dwn;
      const records = dwn.records;
      const failure = new Error('Local query unavailable');
      const stub = sinon.stub(dwn, 'records').get(() => ({
        ...records,
        query: async (): Promise<never> => { throw failure; },
      }));
      restore = (): void => { stub.restore(); };
      const written = await notes.create.run({ title: 'Durably written', completed: false });
      expect(notes.getSnapshot().status).toBe('error');
      expect(notes.getSnapshot().error).toBe(failure);
      expect(notes.create.getSnapshot().error).toBeUndefined();
      expect(await (await fixture.store.native().records.read('note', written.id))?.value()).toEqual({ title: 'Durably written', completed: false });
      restore();
      await notes.retry();
      await notes.ready();
      expect(notes.getSnapshot().records[0].record.id).toBe(written.id);
    } finally {
      restore();
      release();
      await fixture.retire();
      await context.close();
    }
  });
});
