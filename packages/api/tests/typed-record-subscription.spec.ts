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

describe('typed record subscriptions', () => {
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
