import type {
  ContextView,
  ContextViewState,
  ExpandableRecordView,
  ObservationFactory,
  ObservedStore,
  ObservedStoreState,
  RecordView,
  RecordViewState,
  StoreCollection,
} from '@enbox/api';

declare const observe: ObservationFactory;
declare const recordView: RecordView<string>;
declare const expandableView: ExpandableRecordView<string>;
declare const contextView: ContextView<{ id: string }>;
declare const pages: StoreCollection<{ title: string }>;

async function observationContracts(): Promise<void> {
  const records = observe(async () => recordView);
  const recordState: ObservedStoreState<RecordViewState<string>> = records.getSnapshot();
  const optionalRows: readonly string[] | undefined = recordState.records;
  const loadingMore: boolean = recordState.isLoadingMore;
  const ready = await records.ready();
  const rows: readonly string[] = ready.records;
  const freshness: boolean = ready.current;
  const refreshing: Promise<ObservedStoreState<RecordViewState<string>>> = records.refresh();
  const retrying: Promise<void> = records.retry();
  const closing: Promise<void> = records.close();
  void optionalRows;
  void loadingMore;
  void rows;
  void freshness;
  void refreshing;
  void retrying;
  void closing;

  const contexts = observe(async () => contextView);
  const contextStore: ObservedStore<ContextViewState<{ id: string }>> = contexts;
  const contextState = contexts.getSnapshot();
  const optionalContexts: readonly { id: string }[] | undefined = contextState.contexts;
  const contextReady = await contextStore.ready();
  const contextId: string | undefined = contextReady.contexts[0]?.id;
  void optionalContexts;
  void contextId;

  const expanded = observe(async () => expandableView, { loadAll: true });
  const inferred = observe(signal => {
    signal.throwIfAborted();
    return Promise.resolve(expandableView);
  }, { loadAll: true });
  const inferredRows: readonly string[] = (await inferred.ready()).records;
  void inferredRows;
  const inferredSelection = observe({
    open: (key: string, signal) => {
      const id: string = key;
      void id;
      signal.throwIfAborted();
      return Promise.resolve(expandableView);
    },
  }, { loadAll: true });
  const inferredSource = observe({
    source: (key: string) => { const id: string = key; void id; return pages; },
  }, { loadAll: true });
  void inferredSelection.loadMore();
  void inferredSource.loadMore();
  const pagination: Promise<void> = expanded.loadMore();
  const selected = observe({
    open: async (key: string, signal: AbortSignal) => {
      void key;
      void signal;
      return expandableView;
    },
  }, { loadAll: true });
  const selecting: Promise<void> = selected.select('parent');
  const clearing: Promise<void> = selected.select(null);
  const selectedKey: string | null = selected.getSnapshot().selection;
  const selectedRows: readonly string[] = (await selected.ready()).records;
  const stop = selected.subscribe((state): void => {
    const key: string | null = state.selection;
    void key;
  });
  void pagination;
  void selecting;
  void clearing;
  void selectedKey;
  void selectedRows;
  void stop;

  const borrowed = observe({ source: (_key: string) => pages });
  const title: string | undefined = (await borrowed.ready()).records[0]?.value.title;
  void borrowed.select('parent');
  void borrowed.loadMore();
  void borrowed.refresh();
  void title;

  // @ts-expect-error fixed observe owners have no mutable selection.
  void records.select('parent');
  // @ts-expect-error fixed observe state has no selection metadata.
  void records.getSnapshot().selection;
  // @ts-expect-error native record payload is not present before attachment.
  const missingRows: readonly string[] = records.getSnapshot().records;
  void missingRows;
  // @ts-expect-error a non-expandable native view has no loadMore capability.
  void records.loadMore();
  // @ts-expect-error loadAll requires an expandable native view.
  void observe(async () => recordView, { loadAll: true });
  const unsupportedExpansion = { signal: new AbortController().signal, loadAll: true };
  // @ts-expect-error pagination restrictions also apply to options passed by reference.
  void observe(signal => { void signal; return Promise.resolve(recordView); }, unsupportedExpansion);
  // @ts-expect-error context catalogs publish contexts, not fabricated records.
  void contexts.getSnapshot().records;
  // @ts-expect-error contexts have no replication-current field.
  void contextReady.current;
  // @ts-expect-error ContextView has no native refresh operation.
  void contexts.refresh();
  // @ts-expect-error ContextView has no pagination operation.
  void contexts.loadMore();
  // @ts-expect-error the selection key is inferred and cannot be numeric.
  void selected.select(1);
  // @ts-expect-error selection metadata is immutable.
  selected.getSnapshot().selection = null;
  // @ts-expect-error row collections are immutable.
  ready.records.push('mutation');
  // @ts-expect-error selection owners expose read stores rather than mutation proxies.
  void borrowed.create;
  // @ts-expect-error selectable stores begin empty; the constructor does not select an input.
  void observe({ selection: 'parent', open: async (_key: string, _signal: AbortSignal) => expandableView });
  // @ts-expect-error selectable native opening and borrowing are mutually exclusive.
  void observe({ open: async () => expandableView, source: () => pages });
  // @ts-expect-error borrowed canonical handles resolve synchronously.
  void observe({ source: async () => pages });
  // @ts-expect-error ownership accepts AbortSignal rather than a navigation key.
  void observe(async () => contextView, { signal: 'owner' });
}
void observationContracts;
