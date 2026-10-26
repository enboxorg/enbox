import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import type { EnboxTestContext } from '../src/testing.js';
import type { StoreScope } from '../src/store/scope.js';

import sinon from 'sinon';
import { describe, expect, it } from 'bun:test';

import { createEnboxTestContext } from '../src/testing.js';
import { createProtocolStore } from '../src/store/protocol-store.js';
import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineProtocol } from '../src/define-protocol.js';
import { recordCodecs } from '../src/record-codec.js';
import { StoreRetiredError } from '../src/store/scope.js';

const Definition = {
  protocol  : 'https://example.com/protocols/domain-store',
  published : true,
  types     : {
    folder : { dataFormats: ['application/json'] },
    note   : { dataFormats: ['application/json'] },
  },
  structure: {
    folder : { note: {} },
    note   : {},
  },
} as const satisfies ProtocolDefinition;

const Protocol = defineProtocol(Definition, {
  folder : recordCodecs.json<{ title: string }>(),
  note   : recordCodecs.json<{ title: string; completed: boolean }>(),
});
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
    getEnbox : () => context.enbox,
    onClose  : (close): void => { closes.push(close); },
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
  it('shares inert selections and delegates materialization, mutations and pagination to native views', async () => {
    const context = await createEnboxTestContext({ application });
    const fixture = storeFixture(context);
    try {
      const notes = fixture.store.collection('note', { pagination: { limit: 1 } });
      expect(notes).toBe(fixture.store.collection('note', { pagination: { limit: 1 } }));
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
      expect(notes.getServerSnapshot().status).toBe('idle');
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
      expect(await (await fixture.store.records.read('folder/note', created.id))?.value()).toEqual({ title: 'Scoped note', completed: false });
      await first.delete.run(created.id);
      expect(await fixture.store.records.read('folder/note', created.id)).toBeUndefined();
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
      expect(await (await fixture.store.records.read('note', written.id))?.value()).toEqual({ title: 'Durably written', completed: false });
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
