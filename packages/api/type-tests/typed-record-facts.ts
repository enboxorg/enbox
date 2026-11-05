import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type {
  ContextMaterializedRecord,
  MaterializedRecord,
  Record,
  RecordPage,
  SquashModulePaths,
  TypedEnbox,
  TypedMaterializedRecord,
  TypedRecord,
} from '@enbox/api';

import { defineModule, recordCodecs } from '@enbox/api';

const Definition = {
  module    : 'https://example.com/modules/typed-record-facts',
  published : true,
  types     : {
    document : { dataFormats: ['application/json'] },
    snapshot : { dataFormats: ['application/json'] },
  },
  structure: {
    document: {
      snapshot: {
        $recordLimit : { max: 1 },
        $squash      : true,
      },
    },
  },
} as const satisfies ModuleDefinition;

const _Module = defineModule(Definition, {
  document : recordCodecs.json<{ title: string }>(),
  snapshot : recordCodecs.json<{ revision: number }>(),
});

declare const typed: TypedEnbox<typeof Definition, typeof _Module.codecs>;
declare const widened: TypedEnbox<ModuleDefinition, typeof _Module.codecs>;
declare const possiblePath: 'document' | 'document/snapshot';

type SquashPath = SquashModulePaths<typeof Definition>;
const squashPath: SquashPath = 'document/snapshot';
void squashPath;

function requireCoordinates(record: TypedRecord<unknown>): void {
  const contextId: string = record.contextId;
  const module: string = record.module;
  const modulePath: string = record.modulePath;
  const squash: boolean = record.squash;
  void contextId;
  void module;
  void modulePath;
  void squash;
}

async function assertTypedSources(): Promise<void> {
  const created = await typed.records.create('document', { data: { title: 'Document' } });
  requireCoordinates(created);
  const updated: TypedRecord<{ title: string }> = await created.update({ data: { title: 'Updated' } });
  const read: TypedRecord<{ title: string }> | undefined = await typed.records.read('document', created.id);
  const page: RecordPage<TypedRecord<{ title: string }>> = await typed.records.query('document');
  const view = await typed.records.observe('document', { pagination: { limit: 10 } });
  const observed: TypedRecord<{ title: string }> | undefined = view.getSnapshot().records[0];
  const subscription = await typed.records.subscribe('document', (event): void => {
    if (event.type !== 'error') {
      requireCoordinates(event.record);
    }
  });
  const materialized = await typed.records.query('document', {
    materialize : { children: ['document/snapshot'] as const },
    pagination  : { limit: 10 },
  });
  const selected: TypedMaterializedRecord<{ title: string }> | undefined = materialized.records[0];
  const child: TypedRecord<{ revision: number }> | undefined = materialized.records[0]?.children.snapshot?.record;
  void updated;
  void read;
  void page;
  void observed;
  void selected;
  void child;
  await subscription.close();
  await view.close();

  await typed.records.create('document/snapshot', { data: { revision: 1 }, squash: true });
  await typed.records.create('document', {
    data   : { title: 'No squash' },
    // @ts-expect-error squash is available only on a path that declares $squash.
    squash : true,
  });
  await typed.records.create(possiblePath, {
    data   : { revision: 2 },
    // @ts-expect-error every member of a union path must declare $squash.
    squash : true,
  });

  // Widened definitions defer dynamic module checks to the DWN.
  await widened.records.create('document', { data: { title: 'Dynamic' }, squash: true });
}

declare const defaultMaterialized: MaterializedRecord<{ title: string }>;
const compatibleHandle: Record<{ title: string }> = defaultMaterialized.record;
void compatibleHandle;

declare const contextMaterialized: ContextMaterializedRecord<{ title: string }>;
const contextId: string = contextMaterialized.record.contextId;
const contextModule: string = contextMaterialized.record.module;
const contextPath: string = contextMaterialized.record.modulePath;
const contextSquash: boolean = contextMaterialized.record.squash;
void contextId;
void contextModule;
void contextPath;
void contextSquash;

void assertTypedSources;
