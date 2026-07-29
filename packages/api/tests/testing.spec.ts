import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { describe, expect, it } from 'bun:test';

import { createEnboxTestContext } from '../src/testing.js';
import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineProtocol } from '../src/define-protocol.js';
import { recordCodecs } from '../src/record-codec.js';

const NotesDefinition = {
  protocol  : 'https://example.com/protocols/api-test-context',
  published : false,
  types     : {
    note: {
      schema             : 'https://example.com/schemas/api-test-note',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
  },
  structure: { note: {} },
} as const satisfies ProtocolDefinition;

const NotesProtocol = defineProtocol(NotesDefinition, {
  note: recordCodecs.json<{ text: string }>(),
});
const Application = defineApplicationManifest({ protocols: [NotesProtocol] } as const);

describe('createEnboxTestContext()', () => {
  it('installs typed protocols and round-trips encrypted records through a real local DWN', async () => {
    const context = await createEnboxTestContext({ application: Application });

    try {
      const notes = context.enbox.using(NotesProtocol);
      expect(await notes.verifyInstalled()).toMatchObject({
        installed                : true,
        missingKeyAgreementPaths : [],
        status                   : 'up-to-date',
      });

      const created = await notes.records.create('note', { data: { text: 'encrypted' } });
      expect(created.encryption).toBeDefined();

      const { records } = await notes.records.query('note');
      expect(records).toHaveLength(1);
      expect(await records[0].value()).toEqual({ text: 'encrypted' });
    } finally {
      await context.close();
    }
  });

  it('isolates concurrent contexts and lets either context close independently', async () => {
    const [left, right] = await Promise.all([
      createEnboxTestContext({ application: Application }),
      createEnboxTestContext({ application: Application }),
    ]);

    try {
      expect(left.session.did).not.toBe(right.session.did);
      const leftNotes = left.enbox.using(NotesProtocol);
      const rightNotes = right.enbox.using(NotesProtocol);
      await Promise.all([
        leftNotes.records.create('note', { data: { text: 'left' } }),
        rightNotes.records.create('note', { data: { text: 'right' } }),
      ]);

      const [leftPage, rightPage] = await Promise.all([
        leftNotes.records.query('note'),
        rightNotes.records.query('note'),
      ]);
      expect(await Promise.all(leftPage.records.map((record) => record.value()))).toEqual([{ text: 'left' }]);
      expect(await Promise.all(rightPage.records.map((record) => record.value()))).toEqual([{ text: 'right' }]);

      await left.close();
      await rightNotes.records.create('note', { data: { text: 'still open' } });
      expect((await rightNotes.records.query('note')).records).toHaveLength(2);
    } finally {
      await Promise.all([left.close(), right.close()]);
    }
  });

  it('ends the session and closes active views idempotently', async () => {
    const context = await createEnboxTestContext({ application: Application });
    const stopSync = sinon.spy(context.enbox.agent.sync, 'stopSync');

    try {
      const view = await context.enbox.using(NotesProtocol).records.observe('note', {
        pagination: { limit: 10 },
      });

      await Promise.all([context.close(), context.close()]);

      expect(context.session.signal.aborted).toBe(true);
      expect(stopSync.calledOnce).toBe(true);
      expect(view.getSnapshot().state).toBe('error');
    } finally {
      stopSync.restore();
      await context.close();
    }
  });
});
