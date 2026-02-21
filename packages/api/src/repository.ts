/**
 * Protocol-aware repository factory.
 *
 * `repository()` takes a `TypedWeb5` instance and returns a Proxy-backed
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
 * const social = repository(web5.using(SocialGraphProtocol));
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
import type { TypedWeb5 } from './typed-web5.js';
import type { ProtocolDefinition, ProtocolRuleSet } from '@enbox/dwn-sdk-js';

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

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
  typed: TypedWeb5<ProtocolDefinition, SchemaMap>,
  path: string,
): Record<string, Function> {
  return {
    async create(options: Record<string, unknown>): Promise<unknown> {
      const { status, record } = await typed.records.create(path, options as never);
      return { status, record, ...status };
    },

    async query(options?: Record<string, unknown>): Promise<unknown> {
      const { status, records, cursor } = await typed.records.query(path, options as never);
      return { status, records, cursor, ...status };
    },

    async get(recordId: string): Promise<unknown> {
      const { record } = await typed.records.read(path, {
        filter: { recordId },
      });
      return record;
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
 */
function buildRootSingletonMethods(
  typed: TypedWeb5<ProtocolDefinition, SchemaMap>,
  path: string,
): Record<string, Function> {
  return {
    async set(options: Record<string, unknown>): Promise<unknown> {
      // Query for existing record
      const { records } = await typed.records.query(path);
      if (records.length > 0) {
        // Update existing
        const { status, record } = await records[0].update({
          data: options.data,
          ...(options.tags !== undefined ? { tags: options.tags } : {}),
        } as never);
        return { status, record, ...status };
      }
      // Create new
      const { status, record } = await typed.records.create(path, options as never);
      return { status, record, ...status };
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
  typed: TypedWeb5<ProtocolDefinition, SchemaMap>,
  path: string,
): Record<string, Function> {
  return {
    async create(parentContextId: string, options: Record<string, unknown>): Promise<unknown> {
      const { status, record } = await typed.records.create(path, {
        ...options,
        parentContextId,
      } as never);
      return { status, record, ...status };
    },

    async query(parentContextId: string, options?: Record<string, unknown>): Promise<unknown> {
      const { status, records, cursor } = await typed.records.query(path, {
        ...options,
        filter: {
          ...(options as Record<string, Record<string, unknown>>)?.filter,
          contextId: parentContextId,
        },
      } as never);
      return { status, records, cursor, ...status };
    },

    async get(recordId: string): Promise<unknown> {
      const { record } = await typed.records.read(path, {
        filter: { recordId },
      });
      return record;
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
 */
function buildNestedSingletonMethods(
  typed: TypedWeb5<ProtocolDefinition, SchemaMap>,
  path: string,
): Record<string, Function> {
  return {
    async set(parentContextId: string, options: Record<string, unknown>): Promise<unknown> {
      // Query for existing record under this parent
      const { records } = await typed.records.query(path, {
        filter: { contextId: parentContextId },
      } as never);

      if (records.length > 0) {
        const { status, record } = await records[0].update({
          data: options.data,
          ...(options.tags !== undefined ? { tags: options.tags } : {}),
        } as never);
        return { status, record, ...status };
      }

      const { status, record } = await typed.records.create(path, {
        ...options,
        parentContextId,
      } as never);
      return { status, record, ...status };
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
  typed: TypedWeb5<ProtocolDefinition, SchemaMap>,
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
 * Creates a protocol-aware repository from a `TypedWeb5` instance.
 *
 * The returned object provides domain-specific CRUD methods that mirror
 * the protocol's structure tree:
 *
 * - Root types: `repo.friend.create()`, `repo.friend.query()`
 * - Nested types: `repo.group.member.create(groupCtxId, { data })`
 * - Singletons: `repo.profile.set()`, `repo.profile.get()`
 * - Protocol install: `repo.configure()`
 *
 * @param typed - A `TypedWeb5` instance from `web5.using(protocol)`.
 * @returns A typed repository object.
 *
 * @example
 * ```ts
 * const social = repository(web5.using(SocialGraphProtocol));
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
>(typed: TypedWeb5<D, M>): Repository<D, M> {
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
            typed as unknown as TypedWeb5<ProtocolDefinition, SchemaMap>,
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
