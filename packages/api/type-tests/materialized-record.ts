import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type {
  MaterializedRecord,
  Record,
  RecordPage,
  RecordView,
  TypedEnbox,
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
  const plainPage: RecordPage<Record<LibraryData>> = await typed.records.query('library');
  const plainRecord: Record<LibraryData> | undefined = plainPage.records[0];
  void plainRecord;

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
  // @ts-expect-error a conditional request does not guarantee the materialized representation.
  void conditional.records[0]?.children;

  const titleOnly = await typed.records.query('library', {
    materialize : { children: ['library/title'] as const },
    pagination  : { limit: 20 },
  });
  const selectedTitleOnly: MaterializedRecord<string> | undefined = titleOnly.records[0]?.children.title;
  void selectedTitleOnly;
  // @ts-expect-error selected child values do not recursively expose children.
  void selectedTitleOnly?.children;
  // @ts-expect-error an eligible but unselected singleton child is not part of the result.
  void titleOnly.records[0]?.children.metadata;

  const selected = await typed.records.query('library', {
    materialize : { children: ['library/title', 'library/metadata'] as const },
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
    materialize : { children: ['library/title', 'library/metadata'] as const },
    pagination  : { limit: 20 },
  });
  const observedTitle: MaterializedRecord<string> | undefined = observed.getState().records[0]?.children.title;
  void observedTitle;

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

  await typed.records.query('library', {
    // @ts-expect-error selected descendants must be exactly one edge below the parent.
    materialize : { children: ['library/metadata/preference'] },
    pagination  : { limit: 20 },
  });
}

void assertTypedMaterialization;
