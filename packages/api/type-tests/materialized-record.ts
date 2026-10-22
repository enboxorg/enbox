import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type {
  MaterializedRecord,
  Record,
  RecordMaterialization,
  RecordObserveRequest,
  RecordPage,
  RecordRepresentation,
  RecordView,
  TypedEnbox,
  TypedRecord,
} from '@enbox/api';

import { defineProtocol, recordCodecs } from '@enbox/api';

const LibraryDefinition = {
  protocol  : 'https://example.com/protocols/library',
  published : true,
  types     : {
    library    : { dataFormats: ['application/json'] },
    title      : { dataFormats: ['text/plain'] },
    attachment : { dataFormats: ['application/octet-stream'] },
    metadata   : { dataFormats: ['application/json'] },
    preference : { dataFormats: ['application/json'] },
  },
  structure: {
    library: {
      title      : { $recordLimit: { max: 1 } },
      attachment : { $recordLimit: { max: 2 } },
      metadata   : {
        $recordLimit : { max: 1 },
        preference   : { $recordLimit: { max: 1 } },
      },
    },
    preference: { $recordLimit: { max: 1 } },
  },
} as const satisfies ProtocolDefinition;
void LibraryDefinition;

type LibraryData = { name: string };
type MetadataData = { color: string };
type PreferenceData = { theme: string };

const LibraryProtocol = defineProtocol(LibraryDefinition, {
  attachment : recordCodecs.blob('application/octet-stream'),
  library    : recordCodecs.json<LibraryData>(),
  metadata   : recordCodecs.json<MetadataData>(),
  preference : recordCodecs.json<PreferenceData>(),
  title      : recordCodecs.text(),
});
void LibraryProtocol;

declare const typed: TypedEnbox<typeof LibraryDefinition, typeof LibraryProtocol.codecs>;

async function assertTypedMaterialization(): Promise<void> {
  const plainPage = await typed.records.query('library');
  const plainRecord: TypedRecord<LibraryData> | undefined = plainPage.records[0];
  const compatiblePage: RecordPage<Record<LibraryData>> = plainPage;
  void plainRecord;
  void compatiblePage;

  const plainRequest: RecordObserveRequest<typeof LibraryDefinition, 'library'> = { pagination: { limit: 20 } };
  const plainView: RecordView<RecordRepresentation<typeof LibraryDefinition, typeof LibraryProtocol.codecs, 'library'>> =
    await typed.records.observe('library', plainRequest);
  void plainView;

  const values = await typed.records.query('library', {
    materialize : true,
    pagination  : { limit: 20 },
  });
  const valueOnly: MaterializedRecord<LibraryData> | undefined = values.records[0];
  const nextValues = await values.next();
  const nextValueOnly: MaterializedRecord<LibraryData> | undefined = nextValues?.records[0];
  const library: LibraryData | undefined = valueOnly?.value;
  void library;
  void nextValueOnly;
  // @ts-expect-error value-only materialization has no children property.
  void valueOnly?.children;

  // @ts-expect-error eager value materialization requires an explicit page bound.
  await typed.records.query('library', { materialize: true });

  // @ts-expect-error an explicit materialized result still requires its request.
  await typed.records.query<'library', true>('library');

  // @ts-expect-error an explicit materialized result still requires materialize at runtime.
  await typed.records.query<'library', true>('library', { pagination: { limit: 20 } });

  const conditionalMaterialization: true | undefined = Math.random() > 0.5 ? true : undefined;
  const conditional = await typed.records.query('library', {
    materialize : conditionalMaterialization,
    pagination  : { limit: 20 },
  });
  const conditionalItem: Record<LibraryData> | MaterializedRecord<LibraryData> | undefined = conditional.records[0];
  void conditionalItem;
  // @ts-expect-error a conditional request does not guarantee a materialized record handle.
  void conditional.records[0]?.record;
  if (conditional.records[0] !== undefined && 'record' in conditional.records[0]) {
    const materialized: MaterializedRecord<LibraryData> = conditional.records[0];
    void materialized;
  }

  const titleOnly = await typed.records.query('library', {
    materialize : { children: ['library/title'] },
    pagination  : { limit: 20 },
  });
  const selectedTitleOnly: MaterializedRecord<string> | undefined = titleOnly.records[0]?.children.title;
  void selectedTitleOnly;
  // @ts-expect-error selected child values do not recursively expose children.
  void selectedTitleOnly?.children;
  // @ts-expect-error an eligible but unselected singleton child is not part of the result.
  void titleOnly.records[0]?.children.metadata;

  const selected = await typed.records.query('library', {
    materialize : { children: ['library/title', 'library/metadata'] },
    pagination  : { limit: 20 },
  });
  const selectedRecord = selected.records[0];
  const selectedTitle: MaterializedRecord<string> | undefined = selectedRecord?.children.title;
  const selectedMetadata: MaterializedRecord<MetadataData> | undefined = selectedRecord?.children.metadata;
  void selectedTitle;
  void selectedMetadata;
  // @ts-expect-error only explicitly selected children appear in the materialized shape.
  void selectedRecord?.children.preference;

  const observed: RecordView<NonNullable<typeof selectedRecord>> = await typed.records.observe('library', {
    materialize : { children: ['library/title', 'library/metadata'] },
    pagination  : { limit: 20 },
  });
  const observedTitle: MaterializedRecord<string> | undefined = observed.getSnapshot().records[0]?.children.title;
  void observedTitle;

  const observedInline = await typed.records.observe('library', {
    materialize : { children: ['library/title'] },
    pagination  : { limit: 20 },
  });
  const inlineTitle: string | undefined = observedInline.getSnapshot().records[0]?.children.title?.value;
  void inlineTitle;
  // @ts-expect-error inline inference exposes only selected children.
  void observedInline.getSnapshot().records[0]?.children.metadata;

  const childSelection = { children: ['library/title'] as const } satisfies RecordMaterialization<typeof LibraryDefinition, 'library'>;
  const request = {
    materialize : childSelection,
    pagination  : { limit: 20 },
  } satisfies RecordObserveRequest<typeof LibraryDefinition, 'library', typeof childSelection>;
  const selectedView = await typed.records.observe('library', request);
  type SelectedItem = RecordRepresentation<
    typeof LibraryDefinition,
    typeof LibraryProtocol.codecs,
    'library',
    typeof childSelection
  >;
  const selectedItem: SelectedItem | undefined = selectedView.getSnapshot().records[0];
  const retainedHandle: TypedRecord<LibraryData> | undefined = selectedItem?.record;
  const retainedChild: TypedRecord<string> | undefined = selectedItem?.children.title?.record;
  void retainedHandle;
  void retainedChild;
  // @ts-expect-error canonical selections cannot include collection children.
  const invalidSelection: RecordMaterialization<typeof LibraryDefinition, 'library'> = { children: ['library/attachment'] };
  void invalidSelection;

  const optionalChildren = Math.random() > 0.5 ? childSelection : undefined;
  const conditionalChildren = await typed.records.query('library', {
    materialize : optionalChildren,
    pagination  : { limit: 20 },
  });
  const conditionalChildItem: TypedRecord<LibraryData> | SelectedItem | undefined = conditionalChildren.records[0];
  void conditionalChildItem;
  // @ts-expect-error optional child materialization does not guarantee children.
  void conditionalChildren.records[0]?.children.title;

  // @ts-expect-error an explicit materialized view must include the runtime materialize option.
  await typed.records.observe<'library', true>('library', { pagination: { limit: 20 } });

  const root = await typed.records.set('preference', { data: { theme: 'dark' } });
  const rootValue: PreferenceData = await root.value();
  void rootValue;

  const nested = await typed.records.set('library/title', {
    data   : 'Catalog',
    within : 'library-context',
  });
  const nestedValue: string = await nested.value();
  void nestedValue;

  // @ts-expect-error nested singleton paths require their direct-parent context.
  await typed.records.set('library/title', { data: 'Catalog' });

  // @ts-expect-error root singleton paths do not accept a parent context.
  await typed.records.set('preference', { data: { theme: 'dark' }, within: 'library-context' });

  // @ts-expect-error singleton set operates on the connected tenant's authoritative local scope.
  await typed.records.set('preference', { data: { theme: 'dark' }, from: 'did:example:bob' });

  // @ts-expect-error connected-tenant singleton replacement does not invoke protocol roles.
  await typed.records.set('preference', { data: { theme: 'dark' }, protocolRole: 'member' });

  // @ts-expect-error set() only accepts paths with a literal $recordLimit.max of 1.
  await typed.records.set('library/attachment', {
    data   : new Blob(),
    within : 'library-context',
  });

  await typed.records.query('library', {
    // @ts-expect-error selected children must be direct singleton paths.
    materialize : { children: ['library/attachment'] },
    pagination  : { limit: 20 },
  });

  await typed.records.observe('library', {
    // @ts-expect-error observed child selections reject non-singleton paths without an assertion.
    materialize : { children: ['library/attachment'] },
    pagination  : { limit: 20 },
  });

  await typed.records.query('library', {
    // @ts-expect-error selected descendants must be exactly one edge below the parent.
    materialize : { children: ['library/metadata/preference'] },
    pagination  : { limit: 20 },
  });
}

void assertTypedMaterialization;
