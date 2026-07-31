import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { describe, expect, it } from 'bun:test';

import { DwnInterface } from '@enbox/agent';
import { Poller } from '@enbox/dwn-sdk-js';

import { createEnboxTestContext } from '../src/testing.js';
import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineProtocol } from '../src/define-protocol.js';
import { recordCodecs } from '../src/record-codec.js';

const definition = {
  protocol  : 'https://example.com/protocols/typed-record-subscription',
  published : true,
  types     : {
    note: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
      schema             : 'https://example.com/schemas/subscribed-note',
    },
  },
  structure: { note: {} },
} as const satisfies ProtocolDefinition;

const protocol = defineProtocol(definition, {
  note: recordCodecs.json<{ title: string }>(),
});
const application = defineApplicationManifest({ protocols: [protocol] } as const);

describe('typed record subscriptions', () => {
  it('delivers exact codec-bound frames without re-reading inline payloads', async () => {
    const context = await createEnboxTestContext({ application });
    const processRequest = sinon.spy(context.enbox.agent, 'processDwnRequest');

    try {
      const notes = context.enbox.using(protocol);
      await notes.records.create('note', { data: { title: 'existing snapshot' } });
      const changes: Array<{ id: string; title?: string; type: 'write' | 'delete' }> = [];

      const subscription = await notes.records.subscribe('note', async (event): Promise<void> => {
        if (event.type === 'error') {
          throw event.error;
        }
        changes.push(event.type === 'delete'
          ? { id: event.record.id, type: event.type }
          : { id: event.record.id, title: (await event.record.value()).title, type: event.type });
      });

      expect(changes).toEqual([]);
      const subscribeRequest = processRequest.getCalls().find(
        call => call.args[0].messageType === DwnInterface.RecordsSubscribe,
      )!.args[0];
      expect(subscribeRequest).toMatchObject({
        messageParams: {
          filter: {
            protocol     : definition.protocol,
            protocolPath : 'note',
            schema       : definition.types.note.schema,
          },
          pagination: { limit: 1 },
        },
        target: context.session.did,
      });

      const created = await notes.records.create('note', { data: { title: 'live frame' } });
      await Poller.pollUntilSuccessOrTimeout(async () => {
        expect(changes).toContainEqual({ id: created.id, title: 'live frame', type: 'write' });
      });

      await created.delete();
      await Poller.pollUntilSuccessOrTimeout(async () => {
        expect(changes).toContainEqual({ id: created.id, type: 'delete' });
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
