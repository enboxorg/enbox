import type { DwnApi } from '../src/dwn-api.js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { defineModule } from '../src/define-module.js';
import { DwnResponseError } from '../src/dwn-response-error.js';
import { recordCodecs } from '../src/record-codec.js';
import { TypedEnbox } from '../src/typed-enbox.js';

const definition = {
  module    : 'https://example.com/modules/typed-record-delete',
  published : true,
  types     : {
    note: { dataFormats: ['application/json'] },
  },
  structure: {
    note: {},
  },
} as const;

const module = defineModule(definition, {
  note: recordCodecs.json<{ title: string }>(),
});

function createTypedDelete(deleteRecord: sinon.SinonStub): TypedEnbox<typeof definition, typeof module.codecs> {
  const dwn = {
    modules: {
      query: sinon.stub().resolves({
        modules : [{ definition }],
        status  : { code: 200, detail: 'OK' },
      }),
    },
    records: { delete: deleteRecord },
  } as unknown as DwnApi;
  return new TypedEnbox(dwn, module);
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
        module     : definition.module,
        modulePath : 'note',
        recordId   : 'note-id',
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
