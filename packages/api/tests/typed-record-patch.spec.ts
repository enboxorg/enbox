import type { DwnApi } from '../src/dwn-api.js';
import type { Record } from '../src/record.js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { defineProtocol } from '../src/define-protocol.js';
import { DwnResponseError } from '../src/dwn-response-error.js';
import { recordCodecs } from '../src/record-codec.js';
import { RecordConflictError } from '../src/record-conflict-error.js';
import { TypedEnbox } from '../src/typed-enbox.js';

const definition = {
  protocol  : 'https://example.com/protocols/typed-record-patch',
  published : true,
  types     : {
    note: { dataFormats: ['application/json'] },
  },
  structure: {
    note: {},
  },
} as const;

type Note = {
  title: string;
  body?: string;
};

const protocol = defineProtocol(definition, {
  note: recordCodecs.json<Note>(),
});

type FakeRecord = {
  record: Record<Note>;
  update: sinon.SinonStub;
  value: sinon.SinonStub;
};

function fakeRecord(data: Note): FakeRecord {
  const update = sinon.stub();
  const value = sinon.stub().resolves(data);
  const record = { update, value } as unknown as Record<Note>;
  update.resolves(record);
  return { record, update, value };
}

function typedWithReads(readRecordForMutation: sinon.SinonStub): TypedEnbox<
  typeof definition,
  typeof protocol.codecs
> {
  const dwn = { readRecordForMutation } as unknown as DwnApi;
  return new TypedEnbox(dwn, protocol, {
    context: {
      contextId     : 'noteid',
      protocolPath  : 'note',
      protocolPaths : new Set(['note']),
    },
  });
}

function readReply(record: Record<Note>): {
  record: Record<Note>;
  status: { code: number; detail: string };
} {
  return { record, status: { code: 200, detail: 'OK' } };
}

describe('TypedEnbox.records.patch()', () => {
  afterEach(() => sinon.restore());

  it('applies a direct patch and returns the typed record', async () => {
    const current = fakeRecord({ title: 'before', body: 'remove me' });
    const readRecordForMutation = sinon.stub().resolves(readReply(current.record));
    const typed = typedWithReads(readRecordForMutation);

    const result = await typed.records.patch('note', 'note-id', {
      body  : null,
      title : 'after',
    });

    expect(result).toBe(current.record);
    expect(readRecordForMutation.calledOnce).toBe(true);
    expect(current.update.calledOnceWithExactly({ data: { title: 'after' } })).toBe(true);
    expect(current.value.calledOnce).toBe(true);
  });

  it('rejects a decoded class value instead of treating it as a patchable object', async () => {
    const current = fakeRecord({ title: 'before' });
    current.value.resolves(new Date('2026-07-24T00:00:00.000Z'));
    const readRecordForMutation = sinon.stub().resolves(readReply(current.record));
    const typed = typedWithReads(readRecordForMutation);

    await expect(typed.records.patch('note', 'note-id', { title: 'after' }))
      .rejects.toThrow('current value to be a plain object');
    expect(current.update.called).toBe(false);
  });

  it('re-reads once and re-evaluates a producer against the fresh value after a canonical conflict', async () => {
    const conflict = new DwnResponseError('Record.update', { code: 409, detail: 'Conflict' });
    const stale = fakeRecord({ title: 'stale' });
    stale.update.rejects(conflict);
    const fresh = fakeRecord({ title: 'fresh', body: 'preserve me' });
    const readRecordForMutation = sinon.stub();
    readRecordForMutation.onFirstCall().resolves(readReply(stale.record));
    readRecordForMutation.onSecondCall().resolves(readReply(fresh.record));
    const typed = typedWithReads(readRecordForMutation);
    const producer = sinon.stub().callsFake((value: Note) => ({
      title: `${value.title}-patched`,
    }));

    const result = await typed.records.patch('note', 'note-id', producer);

    expect(result).toBe(fresh.record);
    expect(readRecordForMutation.callCount).toBe(2);
    expect(producer.callCount).toBe(2);
    expect(producer.firstCall.args[0]).toEqual({ title: 'stale' });
    expect(producer.secondCall.args[0]).toEqual({ title: 'fresh', body: 'preserve me' });
    expect(stale.update.calledOnceWithExactly({ data: { title: 'stale-patched' } })).toBe(true);
    expect(fresh.update.calledOnceWithExactly({
      data: { title: 'fresh-patched', body: 'preserve me' },
    })).toBe(true);
  });

  it('returns the current record without writing when a producer returns undefined', async () => {
    const current = fakeRecord({ title: 'unchanged' });
    const readRecordForMutation = sinon.stub().resolves(readReply(current.record));
    const typed = typedWithReads(readRecordForMutation);

    const result = await typed.records.patch('note', 'note-id', () => undefined);

    expect(result).toBe(current.record);
    expect(readRecordForMutation.calledOnce).toBe(true);
    expect(current.value.calledOnce).toBe(true);
    expect(current.update.called).toBe(false);
  });

  it('throws RecordConflictError with the second conflict as its cause', async () => {
    const firstConflict = new DwnResponseError('Record.update', { code: 409, detail: 'Conflict' });
    const secondConflict = new DwnResponseError('Record.update', { code: 409, detail: 'Conflict' });
    const first = fakeRecord({ title: 'first' });
    first.update.rejects(firstConflict);
    const second = fakeRecord({ title: 'second' });
    second.update.rejects(secondConflict);
    const readRecordForMutation = sinon.stub();
    readRecordForMutation.onFirstCall().resolves(readReply(first.record));
    readRecordForMutation.onSecondCall().resolves(readReply(second.record));
    const typed = typedWithReads(readRecordForMutation);

    let failure: unknown;
    try {
      await typed.records.patch('note', 'note-id', { title: 'patched' });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RecordConflictError);
    expect((failure as RecordConflictError).cause).toBe(secondConflict);
    expect(readRecordForMutation.callCount).toBe(2);
    expect(first.update.calledOnce).toBe(true);
    expect(second.update.calledOnce).toBe(true);
  });

  it('preserves non-canonical error identity without retrying', async () => {
    const failures = [
      new DwnResponseError('Record.update', { code: 500, detail: 'Internal Server Error' }),
      new DwnResponseError('Record.update', { code: 409, detail: 'Version conflict' }),
      new DwnResponseError('Record.update', {
        code      : 409,
        detail    : 'Conflict',
        errorCode : 'RecordsWriteGetInitialWriteNotFound',
      }),
    ];

    for (const failure of failures) {
      const current = fakeRecord({ title: 'before' });
      current.update.rejects(failure);
      const readRecordForMutation = sinon.stub().resolves(readReply(current.record));
      const typed = typedWithReads(readRecordForMutation);

      await expect(typed.records.patch('note', 'note-id', { title: 'after' })).rejects.toBe(failure);
      expect(readRecordForMutation.calledOnce).toBe(true);
      expect(current.update.calledOnce).toBe(true);
    }
  });

  it('does not classify codec failures as write conflicts', async () => {
    const codecFailure = new DwnResponseError('codec', { code: 409, detail: 'Conflict' });
    const current = fakeRecord({ title: 'before' });
    current.value.rejects(codecFailure);
    const readRecordForMutation = sinon.stub().resolves(readReply(current.record));
    const typed = typedWithReads(readRecordForMutation);

    await expect(typed.records.patch('note', 'note-id', { title: 'after' }))
      .rejects.toBe(codecFailure);
    expect(readRecordForMutation.calledOnce).toBe(true);
    expect(current.update.called).toBe(false);
  });

  it('throws a 404 DwnResponseError when the record is absent', async () => {
    const readRecordForMutation = sinon.stub().resolves({
      status: { code: 404, detail: 'Not Found' },
    });
    const typed = typedWithReads(readRecordForMutation);

    let failure: unknown;
    try {
      await typed.records.patch('note', 'missing-id', { title: 'after' });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DwnResponseError);
    expect((failure as DwnResponseError).status).toEqual({ code: 404, detail: 'Not Found' });
    expect((failure as DwnResponseError).message)
      .toBe('TypedEnbox.records.patch failed (404): Not Found');
    expect(readRecordForMutation.calledOnce).toBe(true);
  });
});
