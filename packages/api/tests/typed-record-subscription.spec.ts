import type { ContextRecordsApi } from '../src/typed-enbox.js';
import type { DwnSubscriptionMessage } from '@enbox/dwn-clients';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { Record } from '../src/record.js';
import type { DwnApi, RecordsQueryRequest, RecordsQueryResponse } from '../src/dwn-api.js';

import sinon from 'sinon';
import { describe, expect, it } from 'bun:test';

import { DwnInterface } from '@enbox/agent';
import { DateSort, Poller } from '@enbox/dwn-sdk-js';

import { createEnboxTestContext } from '../src/testing.js';
import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineProtocol } from '../src/define-protocol.js';
import { DwnResponseError } from '../src/dwn-response-error.js';
import { recordCodecs } from '../src/record-codec.js';
import { TypedEnbox } from '../src/typed-enbox.js';

const definition = {
  protocol  : 'https://example.com/protocols/typed-record-subscription',
  published : true,
  types     : {
    note: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://example.com/schemas/subscribed-note',
    },
    label: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://example.com/schemas/subscribed-label',
    },
    ignored: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://example.com/schemas/subscribed-ignored',
    },
  },
  structure: { ignored: {}, label: {}, note: {} },
} as const satisfies ProtocolDefinition;

const protocol = defineProtocol(definition, {
  ignored : recordCodecs.json<{ value: string }>(),
  label   : recordCodecs.json<{ text: string }>(),
  note    : recordCodecs.json<{ title: string }>(),
});
const application = defineApplicationManifest({ protocols: [protocol] } as const);

function testRecord(
  id: string,
  timestamp: string,
  options: { deleted?: boolean; path?: 'label' | 'note' } = {},
): Record {
  const path = options.path ?? 'note';
  const message = options.deleted === true
    ? {
      descriptor: {
        interface        : 'Records',
        method           : 'Delete',
        messageTimestamp : timestamp,
        recordId         : id,
      },
    }
    : {
      recordId   : id,
      contextId  : id,
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        dataCid          : `data-${id}-${timestamp}`,
        dataFormat       : 'application/json',
        dataSize         : 1,
        dateCreated      : timestamp,
        messageTimestamp : timestamp,
        protocol         : definition.protocol,
        protocolPath     : path,
      },
    };
  return {
    deleted      : options.deleted === true,
    id,
    protocolPath : path,
    rawMessage   : message,
  } as Record;
}

function queryReply(
  records: Record[],
  cursor?: { messageCid: string; value: string },
): RecordsQueryResponse {
  return { status: { code: 200, detail: 'OK' }, records, cursor };
}

function event(): DwnSubscriptionMessage {
  return { type: 'event' } as DwnSubscriptionMessage;
}

function contextRecords(dwn: DwnApi): ContextRecordsApi<
  typeof definition,
  typeof protocol.codecs,
  'note'
> {
  return new TypedEnbox(dwn, protocol, {
    context: {
      contextId     : 'noteContext',
      protocolPath  : 'note',
      protocolPaths : new Set(['note']),
    },
  }).records as unknown as ContextRecordsApi<typeof definition, typeof protocol.codecs, 'note'>;
}

describe('typed record subscriptions', () => {
  it('requires context scope for initial replay', async () => {
    const notes = new TypedEnbox({} as DwnApi, protocol);
    const subscribe = notes.records.subscribe as unknown as (...args: unknown[]) => Promise<unknown>;

    await expect(subscribe('note', { initial: true }, (): void => {}))
      .rejects.toThrow('initial replay requires a context-bound records surface');
  });

  it('hands paginated initial records to one live stream without missing overlap', async () => {
    const first = testRecord('first', '2026-01-01T00:00:00.000000Z');
    const current = testRecord('mutable', '2026-01-01T00:00:02.000000Z');
    const secondPage = testRecord('second-page', '2026-01-01T00:00:03.000000Z');
    const live = testRecord('live', '2026-01-01T00:00:04.000000Z');
    const deletedFirst = testRecord('first', '2026-01-01T00:00:05.000000Z', { deleted: true });
    const afterHandoff = testRecord('after', '2026-01-01T00:00:06.000000Z');
    const duringDrain = testRecord('during-drain', '2026-01-01T00:00:07.000000Z');
    const close = sinon.stub().resolves();
    const order: string[] = [];
    const queries: RecordsQueryRequest[] = [];
    const received: Array<{ id: string; type: 'delete' | 'write' }> = [];
    let deliver!: (message: DwnSubscriptionMessage, record?: Record) => void | Promise<void>;
    let queryCalls = 0;
    const dwn = {
      connectedDid      : 'did:example:alice',
      followedContextId : undefined,
      followedSourceId  : undefined,
      recordTenantDid   : 'did:example:alice',
      records           : {
        query: async (request: RecordsQueryRequest): Promise<RecordsQueryResponse> => {
          queryCalls += 1;
          queries.push(request);
          order.push(`query-${queryCalls}`);
          if (queryCalls === 1) {
            return queryReply([first, current], { messageCid: 'page-1', value: 'cursor-1' });
          }
          await deliver(event(), live);
          await deliver(event(), deletedFirst);
          return queryReply([secondPage]);
        },
      },
      subscribeRecordFrames: async (
        _request: { paths: readonly string[]; protocol: string },
        handler: typeof deliver,
      ) => {
        order.push('subscribe');
        deliver = handler;
        await deliver(event(), current);
        return {
          status       : { code: 200, detail: 'OK' },
          subscription : { id: 'initial-live', close },
        };
      },
    } as unknown as DwnApi;
    const records = contextRecords(dwn);

    const subscription = await records.subscribe('note', { initial: true }, async (change): Promise<void> => {
      if (change.type === 'error') {
        throw change.error;
      }
      order.push(`${change.type}-${change.record.id}`);
      received.push({ id: change.record.id, type: change.type });
      if (change.record.id === 'live') {
        await deliver(event(), duringDrain);
      }
    });

    expect(order).toEqual([
      'subscribe',
      'query-1',
      'write-first',
      'write-mutable',
      'query-2',
      'write-second-page',
      'write-mutable',
      'write-live',
      'delete-first',
      'write-during-drain',
    ]);
    expect(received).toEqual([
      { id: 'first', type: 'write' },
      { id: 'mutable', type: 'write' },
      { id: 'second-page', type: 'write' },
      { id: 'mutable', type: 'write' },
      { id: 'live', type: 'write' },
      { id: 'first', type: 'delete' },
      { id: 'during-drain', type: 'write' },
    ]);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({
      dateSort   : DateSort.CreatedAscending,
      pagination : { limit: 100 },
    });
    expect(queries[1]).toMatchObject({
      dateSort   : DateSort.CreatedAscending,
      pagination : {
        cursor : { messageCid: 'page-1', value: 'cursor-1' },
        limit  : 100,
      },
    });

    await deliver(event(), afterHandoff);
    expect(received.at(-1)).toEqual({ id: 'after', type: 'write' });
    await subscription.close();
    expect(close.calledOnce).toBe(true);
  });

  it('closes the live subscription when initial replay fails', async () => {
    const close = sinon.stub().resolves();
    const dwn = {
      connectedDid      : 'did:example:alice',
      followedContextId : undefined,
      followedSourceId  : undefined,
      recordTenantDid   : 'did:example:alice',
      records           : {
        query: async (): Promise<RecordsQueryResponse> => ({
          status  : { code: 500, detail: 'query failed' },
          records : [],
        }),
      },
      subscribeRecordFrames: async () => ({
        status       : { code: 200, detail: 'OK' },
        subscription : { id: 'initial-failure', close },
      }),
    } as unknown as DwnApi;
    const records = contextRecords(dwn);

    await expect(records.subscribe('note', { initial: true }, (): void => {}))
      .rejects.toBeInstanceOf(DwnResponseError);
    expect(close.calledOnce).toBe(true);
  });

  it('delivers one path-discriminated stream without re-reading inline payloads', async () => {
    const context = await createEnboxTestContext({ application });
    const processRequest = sinon.spy(context.enbox.agent, 'processDwnRequest');

    try {
      const notes = context.enbox.using(protocol);
      await expect(notes.records.subscribe([], (): void => {})).rejects.toThrow(
        'at least one protocol path is required',
      );
      await notes.records.create('note', { data: { title: 'existing snapshot' } });
      const changes: Array<{ id: string; path: 'label' | 'note'; value?: string; type: 'write' | 'delete' }> = [];

      const subscription = await notes.records.subscribe(['note', 'label'], async (event): Promise<void> => {
        if (event.type === 'error') {
          throw event.error;
        }
        changes.push(event.type === 'delete'
          ? { id: event.record.id, path: event.path, type: event.type }
          : {
            id    : event.record.id,
            path  : event.path,
            type  : event.type,
            value : event.path === 'note'
              ? (await event.record.value()).title
              : (await event.record.value()).text,
          });
      });

      expect(changes).toEqual([]);
      const subscribeRequest = processRequest.getCalls().find(
        call => call.args[0].messageType === DwnInterface.MessagesSubscribe,
      )!.args[0];
      expect(subscribeRequest).toMatchObject({
        messageParams: {
          filters: [
            { interface: 'Records', protocol: definition.protocol, protocolPath: 'note' },
            { interface: 'Records', protocol: definition.protocol, protocolPath: 'label' },
          ],
        },
        target: context.session.did,
      });

      const created = await notes.records.create('note', { data: { title: 'live frame' } });
      const label = await notes.records.create('label', { data: { text: 'live label' } });
      await notes.records.create('ignored', { data: { value: 'not subscribed' } });
      await Poller.pollUntilSuccessOrTimeout(async () => {
        expect(changes).toContainEqual({ id: created.id, path: 'note', type: 'write', value: 'live frame' });
        expect(changes).toContainEqual({ id: label.id, path: 'label', type: 'write', value: 'live label' });
      });
      expect(changes).toHaveLength(2);

      await created.delete();
      await Poller.pollUntilSuccessOrTimeout(async () => {
        expect(changes).toContainEqual({ id: created.id, path: 'note', type: 'delete' });
      });
      expect(processRequest.getCalls().some((call): boolean =>
        call.args[0].messageType === DwnInterface.RecordsRead
        && call.args[0].messageParams.filter.recordId === created.id
      )).toBe(false);

      await subscription.close();
    } finally {
      processRequest.restore();
      await context.close();
    }
  });
});
