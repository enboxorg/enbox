import type { ModuleDefinition, ResolvedModuleGraph, ResolvedModuleNode } from '@enbox/dwn-sdk-js';

import type { ObservedCollection } from './observed-store.js';
import type { RecordCodecMap } from '../record-codec.js';
import type { RecordQuery } from '../record-query.js';
import type { StoreCommand } from './command.js';
import type { StoreScope } from './scope.js';
import type {
  DataForPath,
  RecordPatchInput,
  TypedCreateRequest,
  TypedEnbox,
  TypedMaterializedRecord,
  TypedRecord,
} from '../typed-enbox.js';
import type { ModulePaths, ModuleRolePaths, SingletonModulePaths, TypedModule } from '../module-types.js';

import { canonicalJsonStringify } from '@enbox/common';
import { createCommand } from './command.js';
import { createObservedCollection } from './observed-store.js';
import { Records } from '@enbox/dwn-sdk-js';
import { resolveTypedModuleGraph } from '../define-module.js';
import { assertValidRecordWithin, resolveRecordQueryNode } from '../record-query.js';

type DefinitionOf<P extends TypedModule> = P['definition'];
type CodecsOf<P extends TypedModule> = P['codecs'];
type CollectionPath<P extends TypedModule> = Exclude<
  ModulePaths<DefinitionOf<P>>,
  ModuleRolePaths<DefinitionOf<P>> | SingletonModulePaths<DefinitionOf<P>>
> & string;

/**
 * Shared materialized rows and commands for one locally owned path and direct parent.
 * Accepted writes refresh retained selections before completion; reread failures remain query errors.
 * Collection state reports replication freshness separately from write acceptance.
 * Patch and delete require a non-empty record ID, independently of read filters.
 */
export interface StoreCollection<Value> extends ObservedCollection<TypedMaterializedRecord<Value>> {
  /** Create a record using the module codec and this collection's parent scope. */
  readonly create: StoreCommand<Value, TypedRecord<Value>>;
  /** Apply a native patch or pure producer after checking the record's direct parent. */
  readonly patch: StoreCommand<Readonly<{ id: string; patch: RecordPatchInput<Value> }>, TypedRecord<Value>>;
  /** Read before deleting within this path and parent; absence is a no-op, and read authorization is required. */
  readonly delete: StoreCommand<string, void>;
}

/** Keyed locally owned collections for one nested module path. */
export interface StoreCollectionFamily<Value> {
  /** Resolve a stable handle for an exact direct-parent context ID without opening a view. */
  within(parentContextId: string): StoreCollection<Value>;
}

/** Native typed filters and ordering, with an explicit optional window size. */
export type StoreCollectionOptions<
  P extends TypedModule,
  Path extends CollectionPath<P>,
> = Omit<RecordQuery<DefinitionOf<P>, Path>, 'from' | 'within' | 'moduleRole' | 'pagination'> & Readonly<{
  /** Initial row limit and loadMore() increment; defaults to 20 and must be a positive safe integer. */
  pagination?: Readonly<{ limit: number }>;
  /** Expand all matching local pages; ready() waits for that expansion when enabled. */
  loadAll?: boolean;
}>;

/** Session-scoped module bindings that retain path and payload types without opening storage. */
export interface ModuleStore<P extends TypedModule> {
  /** The original module definition and codecs. */
  readonly module: P;
  /**
   * Resolve the native SDK inside a command or observation opener; invocation requires a usable authorization scope.
   * Capturing this method in a factory is inert. The returned handle follows native SDK lifetimes;
   * its operations do not acquire collection-command progress or wait for collection views to refresh.
   */
  native(): TypedEnbox<DefinitionOf<P>, CodecsOf<P>>;
  /**
   * Resolve a shared selection, or a keyed family for a nested path, without opening a view.
   * Filters and pagination affect reads; commands retain their module path and parent scope.
   * Module-declared singleton slots use native().records.set() instead.
   */
  collection<Path extends CollectionPath<P>>(
    path: Path,
    options?: StoreCollectionOptions<P, NoInfer<Path>>,
  ): Path extends `${string}/${string}`
    ? StoreCollectionFamily<DataForPath<CodecsOf<P>, Path>>
    : StoreCollection<DataForPath<CodecsOf<P>, Path>>;
}

/** @internal Create inert module bindings owned by one captured authorization scope. */
export function createModuleStore<P extends TypedModule>(module: P, scope: StoreScope): ModuleStore<P> {
  return createTypedModuleStore(module, scope) as unknown as ModuleStore<P>;
}

function createTypedModuleStore<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
>(module: TypedModule<D, C>, scope: StoreScope): ModuleStore<TypedModule<D, C>> {
  type P = TypedModule<D, C>;
  const graph = resolveTypedModuleGraph(module);
  const collections = new Map<string, unknown>();
  const writeScopes = new Map<string, { commands: unknown; refreshers: Set<() => Promise<void>> }>();
  const typed = (): TypedEnbox<D, C> => {
    return scope.getEnbox().using<D, C>(module);
  };

  const makeCollection = <Path extends CollectionPath<P>>(
    path: Path,
    options: StoreCollectionOptions<P, Path>,
    within?: string,
  ): StoreCollection<DataForPath<C, Path>> => {
    type Value = DataForPath<C, Path>;
    type Commands = Pick<StoreCollection<Value>, 'create' | 'patch' | 'delete'>;
    const mutationKey = JSON.stringify([path, within]);
    let writeScope = writeScopes.get(mutationKey);
    const refreshers = writeScope?.refreshers ?? new Set<() => Promise<void>>();
    const collection = createObservedCollection<TypedMaterializedRecord<Value>>(scope, (signal) => typed().records.observe<Path, true>(path, {
      dateSort    : options.dateSort,
      filter      : options.filter,
      materialize : true,
      pagination  : { limit: options.pagination?.limit ?? 20 },
      signal,
      within,
    }), {
      loadAll             : options.loadAll,
      onObservationChange : (active, refresh): void => {
        if (active) { refreshers.add(refresh); }
        else { refreshers.delete(refresh); }
      },
    });

    if (writeScope === undefined) {
      const refreshActive = async (): Promise<void> => {
        // A completed write remains successful even if its canonical reread fails.
        // Each observed collection publishes its own materialization failure.
        await Promise.all([...refreshers].map(refresh => refresh().catch((): void => {})));
      };
      const readScopedRecord = async (id: string): Promise<TypedRecord<Value> | undefined> => {
        // RecordsDelete identifies a record by ID; validate path membership before dispatch.
        const record = await typed().records.read(path, id);
        scope.assertCurrent();
        if (record !== undefined && within !== undefined && Records.getParentContextFromOfContextId(record.contextId) !== within) {
          throw new TypeError(`Store collection: record '${id}' belongs to another parent context.`);
        }
        return record;
      };
      const commands: Commands = {
        create: createCommand<Value, TypedRecord<Value>>(scope, async (data) => {
          // Collection paths reject roles at construction, so the native conditional
          // role-recipient requirement never applies to this data-only request.
          const request = { data, ...(within === undefined ? {} : { parentContextId: within }) } as TypedCreateRequest<D, C, Path>;
          const record = await typed().records.create(path, request);
          await refreshActive();
          return record;
        }),
        patch: createCommand<Readonly<{ id: string; patch: RecordPatchInput<Value> }>, TypedRecord<Value>>(scope, async ({ id, patch }) => {
          assertRecordId(id);
          if (within !== undefined) { await readScopedRecord(id); }
          scope.assertCurrent();
          const record = await typed().records.patch(path, id, patch);
          await refreshActive();
          return record;
        }),
        delete: createCommand<string, void>(scope, async (id) => {
          assertRecordId(id);
          const record = await readScopedRecord(id);
          if (record !== undefined) {
            scope.assertCurrent();
            await typed().records.delete(path, { recordId: id, within });
          }
          await refreshActive();
        }),
      };
      writeScope = { commands, refreshers };
      writeScopes.set(mutationKey, writeScope);
    }
    // Mutation identity depends on path and direct parent, independently of
    // any collection's read filter, window size or retained state.
    return Object.assign(collection, writeScope.commands as Commands);
  };

  return {
    module,
    native     : typed,
    collection : <Path extends CollectionPath<P>>(
      path: Path,
      requested: StoreCollectionOptions<P, NoInfer<Path>> = {},
    ): Path extends `${string}/${string}` ? StoreCollectionFamily<DataForPath<C, Path>> : StoreCollection<DataForPath<C, Path>> => {
      const node = assertCollectionPath(graph, path);
      for (const key of ['from', 'within', 'moduleRole', 'materialize', 'signal']) {
        if (Object.hasOwn(requested, key)) {
          throw new TypeError(`Store collection: '${key}' is owned by the collection scope.`);
        }
      }
      const cloned = structuredClone(requested);
      const options = {
        ...cloned,
        filter: cloned.filter !== undefined && Object.keys(cloned.filter).length === 0 ? undefined : cloned.filter,
      };
      if (options.loadAll !== undefined && typeof options.loadAll !== 'boolean') {
        throw new TypeError('Store collection: loadAll must be a boolean.');
      }
      const limit = options.pagination?.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new RangeError('Store collection: pagination.limit must be a positive safe integer.');
      }
      const key = canonicalJsonStringify([path, { ...options, pagination: { limit }, loadAll: options.loadAll === true }]);
      if (!collections.has(key)) {
        if (node.parentPhysicalDepth > 0) {
          const parents = new Map<string, StoreCollection<DataForPath<C, Path>>>();
          const family: StoreCollectionFamily<DataForPath<C, Path>> = {
            within: (parentContextId: string): StoreCollection<DataForPath<C, Path>> => {
              assertDirectParent(graph, path, parentContextId);
              let collection = parents.get(parentContextId);
              if (collection === undefined) {
                collection = makeCollection(path, options, parentContextId);
                parents.set(parentContextId, collection);
              }
              return collection;
            },
          };
          collections.set(key, Object.freeze(family));
        } else {
          collections.set(key, makeCollection(path, options));
        }
      }
      // The key contains the exact path and selection; its collection's value
      // type is therefore the codec associated with this same generic Path.
      return collections.get(key) as Path extends `${string}/${string}`
        ? StoreCollectionFamily<DataForPath<C, Path>>
        : StoreCollection<DataForPath<C, Path>>;
    },
  };
}

function assertCollectionPath(graph: ResolvedModuleGraph, path: string): ResolvedModuleNode {
  const node = graph.nodesByDeclaredPath.get(path);
  if (node?.kind !== 'record') {
    throw new TypeError(`Store collection: unknown module path '${path}'.`);
  }
  if (node.ruleSet.$role === true) {
    throw new TypeError('Store collection: role records use the context membership API.');
  }
  if (node.ruleSet.$recordLimit?.max === 1) {
    throw new TypeError('Store collection: singleton paths use native().records.set().');
  }
  return node;
}

function assertDirectParent(graph: ResolvedModuleGraph, path: string, within: string): void {
  const node = resolveRecordQueryNode(graph, path);
  assertValidRecordWithin(node, within, true);
  if (within.split('/').length !== node.parentPhysicalDepth) {
    throw new TypeError(`Store collection: '${path}' requires its exact direct parent context ID.`);
  }
}

function assertRecordId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('Store collection: record ID must be a non-empty string.');
  }
}
