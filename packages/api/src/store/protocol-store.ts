import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import type { RecordCodecMap } from '../record-codec.js';
import type { RecordQuery } from '../record-query.js';
import type { StoreCollectionResource } from './resource.js';
import type { StoreCommand } from './command.js';
import type { StoreScope } from './scope.js';
import type { ContextRoleGroups, ProtocolPaths, ProtocolRolePaths, TypedProtocol } from '../protocol-types.js';
import type {
  DataForPath,
  RecordPatchInput,
  TypedCreateRequest,
  TypedEnbox,
  TypedMaterializedRecord,
  TypedRecord,
} from '../typed-enbox.js';

import { assertValidRecordWithin } from '../record-query.js';
import { createCollectionResource } from './resource.js';
import { createCommand } from './command.js';
import { collectProtocolPaths, isProtocolRolePath } from '../protocol-paths.js';

type DefinitionOf<P extends TypedProtocol> = P['definition'];
type CodecsOf<P extends TypedProtocol> = P['codecs'];
type GroupsOf<P extends TypedProtocol> = P['roleGroups'];
type CollectionPath<P extends TypedProtocol> = Exclude<ProtocolPaths<DefinitionOf<P>>, ProtocolRolePaths<DefinitionOf<P>>> & string;

/**
 * Shared materialized rows and commands for one locally owned path and direct parent.
 * Accepted writes refresh retained selections before completion; reread failures remain query errors.
 * Collection state reports replication freshness separately from write acceptance.
 */
export interface StoreCollection<Value> extends StoreCollectionResource<TypedMaterializedRecord<Value>> {
  /** Create a record using the protocol codec and this collection's parent scope. */
  readonly create: StoreCommand<Value, TypedRecord<Value>>;
  /** Apply a native patch or pure producer after checking the record's direct parent. */
  readonly patch: StoreCommand<Readonly<{ id: string; patch: RecordPatchInput<Value> }>, TypedRecord<Value>>;
  /** Delete a record by ID within this collection's parent scope. */
  readonly delete: StoreCommand<string, void>;
}

/** Keyed locally owned collections for one nested protocol path. */
export interface StoreCollectionFamily<Value> {
  /** Resolve a stable handle for an exact direct-parent context ID without opening a view. */
  within(parentContextId: string): StoreCollection<Value>;
}

/** Native typed filters and ordering, with an explicit optional window size. */
export type StoreCollectionOptions<
  P extends TypedProtocol,
  Path extends CollectionPath<P>,
> = Omit<RecordQuery<DefinitionOf<P>, Path>, 'from' | 'within' | 'protocolRole' | 'pagination'> & Readonly<{
  /** Initial row limit and loadMore() increment; defaults to 20 and must be a positive safe integer. */
  pagination?: Readonly<{ limit: number }>;
  /** Expand all matching local pages; ready() waits for that expansion when enabled. */
  loadAll?: boolean;
}>;

/** Session-scoped protocol bindings that retain path and payload types without opening storage. */
export interface ProtocolStore<P extends TypedProtocol> {
  /** The original protocol definition and codecs. */
  readonly protocol: P;
  /** Resolve native operations inside a domain command; accessing this requires a usable authorization scope. */
  readonly records: TypedEnbox<DefinitionOf<P>, CodecsOf<P>, GroupsOf<P>>['records'];
  /**
   * Resolve a shared selection, or a keyed family for a nested path, without opening a view.
   * Filters and pagination affect reads; commands retain their protocol path and parent scope.
   */
  collection<Path extends CollectionPath<P>>(
    path: Path,
    options?: StoreCollectionOptions<P, NoInfer<Path>>,
  ): Path extends `${string}/${string}`
    ? StoreCollectionFamily<DataForPath<CodecsOf<P>, Path>>
    : StoreCollection<DataForPath<CodecsOf<P>, Path>>;
}

/** @internal Create inert protocol bindings owned by one captured authorization scope. */
export function createProtocolStore<P extends TypedProtocol>(protocol: P, scope: StoreScope): ProtocolStore<P> {
  return createTypedProtocolStore(protocol, scope) as unknown as ProtocolStore<P>;
}

function createTypedProtocolStore<
  D extends ProtocolDefinition,
  C extends RecordCodecMap,
  G extends ContextRoleGroups,
>(protocol: TypedProtocol<D, C, G>, scope: StoreScope): ProtocolStore<TypedProtocol<D, C, G>> {
  type P = TypedProtocol<D, C, G>;
  const collections = new Map<string, unknown>();
  const commandsByScope = new Map<string, unknown>();
  const refreshersByScope = new Map<string, Set<() => Promise<void>>>();
  const typed = (): TypedEnbox<D, C, G> => {
    scope.assertCurrent();
    return scope.getEnbox().using<D, C, G>(protocol);
  };

  const makeCollection = <Path extends CollectionPath<P>>(
    path: Path,
    options: StoreCollectionOptions<P, Path>,
    within?: string,
  ): StoreCollection<DataForPath<C, Path>> => {
    type Value = DataForPath<C, Path>;
    type Commands = Pick<StoreCollection<Value>, 'create' | 'patch' | 'delete'>;
    const mutationKey = JSON.stringify([path, within]);
    let refreshers = refreshersByScope.get(mutationKey);
    if (refreshers === undefined) {
      refreshers = new Set();
      refreshersByScope.set(mutationKey, refreshers);
    }
    const refreshActive = async (): Promise<void> => {
      // A completed write remains successful even if its canonical reread fails.
      // Each acquired resource publishes its own materialization failure.
      await Promise.all([...refreshers].map(refresh => refresh().catch((): void => {})));
    };
    const resource = createCollectionResource<TypedMaterializedRecord<Value>>(scope, (signal) => typed().records.observe<Path, true>(path, {
      dateSort    : options.dateSort,
      filter      : options.filter,
      materialize : true,
      pagination  : { limit: options.pagination?.limit ?? 20 },
      signal,
      within,
    }), { loadAll: options.loadAll });
    refreshers.add(resource.refreshIfActive);

    const assertParent = async (id: string): Promise<void> => {
      if (within === undefined) { return; }
      // Native patch is path-bound; the preflight also enforces this collection's direct parent.
      const record = await typed().records.read(path, id);
      scope.assertCurrent();
      if (record !== undefined && record.contextId.split('/').slice(0, -1).join('/') !== within) {
        throw new TypeError(`Store collection: record '${id}' belongs to another parent context.`);
      }
    };

    if (!commandsByScope.has(mutationKey)) {
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
          await assertParent(id);
          scope.assertCurrent();
          const record = await typed().records.patch(path, id, patch);
          await refreshActive();
          return record;
        }),
        delete: createCommand<string, void>(scope, async (id) => {
          await assertParent(id);
          scope.assertCurrent();
          await typed().records.delete(path, { recordId: id, within });
          await refreshActive();
        }),
      };
      commandsByScope.set(mutationKey, commands);
    }
    // Mutation identity depends on path and direct parent, independently of
    // any collection's read filter, window size or retained state.
    return Object.assign(resource, commandsByScope.get(mutationKey) as Commands);
  };

  return {
    protocol,
    get records(): TypedEnbox<D, C, G>['records'] { return typed().records; },
    collection: <Path extends CollectionPath<P>>(
      path: Path,
      requested: StoreCollectionOptions<P, NoInfer<Path>> = {},
    ): Path extends `${string}/${string}` ? StoreCollectionFamily<DataForPath<C, Path>> : StoreCollection<DataForPath<C, Path>> => {
      assertCollectionPath(protocol.definition, path);
      for (const key of ['from', 'within', 'protocolRole', 'materialize', 'signal']) {
        if (Object.hasOwn(requested, key)) {
          throw new TypeError(`Store collection: '${key}' is owned by the collection scope.`);
        }
      }
      const options = structuredClone(requested);
      const limit = options.pagination?.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new RangeError('Store collection: pagination.limit must be a positive safe integer.');
      }
      const key = JSON.stringify([path, canonicalValue({ ...options, pagination: { limit }, loadAll: options.loadAll === true })]);
      if (!collections.has(key)) {
        if (path.includes('/')) {
          const parents = new Map<string, StoreCollection<DataForPath<C, Path>>>();
          collections.set(key, Object.freeze({
            within: (parentContextId: string): StoreCollection<DataForPath<C, Path>> => {
              assertDirectParent(path, parentContextId);
              let collection = parents.get(parentContextId);
              if (collection === undefined) {
                collection = makeCollection(path, options, parentContextId);
                parents.set(parentContextId, collection);
              }
              return collection;
            },
          }));
        } else {
          collections.set(key, makeCollection(path, options));
        }
      }
      // The key contains the exact path and selection; its resource's value
      // type is therefore the codec associated with this same generic Path.
      return collections.get(key) as Path extends `${string}/${string}`
        ? StoreCollectionFamily<DataForPath<C, Path>>
        : StoreCollection<DataForPath<C, Path>>;
    },
  };
}

function assertCollectionPath(definition: ProtocolDefinition, path: string): void {
  if (!collectProtocolPaths(definition.structure).has(path)) {
    throw new TypeError(`Store collection: unknown protocol path '${path}'.`);
  }
  if (isProtocolRolePath(definition, path)) {
    throw new TypeError('Store collection: role records use the context membership API.');
  }
}

function assertDirectParent(path: string, within: string): void {
  assertValidRecordWithin(path, within, true);
  if (within.split('/').length !== path.split('/').length - 1) {
    throw new TypeError(`Store collection: '${path}' requires its exact direct parent context ID.`);
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) { return value.map(canonicalValue); }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonicalValue(entry)]));
  }
  return value;
}
