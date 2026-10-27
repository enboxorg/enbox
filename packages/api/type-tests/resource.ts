import type {
  ContextView,
  ContextViewState,
  ExpandableRecordView,
  RecordView,
  RecordViewState,
  ResourceFactory,
  StoreCollection,
  StoreResource,
  StoreResourceState,
} from '@enbox/api';

declare const resource: ResourceFactory;
declare const recordView: RecordView<string>;
declare const expandableView: ExpandableRecordView<string>;
declare const contextView: ContextView<{ id: string }>;
declare const pages: StoreCollection<{ title: string }>;

async function resourceContracts(): Promise<void> {
  const records = resource(async () => recordView);
  const recordState: StoreResourceState<RecordViewState<string>> = records.getSnapshot();
  const optionalRows: readonly string[] | undefined = recordState.records;
  const loadingMore: boolean = recordState.isLoadingMore;
  const ready = await records.ready();
  const rows: readonly string[] = ready.records;
  const freshness: boolean = ready.current;
  const refreshing: Promise<StoreResourceState<RecordViewState<string>>> = records.refresh();
  const retrying: Promise<void> = records.retry();
  const closing: Promise<void> = records.close();
  void optionalRows;
  void loadingMore;
  void rows;
  void freshness;
  void refreshing;
  void retrying;
  void closing;

  const contexts = resource(async () => contextView);
  const contextResource: StoreResource<ContextViewState<{ id: string }>> = contexts;
  const contextState = contexts.getSnapshot();
  const optionalContexts: readonly { id: string }[] | undefined = contextState.contexts;
  const contextReady = await contextResource.ready();
  const contextId: string | undefined = contextReady.contexts[0]?.id;
  void optionalContexts;
  void contextId;

  const expanded = resource(async () => expandableView, { loadAll: true });
  const inferred = resource(signal => {
    signal.throwIfAborted();
    return Promise.resolve(expandableView);
  }, { loadAll: true });
  const inferredRows: readonly string[] = (await inferred.ready()).records;
  void inferredRows;
  const inferredSelection = resource({
    selection : null as string | null,
    open      : (key, signal) => {
      const id: string = key;
      void id;
      signal.throwIfAborted();
      return Promise.resolve(expandableView);
    },
  }, { loadAll: true });
  const inferredSource = resource({
    selection : null as string | null,
    source    : key => { const id: string = key; void id; return pages; },
  }, { loadAll: true });
  void inferredSelection.loadMore();
  void inferredSource.loadMore();
  const pagination: Promise<void> = expanded.loadMore();
  const selected = resource({
    selection : null as string | null,
    open      : async (key: string, signal: AbortSignal) => {
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

  const borrowed = resource({ selection: null as string | null, source: (_key: string) => pages });
  const title: string | undefined = (await borrowed.ready()).records[0]?.value.title;
  void borrowed.select('parent');
  void borrowed.loadMore();
  void borrowed.refresh();
  void title;

  // @ts-expect-error fixed resource owners have no mutable selection.
  void records.select('parent');
  // @ts-expect-error fixed resource state has no selection metadata.
  void records.getSnapshot().selection;
  // @ts-expect-error native record payload is not present before attachment.
  const missingRows: readonly string[] = records.getSnapshot().records;
  void missingRows;
  // @ts-expect-error a non-expandable native view has no loadMore capability.
  void records.loadMore();
  // @ts-expect-error loadAll requires an expandable native view.
  void resource(async () => recordView, { loadAll: true });
  const unsupportedExpansion = { signal: new AbortController().signal, loadAll: true };
  // @ts-expect-error pagination restrictions also apply to options passed by reference.
  void resource(signal => { void signal; return Promise.resolve(recordView); }, unsupportedExpansion);
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
  // @ts-expect-error selection owners expose read resources rather than mutation proxies.
  void borrowed.create;
  // @ts-expect-error keyed resources require explicit selection, even when initially null.
  void resource({ open: async (_key: string, _signal: AbortSignal) => expandableView });
  // @ts-expect-error keyed native opening and borrowing are mutually exclusive.
  void resource({ selection: null as string | null, open: async () => expandableView, source: () => pages });
  // @ts-expect-error borrowed canonical handles resolve synchronously.
  void resource({ selection: null as string | null, source: async () => pages });
  // @ts-expect-error ownership accepts AbortSignal rather than a navigation key.
  void resource(async () => contextView, { signal: 'owner' });
}
void resourceContracts;
