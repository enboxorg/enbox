import type { EnboxTestContext } from '../src/testing.js';
import type { ConnectionSnapshot, ConnectionStore } from '../src/connection-store.js';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { createEnboxTestContext } from '../src/testing.js';
import { defineProtocol } from '../src/define-protocol.js';
import { defineStore } from '../src/store/definition.js';
import { recordCodecs } from '../src/record-codec.js';
import { createApplication, defineApplication } from '../src/store/application.js';
import { StoreNotConnectedError, StoreRetiredError } from '../src/store/scope.js';

const Protocol = defineProtocol({
  protocol  : 'https://example.com/protocols/application-stores',
  published : true,
  types     : { note: { dataFormats: ['application/json'] } },
  structure : { note: {} },
} as const, { note: recordCodecs.json<{ title: string }>() });

function controlledConnection(initial: ConnectionSnapshot): {
  connection: ConnectionStore;
  publish(snapshot: ConnectionSnapshot): void;
  disposed(): boolean;
  initialized(): boolean;
} {
  let snapshot = initial;
  let disposed = false;
  let initialized = false;
  const listeners = new Set<(state: ConnectionSnapshot) => void>();
  const current = async (): Promise<ConnectionSnapshot> => snapshot;
  const connection: ConnectionStore = {
    getSnapshot : (): ConnectionSnapshot => snapshot,
    subscribe   : (listener): (() => void) => {
      listeners.add(listener);
      return (): void => { listeners.delete(listener); };
    },
    initialize          : async (): Promise<ConnectionSnapshot> => { initialized = true; return snapshot; },
    connect             : current,
    connectVault        : current,
    refresh             : current,
    refreshDwnEndpoints : current,
    retryRemote         : current,
    disconnect          : current,
    dispose             : async (): Promise<void> => { disposed = true; listeners.clear(); },
  };
  return {
    connection,
    publish: (next): void => {
      snapshot = next;
      for (const listener of [...listeners]) { listener(next); }
    },
    disposed    : (): boolean => disposed,
    initialized : (): boolean => initialized,
  };
}

describe('headless application stores', () => {
  let context: EnboxTestContext;
  beforeAll(async (): Promise<void> => {
    context = await createEnboxTestContext({ application: defineApplication({
      stores: { notes: defineStore({ protocols: { notes: Protocol }, create: (): object => ({}) }) },
    }).manifest });
  });
  afterAll(async (): Promise<void> => { await context.close(); });

  it('collects static dependencies once and applies explicit permission policy', (): void => {
    let creates = 0;
    const base = defineStore({ protocols: { notes: Protocol }, create: (): object => { creates++; return {}; } });
    const feature = defineStore({
      protocols: { notes: Protocol }, stores: { base }, create: ({ stores }): object => stores.base,
    });
    const definition = defineApplication({
      stores: { feature }, protocols: [{ protocol: Protocol, permissions: ['read'] }],
    });
    expect(creates).toBe(0);
    expect(definition.manifest.protocols).toHaveLength(1);
    expect(definition.manifest.protocols[0].permissions).toEqual(['read']);
    expect(Object.isFrozen(definition.stores)).toBe(true);
    const conflicting = defineProtocol(Protocol.definition, Protocol.codecs);
    expect(() => defineApplication({
      stores: { base }, protocols: [conflicting],
    })).toThrow('conflicts with a store dependency');
    expect(() => defineApplication({
      stores: { base }, protocols: [Protocol, Protocol],
    })).toThrow('duplicate explicit protocol');
  });

  it('creates inert inactive handles and rejects disconnected commands', async (): Promise<void> => {
    const Notes = defineStore({ protocols : { notes: Protocol }, create    : ({ protocols }) => ({
      notes: protocols.notes.collection('note'),
    }) });
    const native = controlledConnection({ phase: 'disconnected' });
    const app = createApplication(defineApplication({ stores: { notes: Notes } }), native);
    const feature = app.store(Notes);
    expect(native.initialized()).toBe(false);
    expect(app.store(Notes)).toBe(feature);
    expect(feature.notes.getSnapshot().status).toBe('idle');
    expect(app.getServerSnapshot()).toEqual({ phase: 'initializing', vaultLocked: true });
    await expect(feature.notes.create.run({ title: 'Disconnected' })).rejects.toBeInstanceOf(StoreNotConnectedError);
    await app.initialize();
    expect(native.initialized()).toBe(true);
    await app.dispose();
    expect(native.disposed()).toBe(true);
    expect(() => app.store(Notes)).toThrow(StoreRetiredError);
  });

  it('shares real record views, preserves sync-only identity, and retires replacement scopes', async (): Promise<void> => {
    const Notes = defineStore({ protocols : { notes: Protocol }, create    : ({ protocols }) => ({
      notes: protocols.notes.collection('note'),
    }) });
    const native = controlledConnection({ phase: 'connected', enbox: context.enbox, session: context.session });
    const app = createApplication(defineApplication({ stores: { notes: Notes } }), native);
    const first = app.store(Notes);
    const release = first.notes.retain();
    await first.notes.ready();
    const record = await first.notes.create.run({ title: 'Shared canonical state' });
    expect(app.store(Notes).notes).toBe(first.notes);
    expect(first.notes.getSnapshot().records.some(row => row.record.id === record.id)).toBe(true);
    native.publish({ ...native.connection.getSnapshot(), vaultLocked: false });
    expect(app.store(Notes)).toBe(first);
    native.publish({ phase: 'connected', enbox: new Proxy(context.enbox, {}), session: context.session });
    const replacement = app.store(Notes);
    expect(replacement).not.toBe(first);
    expect(first.notes.getSnapshot().records).toHaveLength(0);
    await expect(first.notes.create.run({ title: 'Obsolete' })).rejects.toBeInstanceOf(StoreRetiredError);
    release();
    await app.dispose();
  });

  it('publishes session-abort retirement before the native snapshot changes', async (): Promise<void> => {
    const lifetime = new AbortController();
    const session = new Proxy(context.session, { get: (target, key): unknown =>
      key === 'signal' ? lifetime.signal : Reflect.get(target, key) });
    const Notes = defineStore({ protocols : { notes: Protocol }, create    : ({ protocols }) => ({
      notes: protocols.notes.collection('note'),
    }) });
    const native = controlledConnection({ phase: 'connected', enbox: context.enbox, session });
    const app = createApplication(defineApplication({ stores: { notes: Notes } }), native);
    const first = app.store(Notes);
    let changed = false;
    app.subscribe((): void => { changed = app.store(Notes) !== first; });
    lifetime.abort();
    expect(changed).toBe(true);
    expect(app.store(Notes).notes.getSnapshot().status).toBe('idle');
    await expect(app.store(Notes).notes.create.run({ title: 'Inactive' })).rejects.toBeInstanceOf(StoreNotConnectedError);
    await app.dispose();
  });

  it('closes dependents before dependencies and cleans up failed factories exactly once', async (): Promise<void> => {
    const closed: string[] = [];
    const base = defineStore({ protocols : { notes: Protocol }, create    : ({ onClose }): object => {
      onClose((): void => { closed.push('base'); }); return {};
    } });
    const feature = defineStore({ protocols : {}, stores    : { base }, create    : ({ stores, onClose }): object => {
      onClose((): void => { closed.push('feature'); }); return stores.base;
    } });
    const failed = defineStore({ protocols : {}, create    : ({ onClose }): never => {
      onClose((): void => { closed.push('failed'); }); throw new Error('Factory failed');
    } });
    const native = controlledConnection({ phase: 'disconnected' });
    const app = createApplication(defineApplication({ stores: { feature, failed } }), native);
    app.store(feature);
    expect(() => app.store(failed)).toThrow('Factory failed');
    await app.dispose();
    expect(closed.filter(value => value === 'failed')).toHaveLength(1);
    expect(closed.indexOf('feature')).toBeLessThan(closed.indexOf('base'));
  });
});
