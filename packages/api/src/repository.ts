/**
 * Protocol-aware repository factory.
 *
 * `repository()` takes a `TypedEnbox` instance and returns a Proxy-backed
 * object whose shape mirrors the protocol's `structure` tree with
 * ergonomic CRUD methods on each node.
 *
 * - **Collections** (default): `create`, `query`, `get`, `delete`, `subscribe`
 * - **Singletons** (`$recordLimit: { max: 1 }`): `set`, `get`, `delete`
 * - **Nested types**: first argument is `parentContextId`
 * - **`configure()`**: idempotent protocol installation
 *
 * @example
 * ```ts
 * const social = repository(enbox.using(SocialGraphProtocol));
 * await social.configure();
 *
 * // Root collection
 * const { record } = await social.friend.create({
 *   data: { did: 'did:example:alice' },
 * });
 *
 * // Nested under group
 * const members = await social.group.member.query(groupContextId);
 * ```
 *
 * @module
 */

import type { DwnResponseStatus } from '@enbox/agent';
import type { Repository } from './repository-types.js';
import type { SchemaMap } from './protocol-types.js';
import type { TypedEnbox } from './typed-enbox.js';
import type { ProtocolDefinition, ProtocolRuleSet } from '@enbox/dwn-sdk-js';

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

/**
 * Checks whether a DWN response status indicates that the record limit
 * has been exceeded. The DWN engine returns a 400 status with a detail
 * message containing "record limit" when `$recordLimit` rejects a write.
 */
function isRecordLimitExceeded(status: { code: number; detail: string }): boolean {
  return status.code === 400 && status.detail.includes('record limit');
}

/**
 * Checks whether a protocol rule set at a given path is a singleton
 * (has `$recordLimit: { max: 1 }`).
 */
function isSingletonPath(definition: ProtocolDefinition, path: string): boolean {
  const segments = path.split('/');
  let node: ProtocolRuleSet | undefined = definition.structure as unknown as ProtocolRuleSet;

  for (const seg of segments) {
    if (!node || typeof node !== 'object') { return false; }
    node = (node as Record<string, ProtocolRuleSet>)[seg];
  }

  if (!node || typeof node !== 'object') { return false; }
  const limit = (node as Record<string, unknown>)['$recordLimit'];
  return limit !== undefined
    && typeof limit === 'object'
    && limit !== null
    && (limit as Record<string, unknown>)['max'] === 1;
}

/**
 * Returns the child type keys (non-`$`-prefixed) of a rule set node
 * reached by the given path.
 */
function getChildKeys(definition: ProtocolDefinition, path: string): string[] {
  const segments = path.split('/');
  let node: Record<string, unknown> = definition.structure as unknown as Record<string, unknown>;

  for (const seg of segments) {
    if (!node || typeof node !== 'object') { return []; }
    node = node[seg] as Record<string, unknown>;
  }

  if (!node || typeof node !== 'object') { return []; }
  return Object.keys(node).filter((k) => !k.startsWith('$'));
}

// ---------------------------------------------------------------------------
// CRUD method builders
// ---------------------------------------------------------------------------

/**
 * Build collection CRUD methods for a root-level path.
 */
function buildRootCollectionMethods(
  typed: TypedEnbox<ProtocolDefinition, SchemaMap>,
  path: string,
): Record<string, Function> {
  return {
    async create(options: Record<string, unknown>): Promise<unknown> {
      const { status, record } = await typed.records.create(path, options as never);
      return { status, record };
    },

    async query(options?: Record<string, unknown>): Promise<unknown> {
      const { status, records, cursor } = await typed.records.query(path, options as never);
      return { status, records, cursor };
    },

    async get(recordId: string): Promise<unknown> {
      const { record } = await typed.records.read(path, {
        filter: { recordId },
      });
      return record; // undefined when the read fails (e.g. 404)
    },

    async delete(recordId: string): Promise<DwnResponseStatus> {
      return typed.records.delete(path, { recordId });
    },

    async subscribe(options?: Record<string, unknown>): Promise<unknown> {
      const { liveQuery } = await typed.records.subscribe(path, options as never);
      return liveQuery;
    },
  };
}

/**
 * Build singleton CRUD methods for a root-level path.
 *
 * Uses a create-first strategy: attempts to create a new record, and if the
 * DWN rejects it because the record limit is reached, falls back to querying
 * the existing record and updating it. This avoids the race condition inherent
 * in query-then-create/update.
 */
function buildRootSingletonMethods(
  typed: TypedEnbox<ProtocolDefinition, SchemaMap>,
  path: string,
): Record<string, Function> {
  return {
    async set(options: Record<string, unknown>): Promise<unknown> {
      // Attempt to create — if limit not yet reached, this succeeds.
      const createResult = await typed.records.create(path, options as never);

      if (isRecordLimitExceeded(createResult.status)) {
        // Record limit hit — query existing and update.
        const { records } = await typed.records.query(path);
        if (records.length > 0) {
          const { status, record } = await records[0].update({
            data: options.data,
            ...(options.tags !== undefined ? { tags: options.tags } : {}),
          } as never);
          return { status, record };
        }
      }

      return { status: createResult.status, record: createResult.record };
    },

    async get(): Promise<unknown> {
      const { records } = await typed.records.query(path);
      return records.length > 0 ? records[0] : undefined;
    },

    async delete(recordId: string): Promise<DwnResponseStatus> {
      return typed.records.delete(path, { recordId });
    },
  };
}

/**
 * Build collection CRUD methods for a nested path.
 */
function buildNestedCollectionMethods(
  typed: TypedEnbox<ProtocolDefinition, SchemaMap>,
  path: string,
): Record<string, Function> {
  return {
    async create(parentContextId: string, options: Record<string, unknown>): Promise<unknown> {
      const { status, record } = await typed.records.create(path, {
        ...options,
        parentContextId,
      } as never);
      return { status, record };
    },

    async query(parentContextId: string, options?: Record<string, unknown>): Promise<unknown> {
      const { status, records, cursor } = await typed.records.query(path, {
        ...options,
        filter: {
          ...(options as Record<string, Record<string, unknown>>)?.filter,
          contextId: parentContextId,
        },
      } as never);
      return { status, records, cursor };
    },

    async get(recordId: string): Promise<unknown> {
      const { record } = await typed.records.read(path, {
        filter: { recordId },
      });
      return record; // undefined when the read fails (e.g. 404)
    },

    async delete(recordId: string): Promise<DwnResponseStatus> {
      return typed.records.delete(path, { recordId });
    },

    async subscribe(parentContextId: string, options?: Record<string, unknown>): Promise<unknown> {
      const { liveQuery } = await typed.records.subscribe(path, {
        ...options,
        filter: {
          ...(options as Record<string, Record<string, unknown>>)?.filter,
          contextId: parentContextId,
        },
      } as never);
      return liveQuery;
    },
  };
}

/**
 * Build singleton CRUD methods for a nested path.
 *
 * Uses the same create-first strategy as root singletons to avoid race
 * conditions between concurrent set() calls.
 */
function buildNestedSingletonMethods(
  typed: TypedEnbox<ProtocolDefinition, SchemaMap>,
  path: string,
): Record<string, Function> {
  return {
    async set(parentContextId: string, options: Record<string, unknown>): Promise<unknown> {
      // Attempt to create under this parent — succeeds if no record exists yet.
      const createResult = await typed.records.create(path, {
        ...options,
        parentContextId,
      } as never);

      if (isRecordLimitExceeded(createResult.status)) {
        // Record limit hit — query existing under this parent and update.
        const { records } = await typed.records.query(path, {
          filter: { contextId: parentContextId },
        } as never);

        if (records.length > 0) {
          const { status, record } = await records[0].update({
            data: options.data,
            ...(options.tags !== undefined ? { tags: options.tags } : {}),
          } as never);
          return { status, record };
        }
      }

      return { status: createResult.status, record: createResult.record };
    },

    async get(parentContextId: string): Promise<unknown> {
      const { records } = await typed.records.query(path, {
        filter: { contextId: parentContextId },
      } as never);
      return records.length > 0 ? records[0] : undefined;
    },

    async delete(recordId: string): Promise<DwnResponseStatus> {
      return typed.records.delete(path, { recordId });
    },
  };
}

// ---------------------------------------------------------------------------
// Node builder
// ---------------------------------------------------------------------------

/**
 * Build a repository node for a given path, including CRUD methods
 * and Proxy-based child nodes.
 */
function buildNode(
  typed: TypedEnbox<ProtocolDefinition, SchemaMap>,
  definition: ProtocolDefinition,
  path: string,
  isNested: boolean,
): Record<string, unknown> {
  const singleton = isSingletonPath(definition, path);

  // Build CRUD methods based on root/nested and singleton/collection
  let methods: Record<string, Function>;
  if (isNested) {
    methods = singleton
      ? buildNestedSingletonMethods(typed, path)
      : buildNestedCollectionMethods(typed, path);
  } else {
    methods = singleton
      ? buildRootSingletonMethods(typed, path)
      : buildRootCollectionMethods(typed, path);
  }

  // Use a Proxy to lazily build child nodes
  const childKeys = getChildKeys(definition, path);
  const childCache: Record<string, unknown> = {};

  return new Proxy(methods, {
    get(target: Record<string, unknown>, prop: string | symbol): unknown {
      if (typeof prop !== 'string') { return undefined; }

      // CRUD methods take priority
      if (prop in target) { return target[prop]; }

      // Lazily build child nodes
      if (childKeys.includes(prop)) {
        if (!(prop in childCache)) {
          childCache[prop] = buildNode(typed, definition, `${path}/${prop}`, true);
        }
        return childCache[prop];
      }

      return undefined;
    },
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a protocol-aware repository from a `TypedEnbox` instance.
 *
 * The returned object provides domain-specific CRUD methods that mirror
 * the protocol's structure tree:
 *
 * - Root types: `repo.friend.create()`, `repo.friend.query()`
 * - Nested types: `repo.group.member.create(groupCtxId, { data })`
 * - Singletons: `repo.profile.set()`, `repo.profile.get()`
 * - Protocol install: `repo.configure()`
 *
 * @param typed - A `TypedEnbox` instance from `enbox.using(protocol)`.
 * @returns A typed repository object.
 *
 * @example
 * ```ts
 * const social = repository(enbox.using(SocialGraphProtocol));
 * await social.configure();
 *
 * const rec = await social.friend.create({
 *   data: { did: 'did:example:alice' },
 * });
 * const friends = await social.friend.query();
 * ```
 */
export function repository<
  D extends ProtocolDefinition,
  M extends SchemaMap,
>(typed: TypedEnbox<D, M>): Repository<D, M> {
  const definition = typed.definition as ProtocolDefinition;

  // Get root-level type keys from the structure
  const rootKeys = Object.keys(definition.structure).filter((k) => !k.startsWith('$'));
  const nodeCache: Record<string, unknown> = {};

  const proxy = new Proxy({} as Record<string, unknown>, {
    get(_target: Record<string, unknown>, prop: string | symbol): unknown {
      if (typeof prop !== 'string') { return undefined; }

      // configure() method
      if (prop === 'configure') {
        return async (options?: { encryption?: boolean }): Promise<DwnResponseStatus> => {
          const result = await typed.configure(options);
          return result;
        };
      }

      // Root-level type nodes
      if (rootKeys.includes(prop)) {
        if (!(prop in nodeCache)) {
          nodeCache[prop] = buildNode(
            typed as unknown as TypedEnbox<ProtocolDefinition, SchemaMap>,
            definition,
            prop,
            false,
          );
        }
        return nodeCache[prop];
      }

      return undefined;
    },
  });

  return proxy as unknown as Repository<D, M>;
}
