import type { StoreCollectionSelection, StoreCollectionSelectionState, StoreInstance, TypedMaterializedRecord } from '@enbox/api';

import { defineProtocol, defineStore, recordCodecs } from '@enbox/api';

type Page = { title: string; pinned: boolean };
const Protocol = defineProtocol({
  protocol  : 'https://example.com/protocols/collection-selection-types',
  published : false,
  types     : {
    notebook : { dataFormats: ['application/json'] },
    page     : { dataFormats: ['application/json'] },
  },
  structure: { notebook: { page: {} } },
} as const, {
  notebook : recordCodecs.json<{ name: string }>(),
  page     : recordCodecs.json<Page>(),
});

const Feature = defineStore({
  protocols: { notes: Protocol },
  create({ protocols }) {
    const pages = protocols.notes.collection('notebook/page');
    return { pages, activePages: pages.createSelection(), notebooks: protocols.notes.collection('notebook') };
  },
});
void Feature;

declare const feature: StoreInstance<typeof Feature>;
const selected: StoreCollectionSelection<TypedMaterializedRecord<Page>> = feature.activePages;
const state: StoreCollectionSelectionState<TypedMaterializedRecord<Page>> = selected.getSnapshot();
const parent: string | null = state.parentContextId;
const title: string | undefined = state.records[0]?.value.title;
const rows: readonly TypedMaterializedRecord<Page>[] = selected.getServerSnapshot().records;
const selecting: Promise<void> = selected.select('notebook-id');
const clearing: Promise<void> = selected.select(null);
const stop: () => void = selected.subscribe((next): void => {
  const nextParent: string | null = next.parentContextId;
  void nextParent;
});
const caller = new AbortController();
const comparison = feature.pages.createSelection({ signal: caller.signal });
void comparison.select('another-notebook');
void feature.pages.within('background-notebook').create.run({ title: 'Background page', pinned: false });
const closed: void = comparison.close();
void parent;
void title;
void rows;
void selecting;
void clearing;
void stop;
void closed;

// @ts-expect-error selected rows retain their protocol codec's data shape.
void state.records[0]?.value.missing;
// @ts-expect-error the published parent and rows are read-only state.
state.parentContextId = null;
// @ts-expect-error the row array is immutable.
state.records.push({});
// @ts-expect-error every select call supplies a parent or explicitly clears it.
void selected.select();
// @ts-expect-error parent context IDs are strings, not numeric navigation indices.
void selected.select(1);
// @ts-expect-error selection owners have no global family mutation API.
void feature.pages.select('notebook-id');
// @ts-expect-error a root collection has no parent-selection factory.
void feature.notebooks.createSelection();
// @ts-expect-error commands remain on canonical family handles rather than mutable selection proxies.
void selected.create;
// @ts-expect-error read controls remain on canonical collection handles.
void selected.loadMore;
// @ts-expect-error parent metadata is published in the atomic state, not a separate getter.
void selected.contextId;
// @ts-expect-error caller ownership accepts an AbortSignal.
void feature.pages.createSelection({ signal: 'owner' });
