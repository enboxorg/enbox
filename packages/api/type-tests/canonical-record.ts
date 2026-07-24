import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type {
  Record,
  RecordData,
  RecordDeleteResult,
  RecordPatch,
  RecordUpdateParams,
  RecordUpdateResult,
  RecordView,
  TypedEnbox,
} from '@enbox/api';

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

type CanonicalRecordSchemaMap = {
  task: TaskData;
  attachment: Blob;
};

declare const record: Record<TaskData>;
declare const untypedRecord: Record;
declare const typed: TypedEnbox<typeof CanonicalRecordDefinition, CanonicalRecordSchemaMap>;

const recordData: RecordData<TaskData> = record.data;
const payload: Promise<TaskData> = recordData.json();
const rawPayload: Promise<unknown> = untypedRecord.data.json();
const rawPatch: Promise<RecordUpdateResult<unknown>> = untypedRecord.patch({ arbitrary: true });
const replacement: RecordUpdateParams<TaskData> = {
  data: { title: 'updated', completed: true },
};
const patch: RecordPatch<TaskData> = { note: null };
void payload;
void rawPayload;
void rawPatch;
void replacement;
void patch;

// @ts-expect-error the canonical payload type cannot be overridden at the data accessor.
record.data.json<{ wrong: true }>();

// @ts-expect-error update data is a complete replacement payload.
record.update({ data: { title: 'missing required completed field' } });

// @ts-expect-error required fields cannot be deleted by a patch.
record.patch({ title: null });

// @ts-expect-error patches cannot introduce fields outside the payload type.
record.patch({ missing: true });

declare const attachment: Record<Blob>;
// @ts-expect-error known binary payloads cannot use the JSON-object patch operation.
attachment.patch({});

declare const nullableRecord: Record<{ value: string | null }>;
// @ts-expect-error null is the patch deletion sentinel and cannot delete a required field.
nullableRecord.patch({ value: null });
nullableRecord.update({ data: { value: null } });

async function assertCanonicalRecordFlow(): Promise<void> {
  const created = await typed.records.create('task', {
    data: { title: 'created', completed: false },
  });
  if (created.record !== undefined) {
    const createdRecord: Record<TaskData> = created.record;
    const createdData: TaskData = await createdRecord.data.json();
    const updated: RecordUpdateResult<TaskData> = await createdRecord.update({
      data: { title: 'updated', completed: true },
    });
    const deleted: RecordDeleteResult<TaskData> = await updated.record.delete();
    void createdData;
    void deleted;
  }

  const queried = await typed.records.query('task');
  const queriedRecord: Record<TaskData> | undefined = queried.records[0];
  void queriedRecord;

  const read = await typed.records.read('task', { filter: { recordId: 'record-id' } });
  const readRecord: Record<TaskData> | undefined = read.record;
  void readRecord;

  const view: RecordView<TaskData> = await typed.records.observe('task', {
    pagination: { limit: 10 },
  });
  const observedRecord: Record<TaskData> | undefined = view.getSnapshot().records[0];
  void observedRecord;
}

void assertCanonicalRecordFlow;
