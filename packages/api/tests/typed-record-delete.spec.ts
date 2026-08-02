import type { DwnApi } from '../src/dwn-api.js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { defineProtocol } from '../src/define-protocol.js';
import { DwnResponseError } from '../src/dwn-response-error.js';
import { recordCodecs } from '../src/record-codec.js';
import { TypedEnbox } from '../src/typed-enbox.js';

const definition = {
  protocol  : 'https://example.com/protocols/typed-record-delete',
  published : true,
  types     : {
    note: { dataFormats: ['application/json'] },
  },
  structure: {
    note: {},
  },
} as const;

const protocol = defineProtocol(definition, {
  note: recordCodecs.json<{ title: string }>(),
});

function createTypedDelete(deleteRecord: sinon.SinonStub): TypedEnbox<typeof definition, typeof protocol.codecs> {
  const dwn = {
    protocols: {
      query: sinon.stub().resolves({
        protocols : [{ definition }],
        status    : { code: 200, detail: 'OK' },
      }),
    },
    records: { delete: deleteRecord },
  } as unknown as DwnApi;
  return new TypedEnbox(dwn, protocol);
}

describe('TypedEnbox.records.delete()', () => {
  afterEach(() => sinon.restore());

  it('treats absence and a winning existing tombstone as completed deletes', async () => {
    for (const status of [
      { code: 404, detail: 'Not Found' },
      { code: 409, detail: 'Conflict' },
    ]) {
      const deleteRecord = sinon.stub().resolves({ status });
      const typed = createTypedDelete(deleteRecord);

      await expect(typed.records.delete('note', { recordId: 'note-id' })).resolves.toBeUndefined();
      expect(deleteRecord.calledOnceWithMatch({
        protocol     : definition.protocol,
        protocolPath : 'note',
        recordId     : 'note-id',
      })).toBe(true);
    }
  });

  it('preserves noncanonical conflict failures', async () => {
    for (const status of [
      { code: 409, detail: 'Version conflict' },
      { code: 409, detail: 'Conflict', errorCode: 'UnexpectedConflict' },
    ]) {
      const deleteRecord = sinon.stub().resolves({ status });
      const typed = createTypedDelete(deleteRecord);

      await expect(typed.records.delete('note', { recordId: 'note-id' }))
        .rejects.toBeInstanceOf(DwnResponseError);
    }
  });
});
