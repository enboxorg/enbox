import type { DwnApi } from '../src/dwn-api.js';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { Record } from '../src/record.js';
import type { DwnSubscriptionHandler, DwnSubscriptionMessage } from '@enbox/dwn-clients';
import type { RecordsQueryRequest, RecordsQueryResponse, RecordsSubscribeRequest, RecordsSubscribeResponse } from '../src/dwn-api.js';
import type { ReplicationLinkSnapshot, SyncEngine, SyncEvent, SyncEventListener, SyncIdentityOptions } from '@enbox/agent';

import sinon from 'sinon';

import { EnboxUserAgent } from '@enbox/agent';
import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { AuthManager, MemoryStorage } from '@enbox/auth';
import { describe, expect, it } from 'bun:test';

import { defineProtocol } from '../src/define-protocol.js';
import { DwnResponseError } from '../src/dwn-response-error.js';
import { Enbox } from '../src/enbox.js';
import { recordCodecs } from '../src/record-codec.js';
import { TypedEnbox } from '../src/typed-enbox.js';

const ViewDefinition = {
  protocol  : 'https://example.com/protocols/record-view',
  published : true,
  types     : {
    folder: {
      dataFormats : ['application/json'],
      schema      : 'https://example.com/schemas/record-view-folder',
    },
    item: {
      dataFormats : ['application/json'],
      schema      : 'https://example.com/schemas/record-view-item',
    },
    note: {
      dataFormats : ['application/json'],
      schema      : 'https://example.com/schemas/record-view-note',
    },
    section: {
      dataFormats : ['application/json'],
      schema      : 'https://example.com/schemas/record-view-section',
    },
  },
  structure: {
    folder: {
      section: {
        item: {
          $recordLimit: { max: 2 },
        },
      },
    },
    note: {
      $tags: {
        status: { type: 'string', enum: ['draft', 'published'] },
      },
    },
  },
} as const satisfies ProtocolDefinition;

const ViewProtocol = defineProtocol(ViewDefinition, {
  folder  : recordCodecs.json<{ name: string }>(),
  item    : recordCodecs.json<{ value: string }>(),
  note    : recordCodecs.json<{ title: string }>(),
  section : recordCodecs.json<{ name: string }>(),
});
const TENANT_DID = 'did:example:alice';

type QueryFactory = (request: RecordsQueryRequest, call: number) => Promise<RecordsQueryResponse>;

type ViewHarness = {
  closeCount: () => number;
  dwn: DwnApi;
  emit(message: DwnSubscriptionMessage): void;
  queryRequests: RecordsQueryRequest[];
  subscribeRequests: RecordsSubscribeRequest[];
};

function createHarness(query: QueryFactory): ViewHarness {
  const queryRequests: RecordsQueryRequest[] = [];
  const subscribeRequests: RecordsSubscribeRequest[] = [];
  let closeCalls = 0;
  let handler: DwnSubscriptionHandler | undefined;

  const dwn = {
    connectedDid : TENANT_DID,
    records      : {
      query: async (request: RecordsQueryRequest): Promise<RecordsQueryResponse> => {
        queryRequests.push(request);
        return query(request, queryRequests.length);
      },
      subscribe: async (request: RecordsSubscribeRequest) => {
        subscribeRequests.push(request);
        handler = request.subscriptionHandler;
        return {
          status       : { code: 200, detail: 'OK' },
          entries      : [],
          subscription : {
            id    : 'record-view-test',
            close : async (): Promise<void> => { closeCalls += 1; },
          },
        };
      },
    },
  } as unknown as DwnApi;

  return {
    closeCount : (): number => closeCalls,
    dwn,
    emit       : (message): void => {
      handler?.(message);
    },
    queryRequests,
    subscribeRequests,
  };
}

function createTyped(
  harness: ViewHarness,
  options: { signal?: AbortSignal; sync?: SyncEngine } = {},
): TypedEnbox<typeof ViewDefinition, typeof ViewProtocol.codecs> {
  const typed = new TypedEnbox(harness.dwn, ViewProtocol, options);
  (typed as unknown as { _configured: boolean })._configured = true;
  return typed;
}

function testRecord(id: string): Record {
  return {
    id,
    data: {
      blob   : async (): Promise<Blob> => { throw new Error('view must not read data'); },
      bytes  : async (): Promise<Uint8Array> => { throw new Error('view must not read data'); },
      json   : async (): Promise<unknown> => { throw new Error('view must not read data'); },
      stream : async (): Promise<ReadableStream> => { throw new Error('view must not read data'); },
      text   : async (): Promise<string> => { throw new Error('view must not read data'); },
    },
  } as unknown as Record;
}

function ok(records: Record[], cursor?: { messageCid: string; value: string }): RecordsQueryResponse {
  return {
    status: { code: 200, detail: 'OK' },
    records,
    cursor,
  };
}

function recordEvent(): DwnSubscriptionMessage {
  return {
    type   : 'event',
    cursor : { streamId: 'local', epoch: '1', position: '1' },
    event  : { message: { descriptor: {} } as never },
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error: unknown) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

type FakeSync = {
  emit(event: SyncEvent): void;
  listenerCount(): number;
  links: ReplicationLinkSnapshot[];
  options?: SyncIdentityOptions;
  sync: SyncEngine;
};

function createSync(): FakeSync {
  const listeners = new Set<SyncEventListener>();
  const state: FakeSync = {
    emit: (event): void => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    listenerCount : (): number => listeners.size,
    links         : [],
    options       : { protocols: [ViewDefinition.protocol] },
    sync          : undefined as unknown as SyncEngine,
  };
  state.sync = {
    getIdentityOptions  : async (): Promise<SyncIdentityOptions | undefined> => state.options,
    getReplicationLinks : async (): Promise<ReplicationLinkSnapshot[]> => state.links,
    on                  : (listener: SyncEventListener): (() => void) => {
      listeners.add(listener);
      return (): void => { listeners.delete(listener); };
    },
  } as unknown as SyncEngine;
  return state;
}

function link(
  status: ReplicationLinkSnapshot['status'],
  connectivity: ReplicationLinkSnapshot['connectivity'] = 'online',
  isPullCurrent = status === 'live',
): ReplicationLinkSnapshot {
  return {
    tenantDid      : TENANT_DID,
    remoteEndpoint : 'https://dwn.example',
    scope          : { kind: 'protocolSet', protocols: [ViewDefinition.protocol] },
    status,
    connectivity,
    isPullCurrent,
  };
}

describe('RecordView', () => {
  it('rejects invalid runtime requests before protocol readiness or subscription side effects', async () => {
    const harness = createHarness(async () => ok([]));
    const queryProtocols = sinon.stub().resolves({ status: { code: 200, detail: 'OK' }, protocols: [] });
    const configureProtocol = sinon.stub().resolves({ status: { code: 202, detail: 'Accepted' } });
    (harness.dwn as any).protocols = { configure: configureProtocol, query: queryProtocols };
    const typed = new TypedEnbox(harness.dwn, ViewProtocol);
    const observe = typed.records.observe as (
      path: 'note',
      request?: { from?: string; pagination?: { limit: number } },
    ) => Promise<unknown>;

    await expect(observe('note')).rejects.toThrow('pagination.limit is required');
    await expect(observe('note', {
      from       : 'did:example:remote',
      pagination : { limit: 10 },
    })).rejects.toThrow('remote queries are not supported');
    await expect(observe('note', {
      pagination: { limit: 0 },
    })).rejects.toThrow('pagination.limit must be a finite number greater than or equal to 1');
    expect(queryProtocols.notCalled).toBe(true);
    expect(configureProtocol.notCalled).toBe(true);
    expect(harness.queryRequests).toHaveLength(0);
    expect(harness.subscribeRequests).toHaveLength(0);
  });

  it('rejects an already-aborted session without acquiring view resources', async () => {
    const harness = createHarness(async () => ok([]));
    const fakeSync = createSync();
    const controller = new AbortController();
    const reason = new Error('session already ended');
    controller.abort(reason);
    const queryProtocols = sinon.stub().resolves({ status: { code: 200, detail: 'OK' }, protocols: [] });
    const configureProtocol = sinon.stub().resolves({ status: { code: 202, detail: 'Accepted' } });
    (harness.dwn as any).protocols = { configure: configureProtocol, query: queryProtocols };
    const typed = new TypedEnbox(harness.dwn, ViewProtocol, {
      signal : controller.signal,
      sync   : fakeSync.sync,
    });

    await expect(typed.records.observe('note', { pagination: { limit: 10 } })).rejects.toBe(reason);

    expect(queryProtocols.notCalled).toBe(true);
    expect(configureProtocol.notCalled).toBe(true);
    expect(harness.queryRequests).toHaveLength(0);
    expect(harness.subscribeRequests).toHaveLength(0);
    expect(fakeSync.listenerCount()).toBe(0);
  });

  it('installs a structural wake before querying and closes the opening race', async () => {
    let visibleRecord = testRecord('before-wake');
    const committedRecord = testRecord('after-wake');
    const harness = createHarness(async () => ok([visibleRecord]));
    const originalSubscribe = harness.dwn.records.subscribe;
    let handlerReturn: unknown;
    harness.dwn.records.subscribe = async (request): Promise<RecordsSubscribeResponse> => {
      expect(harness.queryRequests).toHaveLength(0);
      const reply = await originalSubscribe(request);
      // A local write commits before its subscription wake is delivered. The
      // opening query therefore observes that commit without a forced retry.
      visibleRecord = committedRecord;
      handlerReturn = request.subscriptionHandler(recordEvent());
      return reply;
    };

    const view = await createTyped(harness).records.observe('note', {
      filter: {
        author    : 'did:example:bob',
        published : true,
        recordId  : 'note-1',
        tags      : { status: 'draft' },
      },
      pagination : { limit: 10 },
      within     : 'root',
    });

    await waitFor(() => {
      expect(harness.queryRequests).toHaveLength(1);
      expect(view.getSnapshot().records[0]).toBe(committedRecord);
    });
    expect(handlerReturn).toBeUndefined();
    expect(harness.subscribeRequests).toHaveLength(1);
    expect(harness.subscribeRequests[0]).toMatchObject({
      filter: {
        contextId    : 'root',
        protocol     : ViewDefinition.protocol,
        protocolPath : 'note',
        recordId     : 'note-1',
      },
      pagination: { limit: 1 },
    });
    expect(harness.subscribeRequests[0].filter).not.toHaveProperty('author');
    expect(harness.subscribeRequests[0].filter).not.toHaveProperty('published');
    expect(harness.subscribeRequests[0].filter).not.toHaveProperty('tags');
    expect(harness.queryRequests[0]).toMatchObject({
      filter: {
        author       : 'did:example:bob',
        contextId    : 'root',
        protocol     : ViewDefinition.protocol,
        protocolPath : 'note',
        published    : true,
        recordId     : 'note-1',
        tags         : { status: 'draft' },
      },
      pagination: { limit: 10 },
    });
    await view.close();
  });

  it('retains its compiled selection after the caller mutates the original request', async () => {
    const harness = createHarness(async () => ok([]));
    const request = {
      filter: {
        tags: { status: 'draft' as 'draft' | 'published' },
      },
      pagination: {
        limit  : 1,
        cursor : { messageCid: 'bafy-original', value: 'original-position' },
      },
    };

    const opening = createTyped(harness).records.observe('note', request);
    request.filter.tags.status = 'published';
    request.pagination.limit = 100;
    request.pagination.cursor.messageCid = 'bafy-mutated';
    const view = await opening;
    await waitFor(() => { expect(harness.queryRequests).toHaveLength(1); });

    expect(harness.queryRequests[0]).toMatchObject({
      filter: {
        tags: { status: 'draft' },
      },
      pagination: {
        limit  : 1,
        cursor : { messageCid: 'bafy-original', value: 'original-position' },
      },
    });

    request.filter.tags.status = 'draft';
    request.pagination.cursor.value = 'another-position';
    harness.emit(recordEvent());
    await waitFor(() => { expect(harness.queryRequests).toHaveLength(2); });
    expect(harness.queryRequests[1]).toEqual(harness.queryRequests[0]);
    await view.close();
  });

  it('rematerializes when a record changes out of a mutable query predicate', async () => {
    const draft = testRecord('draft');
    const harness = createHarness(async (_request, call) => ok(call === 1 ? [draft] : []));
    const view = await createTyped(harness).records.observe('note', {
      filter     : { tags: { status: 'draft' } },
      pagination : { limit: 10 },
    });
    await waitFor(() => { expect(view.getSnapshot().records).toHaveLength(1); });

    // The broad structural subscription sees the same record after its status
    // changes to `done`; the canonical query, not the event, removes it.
    harness.emit(recordEvent());

    await waitFor(() => { expect(view.getSnapshot().records).toHaveLength(0); });
    expect(view.getSnapshot().state).toBe('ready');
    await view.close();
  });

  it('wakes a full-record limited view when sibling changes demote and promote its record', async () => {
    const target = testRecord('i1');
    const harness = createHarness(async (_request, call) => ok(call === 2 ? [] : [target]));
    const view = await createTyped(harness).records.observe('folder/section/item', {
      filter: {
        recordId: 'i1',
      },
      pagination : { limit: 1 },
      within     : 'f1/s1/i1',
    });
    await waitFor(() => { expect(view.getSnapshot().records).toHaveLength(1); });

    expect(harness.subscribeRequests[0]?.filter).toEqual({
      contextId    : 'f1/s1',
      protocol     : ViewDefinition.protocol,
      protocolPath : 'folder/section/item',
    });

    // Two earlier-ranked siblings fill the max:2 group. Their write wakes
    // this targeted view, whose canonical query now projects the target out.
    harness.emit(recordEvent());
    await waitFor(() => { expect(view.getSnapshot().records).toHaveLength(0); });

    // Deleting either occupying sibling wakes the same group and promotes
    // the still-stored target without requiring a second event for it.
    harness.emit(recordEvent());
    await waitFor(() => {
      expect(view.getSnapshot().records[0]).toBe(target);
      expect(harness.queryRequests).toHaveLength(3);
    });
    await view.close();
  });

  it('preserves direct-parent and ancestor wake scopes for limited paths', async () => {
    for (const contextId of ['f1/s1', 'f1']) {
      const harness = createHarness(async () => ok([]));
      const view = await createTyped(harness).records.observe('folder/section/item', {
        pagination : { limit: 10 },
        within     : contextId,
      });
      await waitFor(() => { expect(harness.queryRequests).toHaveLength(1); });

      expect(harness.subscribeRequests[0]?.filter).toEqual({
        contextId,
        protocol     : ViewDefinition.protocol,
        protocolPath : 'folder/section/item',
      });
      await view.close();
    }
  });

  it('coalesces a wake storm and never publishes the superseded pass', async () => {
    let releaseActive!: (response: RecordsQueryResponse) => void;
    const first = testRecord('initial');
    const stale = testRecord('stale');
    const latest = testRecord('latest');
    const harness = createHarness(async (_request, call) => {
      if (call === 1) {
        return ok([first]);
      }
      if (call === 2) {
        return new Promise<RecordsQueryResponse>((resolve) => { releaseActive = resolve; });
      }
      return ok([latest]);
    });
    const view = await createTyped(harness).records.observe('note', { pagination: { limit: 10 } });
    await waitFor(() => { expect(view.getSnapshot().state).toBe('ready'); });
    const published: string[] = [];
    view.subscribe((snapshot): void => {
      const record = snapshot.records[0];
      if (record !== undefined) {
        published.push(record.id);
      }
    });

    harness.emit(recordEvent());
    await waitFor(() => { expect(harness.queryRequests).toHaveLength(2); });
    harness.emit(recordEvent());
    harness.emit(recordEvent());
    harness.emit(recordEvent());
    releaseActive(ok([stale]));

    await waitFor(() => {
      expect(harness.queryRequests).toHaveLength(3);
      expect(view.getSnapshot().records[0]).toBe(latest);
    });
    expect(published).toEqual(['latest']);
    await view.close();
  });

  it('publishes immutable bounded snapshots without consuming record data', async () => {
    const record = testRecord('bounded');
    const harness = createHarness(async () => ok([record], { messageCid: 'next', value: '2' }));
    const view = await createTyped(harness).records.observe('note', { pagination: { limit: 1 } });

    await waitFor(() => { expect(view.getSnapshot().state).toBe('ready'); });
    const snapshot = view.getSnapshot();
    expect(snapshot.hasMore).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    expect(snapshot.records[0]).toBe(record);

    const { getSnapshot, subscribe } = view;
    let notified = false;
    const unsubscribe = subscribe((): void => { notified = true; });
    expect(getSnapshot()).toBe(snapshot);
    harness.emit(recordEvent());
    await waitFor(() => { expect(notified).toBe(true); });
    unsubscribe();
    await view.close();
  });

  it('isolates listener failures and applies listener mutations to later publications', async () => {
    const initial = testRecord('initial');
    const firstWake = testRecord('first-wake');
    const secondWake = testRecord('second-wake');
    const harness = createHarness(async (_request, call) => {
      return ok([call === 1 ? initial : call === 2 ? firstWake : secondWake]);
    });
    const view = await createTyped(harness).records.observe('note', { pagination: { limit: 10 } });
    await waitFor(() => { expect(view.getSnapshot().state).toBe('ready'); });

    const notifications: string[] = [];
    let lateListenerAdded = false;
    let unsubscribeSecond = (): void => {};
    view.subscribe((snapshot): void => {
      notifications.push(`first:${snapshot.records[0]?.id}`);
      unsubscribeSecond();
      if (!lateListenerAdded) {
        lateListenerAdded = true;
        view.subscribe((laterSnapshot): void => {
          notifications.push(`late:${laterSnapshot.records[0]?.id}`);
        });
      }
      throw new Error('consumer failed');
    });
    unsubscribeSecond = view.subscribe((snapshot): void => {
      notifications.push(`second:${snapshot.records[0]?.id}`);
    });

    harness.emit(recordEvent());
    await waitFor(() => {
      expect(harness.queryRequests).toHaveLength(2);
      expect(notifications).toEqual(['first:first-wake', 'second:first-wake']);
    });

    harness.emit(recordEvent());
    await waitFor(() => {
      expect(harness.queryRequests).toHaveLength(3);
      expect(notifications).toEqual([
        'first:first-wake',
        'second:first-wake',
        'first:second-wake',
        'late:second-wake',
      ]);
    });
    await view.close();
  });

  it('publishes an authoritatively empty bounded result with hasMore false', async () => {
    const harness = createHarness(async () => ok([]));
    const fakeSync = createSync();
    fakeSync.links = [link('live')];
    const view = await createTyped(harness, { sync: fakeSync.sync }).records.observe('note', {
      pagination: { limit: 10 },
    });

    await waitFor(() => { expect(view.getSnapshot().state).toBe('ready'); });
    expect(view.getSnapshot()).toMatchObject({ records: [], hasMore: false });
    await view.close();
  });

  it('publishes the fresh initial materialization when replication is paused', async () => {
    const local = testRecord('local-while-paused');
    const harness = createHarness(async () => ok([local], { messageCid: 'next-page', value: 'cursor' }));
    const fakeSync = createSync();
    fakeSync.links = [link('paused', 'offline')];

    const view = await createTyped(harness, { sync: fakeSync.sync }).records.observe('note', {
      pagination: { limit: 10 },
    });

    await waitFor(() => { expect(view.getSnapshot().state).toBe('error'); });
    const snapshot = view.getSnapshot();
    expect(snapshot.records[0]).toBe(local);
    expect(snapshot.hasMore).toBe(true);
    if (snapshot.state !== 'error') {
      throw new Error(`expected an error snapshot, received '${snapshot.state}'`);
    }
    expect(snapshot.error.message).toContain('replication is paused');
    await view.close();
  });

  it('publishes a fresh local materialization when a wake arrives while replication is paused', async () => {
    const initial = testRecord('initial');
    const local = testRecord('local-while-paused');
    const harness = createHarness(async (_request, call) => call === 1
      ? ok([initial])
      : ok([local], { messageCid: 'next-page', value: 'cursor' }));
    const fakeSync = createSync();
    fakeSync.links = [link('live')];
    const view = await createTyped(harness, { sync: fakeSync.sync }).records.observe('note', {
      pagination: { limit: 10 },
    });
    await waitFor(() => { expect(view.getSnapshot().state).toBe('ready'); });

    fakeSync.links = [link('paused', 'offline')];
    harness.emit(recordEvent());

    await waitFor(() => {
      expect(view.getSnapshot().state).toBe('error');
      expect(view.getSnapshot().records[0]).toBe(local);
    });
    const snapshot = view.getSnapshot();
    expect(snapshot.hasMore).toBe(true);
    if (snapshot.state !== 'error') {
      throw new Error(`expected an error snapshot, received '${snapshot.state}'`);
    }
    expect(snapshot.error.message).toContain('replication is paused');
    await view.close();
  });

  it('requires every relevant link to be live, online, and pull-current', async () => {
    const harness = createHarness(async () => ok([testRecord('local')]));
    const fakeSync = createSync();
    fakeSync.links = [
      link('live'),
      {
        ...link('live', 'online', false),
        remoteEndpoint: 'https://second-dwn.example',
      },
    ];
    const view = await createTyped(harness, { sync: fakeSync.sync }).records.observe('note', {
      pagination: { limit: 10 },
    });
    await waitFor(() => { expect(view.getSnapshot().records).toHaveLength(1); });
    expect(view.getSnapshot().state).toBe('loading');

    fakeSync.links[1] = {
      ...fakeSync.links[1],
      isPullCurrent: true,
    };
    fakeSync.emit({
      type           : 'pull:currentness-change',
      tenantDid      : TENANT_DID,
      remoteEndpoint : 'https://second-dwn.example',
      protocol       : ViewDefinition.protocol,
      protocols      : [ViewDefinition.protocol],
      from           : false,
      to             : true,
    });
    await waitFor(() => { expect(view.getSnapshot().state).toBe('ready'); });

    fakeSync.links[0] = { ...fakeSync.links[0], isPullCurrent: false };
    fakeSync.emit({
      type           : 'pull:currentness-change',
      tenantDid      : TENANT_DID,
      remoteEndpoint : 'https://dwn.example',
      protocol       : ViewDefinition.protocol,
      protocols      : [ViewDefinition.protocol],
      from           : true,
      to             : false,
    });
    expect(view.getSnapshot().state).toBe('stale');
    await view.close();
  });

  it('ignores unrelated tenants, protocols, and replication links', async () => {
    const harness = createHarness(async () => ok([testRecord('local')]));
    const fakeSync = createSync();
    fakeSync.options = { protocols: 'all' };
    fakeSync.links = [
      {
        ...link('live'),
        scope: { kind: 'full' },
      },
      {
        ...link('paused', 'offline'),
        remoteEndpoint : 'https://unrelated-dwn.example',
        scope          : { kind: 'protocolSet', protocols: ['https://example.com/protocols/unrelated'] },
      },
    ];
    const view = await createTyped(harness, { sync: fakeSync.sync }).records.observe('note', {
      pagination: { limit: 10 },
    });
    await waitFor(() => { expect(view.getSnapshot().state).toBe('ready'); });
    const initialSnapshot = view.getSnapshot();
    let publications = 0;
    view.subscribe((): void => { publications += 1; });

    fakeSync.emit({
      type           : 'link:status-change',
      tenantDid      : 'did:example:unrelated',
      remoteEndpoint : 'https://dwn.example',
      protocol       : ViewDefinition.protocol,
      protocols      : [ViewDefinition.protocol],
      from           : 'live',
      to             : 'paused',
    });
    fakeSync.emit({
      type           : 'link:status-change',
      tenantDid      : TENANT_DID,
      remoteEndpoint : 'https://unrelated-dwn.example',
      protocol       : 'https://example.com/protocols/unrelated',
      protocols      : ['https://example.com/protocols/unrelated'],
      from           : 'live',
      to             : 'paused',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.queryRequests).toHaveLength(1);
    expect(view.getSnapshot()).toBe(initialSnapshot);
    expect(publications).toBe(0);

    // Scope-less events cover full-replica links and must wake the view.
    fakeSync.emit({
      type           : 'pull:currentness-change',
      tenantDid      : TENANT_DID,
      remoteEndpoint : 'https://dwn.example',
      from           : false,
      to             : true,
    });
    await waitFor(() => {
      expect(harness.queryRequests).toHaveLength(2);
      expect(publications).toBe(1);
    });
    expect(view.getSnapshot().state).toBe('ready');
    await view.close();
  });

  it('recovers a query error on the next wake', async () => {
    const recovered = testRecord('recovered');
    const harness = createHarness(async (_request, call) => call === 1
      ? { status: { code: 500, detail: 'query failed' }, records: [] }
      : ok([recovered]));
    const view = await createTyped(harness).records.observe('note', { pagination: { limit: 10 } });
    await waitFor(() => { expect(view.getSnapshot().state).toBe('error'); });
    expect(view.getSnapshot().error).toBeInstanceOf(DwnResponseError);
    expect((view.getSnapshot().error as DwnResponseError).status).toEqual({
      code   : 500,
      detail : 'query failed',
    });

    harness.emit(recordEvent());
    await waitFor(() => {
      expect(view.getSnapshot().state).toBe('ready');
      expect(view.getSnapshot().records[0]).toBe(recovered);
    });
    await view.close();
  });

  it('publishes a terminal subscription error before closing the view', async () => {
    const harness = createHarness(async () => ok([testRecord('retained')]));
    const view = await createTyped(harness).records.observe('note', { pagination: { limit: 10 } });
    await waitFor(() => { expect(view.getSnapshot().state).toBe('ready'); });
    const published: string[] = [];
    view.subscribe((snapshot): void => { published.push(snapshot.state); });

    harness.emit({
      type   : 'error',
      cursor : { streamId: 'local', epoch: '1', position: '2' },
      error  : { code: 'GrantRevoked', detail: 'subscription authorization ended' },
    });

    await waitFor(() => { expect(harness.closeCount()).toBe(1); });
    expect(published).toEqual(['error']);
    expect(view.getSnapshot().state).toBe('error');
    expect(view.getSnapshot().records[0]?.id).toBe('retained');
    expect(view.getSnapshot().error?.message).toContain('GrantRevoked');
  });

  it('publishes one terminal error and fences an in-flight query when the session aborts', async () => {
    let release!: (response: RecordsQueryResponse) => void;
    const initial = testRecord('initial');
    const late = testRecord('late');
    const harness = createHarness(async (_request, call) => call === 1
      ? ok([initial])
      : new Promise<RecordsQueryResponse>((resolve) => { release = resolve; }));
    const abortController = new AbortController();
    const view = await createTyped(harness, { signal: abortController.signal }).records.observe('note', {
      pagination: { limit: 10 },
    });
    await waitFor(() => { expect(view.getSnapshot().state).toBe('ready'); });
    const published: string[] = [];
    view.subscribe((snapshot): void => { published.push(snapshot.state); });

    harness.emit(recordEvent());
    await waitFor(() => { expect(harness.queryRequests).toHaveLength(2); });
    const abortReason = new Error('session replaced');
    abortController.abort(abortReason);
    const abortedSnapshot = view.getSnapshot();
    expect(abortedSnapshot.state).toBe('error');
    expect(abortedSnapshot.records[0]).toBe(initial);
    expect(abortedSnapshot.error?.message).toBe('RecordView: owning session ended.');
    expect(abortedSnapshot.error?.cause).toBe(abortReason);
    expect(published).toEqual(['error']);

    await waitFor(() => { expect(harness.closeCount()).toBe(1); });
    release(ok([late]));
    await Promise.resolve();
    await Promise.resolve();

    expect(view.getSnapshot()).toBe(abortedSnapshot);
    expect(published).toEqual(['error']);
    harness.emit(recordEvent());
    expect(harness.queryRequests).toHaveLength(2);
  });

  it('rejects failed subscription setup and releases every opened lifecycle resource', async () => {
    const harness = createHarness(async () => ok([]));
    const fakeSync = createSync();
    let anomalousCloseCalls = 0;
    harness.dwn.records.subscribe = async (): Promise<RecordsSubscribeResponse> => ({
      status       : { code: 403, detail: 'grant expired' },
      subscription : {
        id    : 'unexpected-subscription',
        close : async (): Promise<void> => { anomalousCloseCalls += 1; },
      },
    });

    const opening = createTyped(harness, { sync: fakeSync.sync }).records.observe('note', {
      pagination: { limit: 10 },
    });
    await expect(opening).rejects.toBeInstanceOf(DwnResponseError);
    await opening.catch((error: unknown): void => {
      expect((error as DwnResponseError).status).toEqual({ code: 403, detail: 'grant expired' });
    });

    expect(anomalousCloseCalls).toBe(1);
    expect(fakeSync.listenerCount()).toBe(0);
    expect(harness.queryRequests).toHaveLength(0);
  });

  it('rejects an abort during subscription setup and closes a late handle', async () => {
    const harness = createHarness(async () => ok([]));
    const fakeSync = createSync();
    const abortController = new AbortController();
    let resolveSubscribe!: (reply: RecordsSubscribeResponse) => void;
    let markSubscribeStarted!: () => void;
    let closeCalls = 0;
    const subscribeStarted = new Promise<void>((resolve) => { markSubscribeStarted = resolve; });
    harness.dwn.records.subscribe = (): Promise<RecordsSubscribeResponse> => {
      markSubscribeStarted();
      return new Promise((resolve) => { resolveSubscribe = resolve; });
    };

    const observed = createTyped(harness, {
      signal : abortController.signal,
      sync   : fakeSync.sync,
    }).records.observe('note', { pagination: { limit: 10 } });
    await subscribeStarted;
    const abortReason = new Error('session replaced');
    abortController.abort(abortReason);
    resolveSubscribe({
      status       : { code: 200, detail: 'OK' },
      subscription : {
        id    : 'late-subscription',
        close : async (): Promise<void> => { closeCalls += 1; },
      },
    });

    await expect(observed).rejects.toBe(abortReason);
    expect(closeCalls).toBe(1);
    expect(fakeSync.listenerCount()).toBe(0);
    expect(harness.queryRequests).toHaveLength(0);
  });

  it('joins concurrent close callers to the same transport cleanup', async () => {
    const harness = createHarness(async () => ok([]));
    const originalSubscribe = harness.dwn.records.subscribe;
    let releaseClose!: () => void;
    let closeCalls = 0;
    harness.dwn.records.subscribe = async (request): Promise<RecordsSubscribeResponse> => {
      const reply = await originalSubscribe(request);
      reply.subscription = {
        id    : 'deferred-close',
        close : (): Promise<void> => {
          closeCalls += 1;
          return new Promise<void>((resolve) => { releaseClose = resolve; });
        },
      };
      return reply;
    };

    const view = await createTyped(harness).records.observe('note', { pagination: { limit: 10 } });
    await waitFor(() => { expect(view.getSnapshot().state).toBe('ready'); });
    const first = view.close();
    const second = view.close();
    expect(second).toBe(first);
    expect(closeCalls).toBe(1);

    let settled = false;
    void second.then((): void => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseClose();
    await first;
    expect(settled).toBe(true);
  });

  it('invalidates a local-only ready snapshot when a replication registration is added', async () => {
    let releaseRegistrationQuery!: (response: RecordsQueryResponse) => void;
    const local = testRecord('local');
    const harness = createHarness(async (_request, call) => call === 2
      ? new Promise<RecordsQueryResponse>((resolve) => { releaseRegistrationQuery = resolve; })
      : ok([local]));
    const fakeSync = createSync();
    fakeSync.options = undefined;
    const view = await createTyped(harness, { sync: fakeSync.sync }).records.observe('note', {
      pagination: { limit: 10 },
    });
    await waitFor(() => { expect(view.getSnapshot().state).toBe('ready'); });

    fakeSync.options = { protocols: [ViewDefinition.protocol] };
    fakeSync.links = [];
    fakeSync.emit({
      type      : 'identity:registration-change',
      tenantDid : TENANT_DID,
      options   : { protocols: [ViewDefinition.protocol] },
    });
    expect(view.getSnapshot().state).toBe('loading');
    await waitFor(() => { expect(harness.queryRequests).toHaveLength(2); });
    releaseRegistrationQuery(ok([local]));
    await waitFor(() => { expect(view.getSnapshot().state).toBe('loading'); });

    fakeSync.links = [link('live')];
    fakeSync.emit({
      type           : 'pull:currentness-change',
      tenantDid      : TENANT_DID,
      remoteEndpoint : 'https://dwn.example',
      protocol       : ViewDefinition.protocol,
      protocols      : [ViewDefinition.protocol],
      from           : false,
      to             : true,
    });
    await waitFor(() => { expect(view.getSnapshot().state).toBe('ready'); });
    await view.close();
  });

  it('distinguishes an unbaselined replica, a completed pull, stale links, and paused links', async () => {
    const first = testRecord('first');
    const offlineResult = testRecord('offline-local-change');
    const harness = createHarness(async (_request, call) => ok([call < 3 ? first : offlineResult]));
    const fakeSync = createSync();
    fakeSync.links = [link('live', 'unknown')];
    const view = await createTyped(harness, { sync: fakeSync.sync }).records.observe('note', {
      pagination: { limit: 10 },
    });
    await waitFor(() => {
      expect(view.getSnapshot().state).toBe('loading');
      expect(view.getSnapshot().records).toHaveLength(1);
    });
    expect(view.getSnapshot().records[0]).toBe(first);

    fakeSync.links = [link('live')];
    fakeSync.emit({
      type           : 'pull:currentness-change',
      tenantDid      : TENANT_DID,
      remoteEndpoint : 'https://dwn.example',
      protocol       : ViewDefinition.protocol,
      protocols      : [ViewDefinition.protocol],
      from           : false,
      to             : true,
    });
    await waitFor(() => { expect(view.getSnapshot().state).toBe('ready'); });
    const readyRecords = view.getSnapshot().records;

    fakeSync.links = [link('live', 'offline')];
    fakeSync.emit({
      type           : 'link:connectivity-change',
      tenantDid      : TENANT_DID,
      remoteEndpoint : 'https://dwn.example',
      protocol       : ViewDefinition.protocol,
      protocols      : [ViewDefinition.protocol],
      from           : 'online',
      to             : 'offline',
    });
    expect(view.getSnapshot().state).toBe('stale');
    expect(view.getSnapshot().records).toEqual(readyRecords);
    await waitFor(() => {
      expect(view.getSnapshot().records[0]).toBe(offlineResult);
    });
    expect(view.getSnapshot().state).toBe('stale');

    fakeSync.links = [link('paused', 'offline')];
    fakeSync.emit({
      type           : 'link:status-change',
      tenantDid      : TENANT_DID,
      remoteEndpoint : 'https://dwn.example',
      protocol       : ViewDefinition.protocol,
      protocols      : [ViewDefinition.protocol],
      from           : 'repairing',
      to             : 'paused',
    });
    await waitFor(() => { expect(view.getSnapshot().state).toBe('error'); });
    expect(view.getSnapshot().error?.message).toContain('replication is paused');
    expect(view.getSnapshot().records[0]).toBe(offlineResult);
    await view.close();
  });

  it('keeps a paused error through a following offline event while rematerialization is blocked', async () => {
    let releaseQuery!: (response: RecordsQueryResponse) => void;
    const initial = testRecord('initial');
    const localWhilePaused = testRecord('local-while-paused');
    const harness = createHarness(async (_request, call) => {
      if (call === 1) {
        return ok([initial]);
      }
      if (call === 2) {
        return new Promise<RecordsQueryResponse>((resolve) => { releaseQuery = resolve; });
      }
      return ok([localWhilePaused]);
    });
    const fakeSync = createSync();
    fakeSync.links = [link('live')];
    const view = await createTyped(harness, { sync: fakeSync.sync }).records.observe('note', {
      pagination: { limit: 10 },
    });
    await waitFor(() => { expect(view.getSnapshot().state).toBe('ready'); });

    harness.emit(recordEvent());
    await waitFor(() => { expect(harness.queryRequests).toHaveLength(2); });
    fakeSync.links = [link('paused', 'offline')];
    fakeSync.emit({
      type           : 'link:status-change',
      tenantDid      : TENANT_DID,
      remoteEndpoint : 'https://dwn.example',
      protocol       : ViewDefinition.protocol,
      protocols      : [ViewDefinition.protocol],
      from           : 'repairing',
      to             : 'paused',
    });
    const pausedSnapshot = view.getSnapshot();
    expect(pausedSnapshot.state).toBe('error');
    expect(pausedSnapshot.records[0]).toBe(initial);

    fakeSync.emit({
      type           : 'link:connectivity-change',
      tenantDid      : TENANT_DID,
      remoteEndpoint : 'https://dwn.example',
      protocol       : ViewDefinition.protocol,
      protocols      : [ViewDefinition.protocol],
      from           : 'online',
      to             : 'offline',
    });
    expect(view.getSnapshot()).toBe(pausedSnapshot);

    releaseQuery(ok([testRecord('superseded')]));
    await waitFor(() => {
      expect(view.getSnapshot().records[0]).toBe(localWhilePaused);
    });
    expect(view.getSnapshot().state).toBe('error');
    await view.close();
  });
});

describe('RecordView session lifecycle integration', () => {
  it('publishes a terminal error and fences the view when AuthManager replaces the active session', async () => {
    const platform = await PlatformAgentTestHarness.setup({
      agentClass  : EnboxUserAgent,
      agentStores : 'memory',
    });
    let auth: AuthManager | undefined;

    try {
      await platform.agent.initialize({ password: 'test-password' });
      await platform.agent.start({ password: 'test-password' });
      const firstIdentity = await platform.agent.identity.create({
        metadata  : { name: 'First' },
        didMethod : 'jwk',
      });
      const secondIdentity = await platform.agent.identity.create({
        metadata  : { name: 'Second' },
        didMethod : 'jwk',
      });
      auth = await AuthManager.create({
        agent   : platform.agent,
        storage : new MemoryStorage(),
        sync    : 'off',
      });
      const session = await auth.switchIdentity(firstIdentity.did.uri);
      const typed = Enbox.fromSession(session).using(ViewProtocol);
      await typed.configure();

      let releaseQuery!: (response: RecordsQueryResponse) => void;
      const initial = testRecord('initial');
      const late = testRecord('late');
      const queryHarness = createHarness(async (_request, call) => call === 1
        ? ok([initial])
        : new Promise((resolve) => { releaseQuery = resolve; }));
      sinon.stub(typed.dwn, 'records').get(() => queryHarness.dwn.records);

      const view = await typed.records.observe('note', { pagination: { limit: 10 } });
      await waitFor(() => { expect(view.getSnapshot().state).toBe('ready'); });
      let publications = 0;
      view.subscribe((): void => { publications += 1; });
      queryHarness.emit(recordEvent());
      await waitFor(() => { expect(queryHarness.queryRequests).toHaveLength(2); });

      const replacementSignal = (await auth.switchIdentity(secondIdentity.did.uri)).signal;

      expect(session.signal.aborted).toBe(true);
      expect(replacementSignal).not.toBe(session.signal);
      expect(replacementSignal.aborted).toBe(false);
      const abortedSnapshot = view.getSnapshot();
      expect(abortedSnapshot.state).toBe('error');
      expect(abortedSnapshot.records[0]).toBe(initial);
      expect(abortedSnapshot.error?.message).toBe('RecordView: owning session ended.');
      expect((abortedSnapshot.error?.cause as Error).name).toBe('AbortError');
      expect(publications).toBe(1);
      await waitFor(() => { expect(queryHarness.closeCount()).toBe(1); });

      releaseQuery(ok([late]));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(view.getSnapshot()).toBe(abortedSnapshot);
      expect(publications).toBe(1);
    } finally {
      await auth?.shutdown().catch((): void => {});
      sinon.restore();
      await platform.closeStorage();
    }
  });
});
