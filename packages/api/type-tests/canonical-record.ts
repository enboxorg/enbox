import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type {
  Record,
  RecordData,
  RecordPage,
  RecordPatch,
  RecordSubscription,
  RecordUpdateParams,
  RecordView,
  TypedEnbox,
} from '@enbox/api';

import { defineProtocol, recordCodecs } from '@enbox/api';

const CanonicalRecordDefinition = {
  protocol  : 'https://example.com/protocols/canonical-record',
  published : true,
  types     : {
    task: {
      dataFormats: ['application/json'],
    },
    attachment: {
      dataFormats: ['application/octet-stream'],
    },
  },
  structure: {
    task       : {},
    attachment : {},
  },
} as const satisfies ProtocolDefinition;
void CanonicalRecordDefinition;

interface TaskData {
  title: string;
  completed: boolean;
  note?: string;
}

const CanonicalRecordProtocol = defineProtocol(CanonicalRecordDefinition, {
  task       : recordCodecs.json<TaskData>(),
  attachment : recordCodecs.blob('application/octet-stream'),
});
void CanonicalRecordProtocol;

// @ts-expect-error every reachable protocol record type requires a codec.
defineProtocol(CanonicalRecordDefinition, {
  task: recordCodecs.json<TaskData>(),
});

// @ts-expect-error codecs for types outside the protocol structure are rejected.
defineProtocol(CanonicalRecordDefinition, {
  task       : recordCodecs.json<TaskData>(),
  attachment : recordCodecs.blob('application/octet-stream'),
  orphan     : recordCodecs.json<unknown>(),
});

declare const record: Record<TaskData>;
declare const untypedRecord: Record;
declare const typed: TypedEnbox<
  typeof CanonicalRecordDefinition,
  typeof CanonicalRecordProtocol.codecs
>;

const recordData: RecordData = record.data;
const payload: Promise<TaskData> = record.value();
const rawPayload: Promise<unknown> = untypedRecord.data.json();
// @ts-expect-error record handles preserve their existing representation.
untypedRecord.update({ dataFormat: 'text/plain' });
const replacement: RecordUpdateParams<TaskData> = {
  data: { title: 'updated', completed: true },
};
const patch: RecordPatch<TaskData> = { note: null };
void recordData;
void payload;
void rawPayload;
void replacement;
void patch;

// @ts-expect-error the canonical payload type cannot be overridden at the value accessor.
record.value<{ wrong: true }>();

// @ts-expect-error update data is a complete replacement payload.
record.update({ data: { title: 'missing required completed field' } });
// @ts-expect-error partial updates belong to TypedEnbox.records.patch().
record.patch({ completed: true });

declare const nullableRecord: Record<{ value: string | null }>;
nullableRecord.update({ data: { value: null } });

async function assertCanonicalRecordFlow(): Promise<void> {
  const created: Record<TaskData> = await typed.records.create('task', {
    data: { title: 'created', completed: false },
  });
  await typed.records.create('task', {
    data       : { title: 'created', completed: false },
    // @ts-expect-error the protocol codec owns the encoded data format.
    dataFormat : 'application/json',
  });
  const createdData: TaskData = await created.value();
  const updated: Record<TaskData> = await created.update({
    data: { title: 'updated', completed: true },
  });
  // @ts-expect-error record handles preserve their codec-owned representation.
  await created.update({ dataFormat: 'application/json' });
  const deleted: void = await updated.delete();
  void createdData;
  void deleted;

  const queried: RecordPage<Record<TaskData>> = await typed.records.query('task');
  const queriedRecord: Record<TaskData> | undefined = queried.records[0];
  const nextPage: RecordPage<Record<TaskData>> | undefined = await queried.next();
  const nextRecord: Record<TaskData> | undefined = nextPage?.records[0];
  void queriedRecord;
  void nextRecord;

  const readRecord: Record<TaskData> | undefined = await typed.records.read('task', 'record-id');
  void readRecord;

  const patchedRecord: Record<TaskData> = await typed.records.patch('task', 'record-id', {
    note: null,
  });
  const producerPatchedRecord: Record<TaskData> = await typed.records.patch(
    'task',
    'record-id',
    async (current) => {
      const currentTask: TaskData = current;
      void currentTask;
      return current.completed ? undefined : { completed: true };
    },
  );
  void patchedRecord;
  void producerPatchedRecord;

  // @ts-expect-error records.patch cannot delete a required field.
  await typed.records.patch('task', 'record-id', { title: null });
  // @ts-expect-error records.patch cannot introduce fields outside the payload type.
  await typed.records.patch('task', 'record-id', { missing: true });
  // @ts-expect-error known binary paths cannot use the JSON-object patch operation.
  await typed.records.patch('attachment', 'attachment-id', {});

  const view: RecordView<Record<TaskData>> = await typed.records.observe('task', {
    pagination: { limit: 10 },
  });
  const observedRecord: Record<TaskData> | undefined = view.getSnapshot().records[0];
  void observedRecord;

  const subscription: RecordSubscription = await typed.records.subscribe('task', async (event): Promise<void> => {
    if (event.type === 'write') {
      const path: 'task' = event.path;
      const changed: Record<TaskData> = event.record;
      const value: TaskData = await changed.value();
      void path;
      void value;
    }
  });
  await subscription.close();

  const selectedPaths: Array<'attachment' | 'task'> = ['task', 'attachment'];
  await typed.records.subscribe(selectedPaths, async (event): Promise<void> => {
    if (event.type === 'error') { return; }
    if (event.path === 'task') {
      const task: TaskData = await event.record.value();
      void task;
      return;
    }
    const attachment: Blob = await event.record.value();
    void attachment;
  });

  // @ts-expect-error initial replay requires a context-bound records surface.
  await typed.records.subscribe('task', { initial: true }, (): void => {});

  // @ts-expect-error subscribe has no query/routing options; use observe for filtered state.
  await typed.records.subscribe('task', (): void => {}, { from: 'did:example:other' });

  // @ts-expect-error typed operations do not expose raw DWN response envelopes.
  created.status;
}

void assertCanonicalRecordFlow;
