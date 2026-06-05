import type { Filter } from '../types/query-types.js';
import type { Hash } from '../types/smt-types.js';
import type { MessageStore, MessageStoreOptions } from '../types/message-store.js';

import { DwnInterfaceName } from '../enums/dwn-interface-method.js';
import { FilterUtility } from '../utils/filter.js';
import { hashToHex } from '../smt/smt-utils.js';
import { lexicographicalCompare } from '../utils/string.js';
import { Message } from '../core/message.js';
import { SMTStoreMemory } from '../smt/smt-store-memory.js';
import { SparseMerkleTree } from '../smt/sparse-merkle-tree.js';

/**
 * Projection-root algorithm for record-primary scoped subsets.
 *
 * This version builds an on-demand SMT over latest Records primary message CIDs
 * selected by protocol plus optional exact protocolPath or context subtree.
 * Dependency records, protocol configs, and record data payloads are not part
 * of this root.
 */
export const RECORDS_PROJECTION_ROOT_VERSION = 'records-primary-scope-root-v1';

/**
 * A Records primary projection scope.
 *
 * `protocolPath` is an exact type-path match. `contextId` is a boundary-aware
 * subtree match: the candidate context must equal the scoped context or start
 * with `${contextId}/`. `protocolPath` and `contextId` are mutually exclusive.
 */
export type RecordsProjectionScope = {
  protocol: string;
  protocolPath?: string;
  contextId?: string;
};

export type RecordsProjectionInput = {
  tenant: string;
  messageStore: MessageStore;
  scopes: readonly [RecordsProjectionScope, ...RecordsProjectionScope[]];
  options?: MessageStoreOptions;
};

export type RecordsProjectionTreeInput = RecordsProjectionInput & {
  prefix: boolean[];
};

export type RecordsProjectionSnapshot = {
  getRoot(): Promise<Hash>;
  getRootHex(): Promise<string>;
  getSubtreeHash(prefix: boolean[]): Promise<Hash>;
  getLeaves(prefix: boolean[]): Promise<string[]>;
  close(): Promise<void>;
};

export type NormalizedRecordsProjectionScope = {
  protocol: string;
} | {
  protocol: string;
  protocolPath: string;
} | {
  protocol: string;
  contextId: string;
};

/**
 * Computes deterministic on-demand roots for Records projections.
 *
 * The snapshot API performs one store enumeration and serves tree operations
 * from that in-memory view. A future store-level snapshot/high-watermark can be
 * threaded through the `options` input without changing the projection shape.
 */
export class RecordsProjection {

  /**
   * Returns the sorted latest Records primary message CIDs covered by a scope union.
   */
  public static async getPrimaryMessageCids({
    tenant,
    messageStore,
    scopes,
    options,
  }: RecordsProjectionInput): Promise<string[]> {
    const filters = RecordsProjection.normalizeScopes(scopes)
      .flatMap(scope => RecordsProjection.constructFilters(scope));

    const { messages } = await messageStore.query(tenant, filters, undefined, undefined, options);
    const messageCids = await Promise.all(messages.map(message => Message.getCid(message)));

    return [...new Set(messageCids)].sort(lexicographicalCompare); // NOSONAR — projection IDs require locale-independent bytewise ordering.
  }

  /**
   * Returns the projection root hash.
   */
  public static async getRoot(input: RecordsProjectionInput): Promise<Hash> {
    return RecordsProjection.withTree(input, tree => tree.getRoot());
  }

  /**
   * Returns the projection root hash encoded as lowercase hex.
   */
  public static async getRootHex(input: RecordsProjectionInput): Promise<string> {
    return hashToHex(await RecordsProjection.getRoot(input));
  }

  /**
   * Returns the subtree hash for a bit prefix within this projection.
   */
  public static async getSubtreeHash(input: RecordsProjectionTreeInput): Promise<Hash> {
    return RecordsProjection.withTree(input, tree => tree.getSubtreeHash(input.prefix));
  }

  /**
   * Returns the message CIDs under a bit prefix within this projection.
   */
  public static async getLeaves(input: RecordsProjectionTreeInput): Promise<string[]> {
    return RecordsProjection.withTree(input, tree => tree.getLeaves(input.prefix));
  }

  /**
   * Builds an in-memory projection tree from one primary-CID enumeration.
   */
  public static async createSnapshot(input: RecordsProjectionInput): Promise<RecordsProjectionSnapshot> {
    const tree = await RecordsProjection.createTree(input);
    return {
      close          : () => tree.close(),
      getLeaves      : (prefix: boolean[]) => tree.getLeaves(prefix),
      getRoot        : () => tree.getRoot(),
      getRootHex     : async () => hashToHex(await tree.getRoot()),
      getSubtreeHash : (prefix: boolean[]) => tree.getSubtreeHash(prefix),
    };
  }

  /**
   * Normalizes a scope union into sorted, duplicate-free, subsumption-reduced entries.
   */
  public static normalizeScopes(
    scopes: readonly [RecordsProjectionScope, ...RecordsProjectionScope[]],
  ): [NormalizedRecordsProjectionScope, ...NormalizedRecordsProjectionScope[]] {
    if (scopes.length === 0) {
      throw new Error('RecordsProjection: scopes must contain at least one scope.');
    }

    const normalized = scopes.map(scope => RecordsProjection.normalizeScope(scope));
    const deduped = new Map<string, NormalizedRecordsProjectionScope>();
    for (const scope of normalized) {
      deduped.set(RecordsProjection.scopeKey(scope), scope);
    }

    const uniqueScopes = [...deduped.values()];
    const protocolWide = new Set(
      uniqueScopes
        .filter(scope => RecordsProjection.isProtocolWideScope(scope))
        .map(scope => scope.protocol)
    );

    const reduced = uniqueScopes.filter(scope => {
      if (protocolWide.has(scope.protocol)) {
        return RecordsProjection.isProtocolWideScope(scope);
      }

      if (RecordsProjection.isContextScope(scope)) {
        return !uniqueScopes.some(candidate =>
          candidate !== scope &&
          RecordsProjection.isContextScope(candidate) &&
          candidate.protocol === scope.protocol &&
          RecordsProjection.contextIdSubsumes(candidate.contextId, scope.contextId)
        );
      }

      return true;
    });

    const result = reduced.sort(RecordsProjection.compareScopes);
    return result as [NormalizedRecordsProjectionScope, ...NormalizedRecordsProjectionScope[]];
  }

  private static async withTree<T>(
    input: RecordsProjectionInput,
    fn: (tree: SparseMerkleTree) => Promise<T>,
  ): Promise<T> {
    const tree = await RecordsProjection.createTree(input);

    try {
      return await fn(tree);
    } finally {
      await tree.close();
    }
  }

  private static async createTree(input: RecordsProjectionInput): Promise<SparseMerkleTree> {
    const tree = new SparseMerkleTree(new SMTStoreMemory());
    await tree.initialize();

    try {
      const messageCids = await RecordsProjection.getPrimaryMessageCids(input);
      for (const messageCid of messageCids) {
        await tree.insert(messageCid);
      }

      return tree;
    } catch (error) {
      await tree.close();
      throw error;
    }
  }

  private static normalizeScope(scope: RecordsProjectionScope): NormalizedRecordsProjectionScope {
    const protocol = RecordsProjection.requireNonEmptyString(scope.protocol, 'protocol');

    if (scope.protocolPath !== undefined && scope.contextId !== undefined) {
      throw new Error('RecordsProjection: protocolPath and contextId scopes are mutually exclusive.');
    }

    if (scope.protocolPath !== undefined) {
      return {
        protocol,
        protocolPath: RecordsProjection.requireNonEmptyString(scope.protocolPath, 'protocolPath'),
      };
    }

    if (scope.contextId !== undefined) {
      return {
        protocol,
        contextId: RecordsProjection.requireNonEmptyString(scope.contextId, 'contextId'),
      };
    }

    return { protocol };
  }

  private static constructFilters(scope: NormalizedRecordsProjectionScope): Filter[] {
    const baseFilter: Filter = {
      interface         : DwnInterfaceName.Records,
      isLatestBaseState : true,
      protocol          : scope.protocol,
    };

    if ('protocolPath' in scope) {
      return [{ ...baseFilter, protocolPath: scope.protocolPath }];
    }

    if ('contextId' in scope) {
      const childContextPrefix = `${scope.contextId}/`;
      return [
        { ...baseFilter, contextId: scope.contextId },
        {
          ...baseFilter,
          contextId: FilterUtility.constructPrefixFilterAsRangeFilter(childContextPrefix),
        },
      ];
    }

    return [baseFilter];
  }

  private static requireNonEmptyString(value: string, field: string): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`RecordsProjection: ${field} must be a non-empty string.`);
    }

    return value;
  }

  private static scopeKey(scope: NormalizedRecordsProjectionScope): string {
    if ('protocolPath' in scope) {
      return `${scope.protocol}\u001fprotocolPath\u001f${scope.protocolPath}`;
    }

    if ('contextId' in scope) {
      return `${scope.protocol}\u001fcontextId\u001f${scope.contextId}`;
    }

    return `${scope.protocol}\u001fprotocol`;
  }

  private static isProtocolWideScope(
    scope: NormalizedRecordsProjectionScope,
  ): scope is { protocol: string } {
    return !('protocolPath' in scope) && !('contextId' in scope);
  }

  private static isContextScope(
    scope: NormalizedRecordsProjectionScope,
  ): scope is { protocol: string; contextId: string } {
    return 'contextId' in scope;
  }

  private static contextIdSubsumes(parentContextId: string, childContextId: string): boolean {
    return childContextId === parentContextId ||
      childContextId.startsWith(`${parentContextId}/`);
  }

  private static compareScopes(
    a: NormalizedRecordsProjectionScope,
    b: NormalizedRecordsProjectionScope,
  ): number {
    const protocolCompare = lexicographicalCompare(a.protocol, b.protocol);
    if (protocolCompare !== 0) {
      return protocolCompare;
    }

    const aRank = RecordsProjection.scopeRank(a);
    const bRank = RecordsProjection.scopeRank(b);
    if (aRank !== bRank) {
      return aRank - bRank;
    }

    return lexicographicalCompare(RecordsProjection.scopeValue(a), RecordsProjection.scopeValue(b));
  }

  private static scopeRank(scope: NormalizedRecordsProjectionScope): number {
    if ('protocolPath' in scope) { return 1; }
    if ('contextId' in scope) { return 2; }
    return 0;
  }

  private static scopeValue(scope: NormalizedRecordsProjectionScope): string {
    if ('protocolPath' in scope) { return scope.protocolPath; }
    if ('contextId' in scope) { return scope.contextId; }
    return '';
  }
}
