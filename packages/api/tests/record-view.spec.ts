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

import { compileRecordQuery } from '../src/record-query.js';
import { ContextRetiredError } from '../src/context-errors.js';
import { createRecordView } from '../src/record-view.js';
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
    label: {
      dataFormats: ['text/plain'],
    },
    note: {
      dataFormats : ['application/json'],
      schema      : 'https://example.com/schemas/record-view-note',
    },
    preference: {
      dataFormats: ['text/plain'],
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
      label: {
        $recordLimit: { max: 1 },
      },
    },
    preference: {
      $recordLimit: { max: 1 },
    },
  },
} as const satisfies ProtocolDefinition;

const ViewProtocol = defineProtocol(ViewDefinition, {
  folder     : recordCodecs.json<{ name: string }>(),
  item       : recordCodecs.json<{ value: string }>(),
  label      : recordCodecs.text(),
  note       : recordCodecs.json<{ title: string }>(),
  preference : recordCodecs.text(),
  section    : recordCodecs.json<{ name: string }>(),
});
const TENANT_DID = 'did:example:alice';

type QueryFactory = (request: RecordsQueryRequest, call: number) => Promise<RecordsQueryResponse>;

type ViewHarness = {
  closeCount: () => number;
  dwn: DwnApi;
  emit(message: DwnSubscriptionMessage, subscriptionIndex?: number): void;
  queryRequests: RecordsQueryRequest[];
  subscribeRequests: RecordsSubscribeRequest[];
};

function createHarness(query: QueryFactory): ViewHarness {
  const queryRequests: RecordsQueryRequest[] = [];
  const subscribeRequests: RecordsSubscribeRequest[] = [];
  let closeCalls = 0;
  const handlers: DwnSubscriptionHandler[] = [];
  const runQuery = async (request: RecordsQueryRequest): Promise<RecordsQueryResponse> => {
    queryRequests.push(request);
    return query(request, queryRequests.length);
  };

  const dwn = {
    connectedDid                  : TENANT_DID,
    followedContextId             : undefined,
    followedSourceId              : undefined,
    queryRecordsWithRequiredGrant : runQuery,
    recordTenantDid               : TENANT_DID,
    records                       : {
      query     : runQuery,
      subscribe : async (request: RecordsSubscribeRequest) => {
        subscribeRequests.push(request);
        handlers.push(request.subscriptionHandler);
        return {
          status       : { code: 200, detail: 'OK' },
          entries      : [],
          subscription : {
            id    : `record-view-test-${handlers.length}`,
            close : async (): Promise<void> => { closeCalls += 1; },
          },
        };
      },
    },
  } as unknown as DwnApi;

  return {
    closeCount : (): number => closeCalls,
    dwn,
    emit       : (message, subscriptionIndex = 0): void => {
      void handlers[subscriptionIndex]?.(message);
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

function decodedRecord(id: string, value: unknown, parentId?: string): Record {
  return {
    id,
    parentId,
    value: async (): Promise<unknown> => value,
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
      request?: {
        from?: string;
        materialize?: unknown;
        pagination?: { limit: number };
      },
    ) => Promise<unknown>;
    const query = typed.records.query as (
      path: 'note',
      request?: { materialize?: unknown; pagination?: { limit: number } },
    ) => Promise<unknown>;
    const set = typed.records.set as unknown as (
      path: string,
      request: { data: unknown; from?: string; protocolRole?: string },
    ) => Promise<unknown>;
    const nestedItemPath = 'folder/section/item';

    await expect(observe('note')).rejects.toThrow('pagination.limit is required');
    await expect(observe('note', {
      pagination: { limit: 0 },
    })).rejects.toThrow('pagination.limit must be a finite number greater than or equal to 1');
    await expect(query('note', { materialize: true }))
      .rejects.toThrow('pagination.limit is required to bound decoded values');
    await expect(observe('note', {
      materialize : null,
      pagination  : { limit: 10 },
    })).rejects.toThrow('children must be a non-empty array');
    await expect(observe('note', {
      materialize : { children: [] },
      pagination  : { limit: 10 },
    })).rejects.toThrow('children must be a non-empty array');
    await expect(observe('note', {
      materialize : { children: [nestedItemPath, nestedItemPath] },
      pagination  : { limit: 10 },
    })).rejects.toThrow('children must contain unique protocol paths');
    await expect(observe('note', {
      materialize : { children: [nestedItemPath] },
      pagination  : { limit: 10 },
    })).rejects.toThrow('must be a direct child of \'note\' with $recordLimit.max: 1');
    await expect(set('note', { data: { title: 'not a singleton' } }))
      .rejects.toThrow('path \'note\' must declare $recordLimit.max: 1');
    await expect(set('preference', {
      data : 'dark',
      from : 'did:example:remote',
    })).rejects.toThrow('remote targets are not supported');
    await expect(set('preference', {
      data         : 'dark',
      protocolRole : 'member',
    })).rejects.toThrow('protocol roles are not supported');
    expect(queryProtocols.notCalled).toBe(true);
    expect(configureProtocol.notCalled).toBe(true);
    expect(harness.queryRequests).toHaveLength(0);
    expect(harness.subscribeRequests).toHaveLength(0);
  });

  it('uses a grant-required selection query before treating an empty singleton scope as authoritative', async () => {
    const harness = createHarness(async () => ok([]));
    const missingGrant = new Error('matching Records.Read grant was not found');
    const queryRecordsWithRequiredGrant = sinon.stub().rejects(missingGrant);
    Object.defineProperty(harness.dwn, 'queryRecordsWithRequiredGrant', {
      value: queryRecordsWithRequiredGrant,
    });
    const typed = createTyped(harness);

    await expect(typed.records.set('preference', { data: 'dark' })).rejects.toBe(missingGrant);
    expect(queryRecordsWithRequiredGrant.calledOnce).toBe(true);
    expect(queryRecordsWithRequiredGrant.firstCall.args[0]).toMatchObject({
      filter: {
        protocol     : ViewDefinition.protocol,
        protocolPath : 'preference',
      },
      pagination: { limit: 1 },
    });
    expect(harness.queryRequests).toHaveLength(0);
  });

  it('uses the nested singleton context for the grant-required selection query', async () => {
    const harness = createHarness(async () => ok([]));
    const missingGrant = new Error('matching Records.Read grant was not found');
    const queryRecordsWithRequiredGrant = sinon.stub().rejects(missingGrant);
    Object.defineProperty(harness.dwn, 'queryRecordsWithRequiredGrant', {
      value: queryRecordsWithRequiredGrant,
    });
    const typed = createTyped(harness);

    await expect(typed.records.set('note/label', {
      data   : 'important',
      within : 'notecontext',
    })).rejects.toBe(missingGrant);
    expect(queryRecordsWithRequiredGrant.calledOnce).toBe(true);
    expect(queryRecordsWithRequiredGrant.firstCall.args[0]).toMatchObject({
      filter: {
        contextId    : 'notecontext',
        protocol     : ViewDefinition.protocol,
        protocolPath : 'note/label',
      },
      pagination: { limit: 1 },
    });
  });

  it('forwards the source and protocol role to a batched child materialization query', async () => {
    const parent = decodedRecord('note-1', { title: 'First' });
    const child = decodedRecord('label-1', 'important', parent.id);
    const harness = createHarness(async (_request, call) => ok(call === 1 ? [parent] : [child]));
    const typed = createTyped(harness);

    const page = await typed.records.query('note', {
      from         : 'did:example:remote',
      materialize  : { children: ['note/label'] as const },
      pagination   : { limit: 10 },
      protocolRole : 'member',
    });

    expect(page.records[0]?.children.label?.value).toBe('important');
    expect(harness.queryRequests[1]).toMatchObject({
      from         : 'did:example:remote',
      protocolRole : 'member',
      filter       : {
        parentId     : [parent.id],
        protocolPath : 'note/label',
      },
    });
  });

  it('observes and materializes a foreign tenant through the remote query and subscription paths', async () => {
    const remoteDid = 'did:example:remote';
    const parent = decodedRecord('note-1', { title: 'First' });
    const child = decodedRecord('label-1', 'important', parent.id);
    const harness = createHarness(async (_request, call) => ok(call % 2 === 1 ? [parent] : [child]));
    const fakeSync = createSync();
    fakeSync.links = [link('paused', 'offline')];

    const view = await createTyped(harness, { sync: fakeSync.sync }).records.observe('note', {
      from         : remoteDid,
      materialize  : { children: ['note/label'] as const },
      pagination   : { limit: 10 },
      protocolRole : 'member',
      within       : 'root',
    });

    await waitFor(() => { expect(view.getState().status).toBe('ready'); });
    expect(view.getState().records[0]?.children.label?.value).toBe('important');
    expect(fakeSync.listenerCount()).toBe(0);
    expect(harness.subscribeRequests).toHaveLength(2);
    for (const request of harness.subscribeRequests) {
      expect(request).toMatchObject({
        from         : remoteDid,
        protocolRole : 'member',
      });
    }
    expect(harness.queryRequests).toHaveLength(2);
    for (const request of harness.queryRequests) {
      expect(request).toMatchObject({
        from         : remoteDid,
        protocolRole : 'member',
      });
    }

    harness.emit(recordEvent(), 1);
    await waitFor(() => { expect(harness.queryRequests).toHaveLength(4); });
    await view.close();
  });

  it('resolves a locally materialized result before replication becomes current', async () => {
    const cached = testRecord('cached');
    const harness = createHarness(async () => ok([cached]));
    const fakeSync = createSync();
    fakeSync.links = [link('initializing', 'online', false)];
    const view = await createTyped(harness, { sync: fakeSync.sync }).records.observe('note', {
      pagination: { limit: 10 },
    });

    const state = await view.ready();

    expect(state).toBe(view.getState());
    expect(state).toMatchObject({ status: 'ready', current: false });
    expect(state.records).toEqual([cached]);
    await view.close();
  });

  it('makes an empty local result usable before replication becomes current', async () => {
    const harness = createHarness(async () => ok([]));
    const fakeSync = createSync();
    fakeSync.links = [link('initializing', 'online', false)];
    const view = await createTyped(harness, { sync: fakeSync.sync }).records.observe('note', {
      pagination: { limit: 10 },
    });
    const state = await view.ready();
    expect(state).toMatchObject({ status: 'ready', current: false, records: [] });

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

    await waitFor(() => { expect(view.getState().current).toBe(true); });
    expect(view.getState()).toMatchObject({ status: 'ready', current: true, records: [], hasMore: false });
    await view.close();
  });

  it('rejects a usable-state waiter on a published error or caller abort', async () => {
    const failedHarness = createHarness(async () => ({
      status  : { code: 500, detail: 'query failed' },
      records : [],
    }));
    const failedView = await createTyped(failedHarness).records.observe('note', {
      pagination: { limit: 10 },
    });
    await expect(failedView.ready()).rejects.toBeInstanceOf(DwnResponseError);
    await failedView.close();

    let finishQuery!: (response: RecordsQueryResponse) => void;
    const pendingHarness = createHarness(() => new Promise((resolve) => { finishQuery = resolve; }));
    const pendingView = await createTyped(pendingHarness).records.observe('note', {
      pagination: { limit: 10 },
    });
    const alreadyAborted = new AbortController();
    const earlyReason = new Error('consumer was already stopped');
    alreadyAborted.abort(earlyReason);
    await expect(pendingView.ready({ signal: alreadyAborted.signal })).rejects.toBe(earlyReason);

    const controller = new AbortController();
    const reason = new Error('consumer stopped waiting');
    const pending = pendingView.ready({ signal: controller.signal });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    finishQuery(ok([]));
    await pendingView.close();
  });

  it('rejects a usable-state waiter when the view closes', async () => {
    let finishQuery!: (response: RecordsQueryResponse) => void;
    const harness = createHarness(() => new Promise((resolve) => { finishQuery = resolve; }));
    const view = await createTyped(harness).records.observe('note', {
      pagination: { limit: 10 },
    });
    const pending = view.ready();

    await view.close();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    finishQuery(ok([]));
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
      expect(view.getState().records[0]).toBe(committedRecord);
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

  it('installs every exact dependency wake before querying and rematerializes on a child-only wake', async () => {
    const initial = testRecord('initial');
    const updated = testRecord('updated');
    const harness = createHarness(async (_request, call) => {
      expect(harness.subscribeRequests).toHaveLength(2);
      return ok([call === 1 ? initial : updated]);
    });
    const materializeRecords = sinon.stub().callsFake(async (records: Record[]): Promise<readonly string[]> => {
      return records.map((record): string => record.id);
    });

    const view = await createRecordView<string>({
      additionalWakeFilters: [{
        contextId    : 'folder-1',
        protocol     : ViewDefinition.protocol,
        protocolPath : 'folder/section/item',
      }],
      definition : ViewDefinition,
      dwn        : harness.dwn,
      materializeRecords,
      query      : compileRecordQuery(ViewDefinition, 'note', { pagination: { limit: 10 } }),
    });
    await waitFor(() => { expect(view.getState().records).toEqual(['initial']); });

    expect(harness.subscribeRequests.map((request) => request.filter)).toEqual([
      {
        protocol     : ViewDefinition.protocol,
        protocolPath : 'note',
      },
      {
        contextId    : 'folder-1',
        protocol     : ViewDefinition.protocol,
        protocolPath : 'folder/section/item',
      },
    ]);

    harness.emit(recordEvent(), 1);
    await waitFor(() => { expect(view.getState().records).toEqual(['updated']); });
    expect(materializeRecords.callCount).toBe(2);

    await view.close();
    expect(harness.closeCount()).toBe(2);
  });

  it('keeps the prior state when page materialization fails and recovers on the next wake', async () => {
    const retained = testRecord('retained');
    const rejected = testRecord('rejected');
    const recovered = testRecord('recovered');
    const harness = createHarness(async (_request, call) => {
      if (call === 1) {
        return ok([retained], { messageCid: 'next', value: '1' });
      }
      return ok([call === 2 ? rejected : recovered]);
    });
    const materializationError = new Error('codec rejected the page');
    let materializationCount = 0;
    const view = await createRecordView<string>({
      definition         : ViewDefinition,
      dwn                : harness.dwn,
      materializeRecords : async (records): Promise<readonly string[]> => {
        materializationCount += 1;
        if (materializationCount === 2) {
          throw materializationError;
        }
        return records.map((record): string => record.id);
      },
      query: compileRecordQuery(ViewDefinition, 'note', { pagination: { limit: 10 } }),
    });
    await waitFor(() => { expect(view.getState().records).toEqual(['retained']); });

    harness.emit(recordEvent());
    await waitFor(() => { expect(view.getState().status).toBe('error'); });
    expect(view.getState()).toMatchObject({
      records : ['retained'],
      hasMore : true,
      error   : materializationError,
    });

    harness.emit(recordEvent());
    await waitFor(() => {
      expect(view.getState()).toMatchObject({ status: 'ready', records: ['recovered'], hasMore: false });
    });
    await view.close();
  });

  it('fences a slow materialization after a newer wake requests another generation', async () => {
    const initial = testRecord('initial');
    const stale = testRecord('stale');
    const latest = testRecord('latest');
    const harness = createHarness(async (_request, call) => ok([call === 1 ? initial : call === 2 ? stale : latest]));
    let releaseStale!: () => void;
    let markStaleStarted!: () => void;
    const staleStarted = new Promise<void>((resolve) => { markStaleStarted = resolve; });
    const materializeRecords = async (records: Record[]): Promise<readonly string[]> => {
      if (records[0]?.id === 'stale') {
        markStaleStarted();
        await new Promise<void>((resolve) => { releaseStale = resolve; });
      }
      return records.map((record): string => record.id);
    };
    const view = await createRecordView<string>({
      definition : ViewDefinition,
      dwn        : harness.dwn,
      materializeRecords,
      query      : compileRecordQuery(ViewDefinition, 'note', { pagination: { limit: 10 } }),
    });
    await waitFor(() => { expect(view.getState().records).toEqual(['initial']); });
    const publications: string[] = [];
    view.subscribe((state): void => {
      if (state.records[0] !== undefined) {
        publications.push(state.records[0]);
      }
    });

    harness.emit(recordEvent());
    await staleStarted;
    harness.emit(recordEvent());
    releaseStale();

    await waitFor(() => { expect(view.getState().records).toEqual(['latest']); });
    expect(publications).toEqual(['latest']);
    await view.close();
  });

  it('retains its compiled selection after the caller mutates the original request', async () => {
    const harness = createHarness(async () => ok([]));
    const request = {
      filter: {
        tags: { status: 'draft' as 'draft' | 'published' },
      },
      pagination: {
        limit: 1,
      },
    };

    const opening = createTyped(harness).records.observe('note', request);
    request.filter.tags.status = 'published';
    request.pagination.limit = 100;
    const view = await opening;
    await waitFor(() => { expect(harness.queryRequests).toHaveLength(1); });

    expect(harness.queryRequests[0]).toMatchObject({
      filter: {
        tags: { status: 'draft' },
      },
      pagination: {
        limit: 1,
      },
    });

    request.filter.tags.status = 'draft';
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
    await waitFor(() => { expect(view.getState().records).toHaveLength(1); });

    // The broad structural subscription sees the same record after its status
    // changes to `done`; the canonical query, not the event, removes it.
    harness.emit(recordEvent());

    await waitFor(() => { expect(view.getState().records).toHaveLength(0); });
    expect(view.getState().status).toBe('ready');
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
    await waitFor(() => { expect(view.getState().records).toHaveLength(1); });

    expect(harness.subscribeRequests[0]?.filter).toEqual({
      contextId    : 'f1/s1',
      protocol     : ViewDefinition.protocol,
      protocolPath : 'folder/section/item',
    });

    // Two earlier-ranked siblings fill the max:2 group. Their write wakes
    // this targeted view, whose canonical query now projects the target out.
    harness.emit(recordEvent());
    await waitFor(() => { expect(view.getState().records).toHaveLength(0); });

    // Deleting either occupying sibling wakes the same group and promotes
    // the still-stored target without requiring a second event for it.
    harness.emit(recordEvent());
    await waitFor(() => {
      expect(view.getState().records[0]).toBe(target);
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
    await waitFor(() => { expect(view.getState().status).toBe('ready'); });
    const published: string[] = [];
    view.subscribe((state): void => {
      const record = state.records[0];
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
      expect(view.getState().records[0]).toBe(latest);
    });
    expect(published).toEqual(['latest']);
    await view.close();
  });

  it('publishes immutable bounded states without consuming record data', async () => {
    const record = testRecord('bounded');
    const harness = createHarness(async () => ok([record], { messageCid: 'next', value: '2' }));
    const view = await createTyped(harness).records.observe('note', { pagination: { limit: 1 } });

    await waitFor(() => { expect(view.getState().status).toBe('ready'); });
    const state = view.getState();
    expect(state.hasMore).toBe(true);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.records)).toBe(true);
    expect(state.records[0]).toBe(record);

    const { getState, subscribe } = view;
    let notified = false;
    const unsubscribe = subscribe((): void => { notified = true; });
    expect(getState()).toBe(state);
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
    await waitFor(() => { expect(view.getState().status).toBe('ready'); });

    const notifications: string[] = [];
    let lateListenerAdded = false;
    let unsubscribeSecond = (): void => {};
    view.subscribe((state): void => {
      notifications.push(`first:${state.records[0]?.id}`);
      unsubscribeSecond();
      if (!lateListenerAdded) {
        lateListenerAdded = true;
        view.subscribe((laterState): void => {
          notifications.push(`late:${laterState.records[0]?.id}`);
        });
      }
      throw new Error('consumer failed');
    });
    unsubscribeSecond = view.subscribe((state): void => {
      notifications.push(`second:${state.records[0]?.id}`);
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

    await waitFor(() => { expect(view.getState().status).toBe('ready'); });
    expect(view.getState()).toMatchObject({ records: [], hasMore: false });
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

    await waitFor(() => { expect(view.getState().status).toBe('error'); });
    const state = view.getState();
    expect(state.records[0]).toBe(local);
    expect(state.hasMore).toBe(true);
    if (state.status !== 'error') {
      throw new Error(`expected an error state, received '${state.status}'`);
    }
    expect(state.error.message).toContain('replication is paused');
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
    await waitFor(() => { expect(view.getState().status).toBe('ready'); });

    fakeSync.links = [link('paused', 'offline')];
    harness.emit(recordEvent());

    await waitFor(() => {
      expect(view.getState().status).toBe('error');
      expect(view.getState().records[0]).toBe(local);
    });
    const state = view.getState();
    expect(state.hasMore).toBe(true);
    if (state.status !== 'error') {
      throw new Error(`expected an error state, received '${state.status}'`);
    }
    expect(state.error.message).toContain('replication is paused');
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
    await waitFor(() => { expect(view.getState().records).toHaveLength(1); });
    expect(view.getState()).toMatchObject({ status: 'ready', current: false });

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
    await waitFor(() => { expect(view.getState()).toMatchObject({ status: 'ready', current: true }); });

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
    await waitFor(() => { expect(view.getState()).toMatchObject({ status: 'ready', current: false }); });
    await view.close();
  });

  it('projects currentness from the exact followed context instead of the connected tenant', async () => {
    const sourceDid = 'did:example:source';
    const contextId = 'sharedRoot';
    const harness = createHarness(async () => ok([testRecord('shared')]));
    Object.assign(harness.dwn, {
      followedContextId : contextId,
      followedSourceId  : 'current-role',
      recordTenantDid   : sourceDid,
    });
    const fakeSync = createSync();
    fakeSync.options = undefined;
    fakeSync.links = [{
      tenantDid      : sourceDid,
      remoteEndpoint : 'https://source-dwn.example',
      scope          : {
        kind          : 'context',
        protocol      : ViewDefinition.protocol,
        contextId,
        protocolPaths : ['note'],
      },
      status           : 'live',
      connectivity     : 'online',
      followedSourceId : 'current-role',
      isPullCurrent    : true,
    }, {
      tenantDid      : sourceDid,
      remoteEndpoint : 'https://old-source-dwn.example',
      scope          : {
        kind          : 'context',
        protocol      : ViewDefinition.protocol,
        contextId,
        protocolPaths : ['note'],
      },
      status           : 'paused',
      connectivity     : 'offline',
      followedSourceId : 'old-role',
      isPullCurrent    : false,
    }, {
      ...link('paused', 'offline'),
      tenantDid      : TENANT_DID,
      remoteEndpoint : 'https://member-dwn.example',
    }];
    const view = await createRecordView<string>({
      definition         : ViewDefinition,
      dwn                : harness.dwn,
      materializeRecords : async (records): Promise<readonly string[]> => records.map(record => record.id),
      query              : compileRecordQuery(ViewDefinition, 'note', {
        from       : sourceDid,
        pagination : { limit: 10 },
        within     : contextId,
      }),
      sync: fakeSync.sync,
    });
    await waitFor(() => { expect(view.getState().status).toBe('ready'); });

    fakeSync.emit({
      type           : 'pull:currentness-change',
      tenantDid      : sourceDid,
      remoteEndpoint : 'https://sibling-dwn.example',
      protocol       : ViewDefinition.protocol,
      protocols      : [ViewDefinition.protocol],
      contextId      : 'siblingRoot',
      from           : true,
      to             : false,
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.queryRequests).toHaveLength(1);

    fakeSync.links[0] = { ...fakeSync.links[0], isPullCurrent: false };
    fakeSync.emit({
      type           : 'pull:currentness-change',
      tenantDid      : sourceDid,
      remoteEndpoint : 'https://source-dwn.example',
      protocol       : ViewDefinition.protocol,
      protocols      : [ViewDefinition.protocol],
      contextId,
      from           : true,
      to             : false,
    });
    await waitFor(() => { expect(view.getState()).toMatchObject({ status: 'ready', current: false }); });
    await view.close();
  });

  it('publishes ContextRetiredError when a followed-context acceptance changes', async () => {
    const sourceDid = 'did:example:source';
    const contextId = 'sharedRoot';
    const harness = createHarness(async () => ok([testRecord('shared')]));
    Object.assign(harness.dwn, {
      followedContextId          : contextId,
      followedSourceAcceptanceId : 'acceptance-a',
      followedSourceId           : 'current-role',
      recordTenantDid            : sourceDid,
    });
    const fakeSync = createSync();
    fakeSync.links = [{
      connectivity     : 'online',
      followedSourceId : 'current-role',
      isPullCurrent    : true,
      remoteEndpoint   : 'https://source-dwn.example',
      scope            : {
        kind          : 'context',
        contextId,
        protocol      : ViewDefinition.protocol,
        protocolPaths : ['note'],
      },
      status    : 'live',
      tenantDid : sourceDid,
    }];
    const view = await createRecordView<string>({
      definition         : ViewDefinition,
      dwn                : harness.dwn,
      materializeRecords : async (records): Promise<readonly string[]> => records.map(record => record.id),
      query              : compileRecordQuery(ViewDefinition, 'note', {
        from       : sourceDid,
        pagination : { limit: 10 },
        within     : contextId,
      }),
      sync: fakeSync.sync,
    });
    await waitFor(() => { expect(view.getState().status).toBe('ready'); });

    fakeSync.emit({
      type                       : 'followed-context:change',
      actorDid                   : TENANT_DID,
      contextId,
      followedSourceAcceptanceId : 'acceptance-b',
      followedSourceId           : 'current-role',
      protocol                   : ViewDefinition.protocol,
      tenantDid                  : sourceDid,
    });

    await waitFor(() => { expect(view.getState().status).toBe('error'); });
    expect(view.getState().error).toBeInstanceOf(ContextRetiredError);
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
    await waitFor(() => { expect(view.getState().status).toBe('ready'); });
    const initialState = view.getState();
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
    expect(view.getState()).toBe(initialState);
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
    expect(view.getState().status).toBe('ready');
    await view.close();
  });

  it('recovers a query error on the next wake', async () => {
    const recovered = testRecord('recovered');
    const harness = createHarness(async (_request, call) => call === 1
      ? { status: { code: 500, detail: 'query failed' }, records: [] }
      : ok([recovered]));
    const view = await createTyped(harness).records.observe('note', { pagination: { limit: 10 } });
    await waitFor(() => { expect(view.getState().status).toBe('error'); });
    expect(view.getState().error).toBeInstanceOf(DwnResponseError);
    expect((view.getState().error as DwnResponseError).status).toEqual({
      code   : 500,
      detail : 'query failed',
    });

    harness.emit(recordEvent());
    await waitFor(() => {
      expect(view.getState().status).toBe('ready');
      expect(view.getState().records[0]).toBe(recovered);
    });
    await view.close();
  });

  it('publishes a terminal subscription error before closing the view', async () => {
    const harness = createHarness(async () => ok([testRecord('retained')]));
    const view = await createTyped(harness).records.observe('note', { pagination: { limit: 10 } });
    await waitFor(() => { expect(view.getState().status).toBe('ready'); });
    const published: string[] = [];
    view.subscribe((state): void => { published.push(state.status); });

    harness.emit({
      type   : 'error',
      cursor : { streamId: 'local', epoch: '1', position: '2' },
      error  : { code: 'GrantRevoked', detail: 'subscription authorization ended' },
    });

    await waitFor(() => { expect(harness.closeCount()).toBe(1); });
    expect(published).toEqual(['error']);
    expect(view.getState().status).toBe('error');
    expect(view.getState().records[0]?.id).toBe('retained');
    expect(view.getState().error?.message).toContain('GrantRevoked');
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
    await waitFor(() => { expect(view.getState().status).toBe('ready'); });
    const published: string[] = [];
    view.subscribe((state): void => { published.push(state.status); });

    harness.emit(recordEvent());
    await waitFor(() => { expect(harness.queryRequests).toHaveLength(2); });
    const abortReason = new Error('session replaced');
    abortController.abort(abortReason);
    const abortedState = view.getState();
    expect(abortedState.status).toBe('error');
    expect(abortedState.records[0]).toBe(initial);
    expect(abortedState.error?.message).toBe('RecordView: owning session ended.');
    expect(abortedState.error?.cause).toBe(abortReason);
    expect(published).toEqual(['error']);

    await waitFor(() => { expect(harness.closeCount()).toBe(1); });
    release(ok([late]));
    await Promise.resolve();
    await Promise.resolve();

    expect(view.getState()).toBe(abortedState);
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

  it('closes earlier dependency subscriptions when a later subscription fails', async () => {
    const harness = createHarness(async () => ok([]));
    const originalSubscribe = harness.dwn.records.subscribe;
    harness.dwn.records.subscribe = async (request): Promise<RecordsSubscribeResponse> => {
      const reply = await originalSubscribe(request);
      if (harness.subscribeRequests.length === 2) {
        reply.status = { code: 403, detail: 'child subscription denied' };
      }
      return reply;
    };

    const opening = createRecordView<string>({
      additionalWakeFilters: [{
        protocol     : ViewDefinition.protocol,
        protocolPath : 'folder/section/item',
      }],
      definition         : ViewDefinition,
      dwn                : harness.dwn,
      materializeRecords : async (): Promise<readonly string[]> => [],
      query              : compileRecordQuery(ViewDefinition, 'note', { pagination: { limit: 10 } }),
    });

    await expect(opening).rejects.toBeInstanceOf(DwnResponseError);
    expect(harness.subscribeRequests).toHaveLength(2);
    expect(harness.closeCount()).toBe(2);
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
    await waitFor(() => { expect(view.getState().status).toBe('ready'); });
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

  it('invalidates a local-only ready state when a replication registration is added', async () => {
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
    await waitFor(() => { expect(view.getState().status).toBe('ready'); });

    fakeSync.options = { protocols: [ViewDefinition.protocol] };
    fakeSync.links = [];
    fakeSync.emit({
      type      : 'identity:registration-change',
      tenantDid : TENANT_DID,
      options   : { protocols: [ViewDefinition.protocol] },
    });
    expect(view.getState()).toMatchObject({ status: 'ready', current: false });
    await waitFor(() => { expect(harness.queryRequests).toHaveLength(2); });
    releaseRegistrationQuery(ok([local]));
    await waitFor(() => { expect(view.getState()).toMatchObject({ status: 'ready', current: false }); });

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
    await waitFor(() => { expect(view.getState().status).toBe('ready'); });
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
      expect(view.getState()).toMatchObject({ status: 'ready', current: false });
      expect(view.getState().records).toHaveLength(1);
    });
    expect(view.getState().records[0]).toBe(first);

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
    await waitFor(() => { expect(view.getState()).toMatchObject({ status: 'ready', current: true }); });
    const readyRecords = view.getState().records;

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
    expect(view.getState()).toMatchObject({ status: 'ready', current: false });
    expect(view.getState().records).toEqual(readyRecords);
    await waitFor(() => {
      expect(view.getState().records[0]).toBe(offlineResult);
    });
    expect(view.getState()).toMatchObject({ status: 'ready', current: false });

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
    await waitFor(() => { expect(view.getState().status).toBe('error'); });
    expect(view.getState().error?.message).toContain('replication is paused');
    expect(view.getState().records[0]).toBe(offlineResult);
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
    await waitFor(() => { expect(view.getState().status).toBe('ready'); });

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
    const pausedState = view.getState();
    expect(pausedState.status).toBe('error');
    expect(pausedState.records[0]).toBe(initial);

    fakeSync.emit({
      type           : 'link:connectivity-change',
      tenantDid      : TENANT_DID,
      remoteEndpoint : 'https://dwn.example',
      protocol       : ViewDefinition.protocol,
      protocols      : [ViewDefinition.protocol],
      from           : 'online',
      to             : 'offline',
    });
    expect(view.getState()).toBe(pausedState);

    releaseQuery(ok([testRecord('superseded')]));
    await waitFor(() => {
      expect(view.getState().records[0]).toBe(localWhilePaused);
    });
    expect(view.getState().status).toBe('error');
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
      await waitFor(() => { expect(view.getState().status).toBe('ready'); });
      let publications = 0;
      view.subscribe((): void => { publications += 1; });
      queryHarness.emit(recordEvent());
      await waitFor(() => { expect(queryHarness.queryRequests).toHaveLength(2); });

      const replacementSignal = (await auth.switchIdentity(secondIdentity.did.uri)).signal;

      expect(session.signal.aborted).toBe(true);
      expect(replacementSignal).not.toBe(session.signal);
      expect(replacementSignal.aborted).toBe(false);
      const abortedState = view.getState();
      expect(abortedState.status).toBe('error');
      expect(abortedState.records[0]).toBe(initial);
      expect(abortedState.error?.message).toBe('RecordView: owning session ended.');
      expect((abortedState.error?.cause as Error).name).toBe('AbortError');
      expect(publications).toBe(1);
      await waitFor(() => { expect(queryHarness.closeCount()).toBe(1); });

      releaseQuery(ok([late]));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(view.getState()).toBe(abortedState);
      expect(publications).toBe(1);
    } finally {
      await auth?.shutdown().catch((): void => {});
      sinon.restore();
      await platform.closeStorage();
    }
  });
});
