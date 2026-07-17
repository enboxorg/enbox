import type { GenericMessage, MessagesQueryReply, ProgressToken, ProtocolDefinition } from '@enbox/dwn-sdk-js';

import type { NonEmptyStringArray, SyncIdentityOptions } from './types/sync.js';

import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

import { getProtocolClosureEdges } from './sync-scope-closure.js';
import { lexicographicalCompare, syncScopeFromProtocols } from './types/sync.js';

/** Grant lookup required to inspect one delegated closure protocol. */
export type SyncScopeClosureGrantQuery = {
  delegateDid: string;
  did: string;
  protocol: string;
};

/** Result of resolving delegated Messages.Read authorization for one protocol. */
export type SyncScopeClosureGrantResolution =
  | { kind: 'granted'; permissionGrantIds?: NonEmptyStringArray }
  | { kind: 'missing' };

/** Backend-neutral query for one retained protocol-history page. */
export type SyncScopeProtocolHistoryQuery = {
  cursor?: ProgressToken;
  delegateDid?: string;
  did: string;
  limit: number;
  permissionGrantIds?: NonEmptyStringArray;
  protocol: string;
};

/** Protocol-history reply fields consumed by closure validation. */
export type SyncScopeProtocolHistoryPage = Pick<MessagesQueryReply, 'cursor' | 'drained' | 'entries' | 'status'>;

/** Engine-owned effects required by backend-neutral scope-closure policy. */
export interface SyncScopeClosureValidatorOperations {
  queryProtocolHistory(query: SyncScopeProtocolHistoryQuery): Promise<SyncScopeProtocolHistoryPage>;

  resolvePermissionGrantIds(query: SyncScopeClosureGrantQuery): Promise<SyncScopeClosureGrantResolution>;
}

export type SyncScopeClosureValidatorParams = {
  operations: SyncScopeClosureValidatorOperations;
};

type SyncScopeClosureValidationState = {
  requestedProtocols: Set<string>;
  protocolsToScan: string[];
  scannedProtocols: Set<string>;
  missingGrantProtocols: Set<string>;
  nonScopedUsesProtocols: Set<string>;
  splitDependencyEdges: Map<string, Set<string>>;
};

/**
 * Validates sync registration scopes against retained protocol history.
 *
 * Grant resolution and history access are injected so the traversal and
 * closure policy can be reused independently of an engine's persistence and
 * transport implementation.
 */
export class SyncScopeClosureValidator {
  /** Page size for local retained ProtocolsConfigure history scans. */
  private static readonly PROTOCOL_HISTORY_PAGE_LIMIT = 500;

  private readonly _operations: SyncScopeClosureValidatorOperations;

  constructor({ operations }: SyncScopeClosureValidatorParams) {
    this._operations = operations;
  }

  /** Validate the shape and non-empty scope contract of identity options. */
  public validateOptions(options: SyncIdentityOptions): void {
    if (!options || !('protocols' in options)) {
      throw new Error('SyncEngineLevel: options.protocols is required — pass \'all\' for a full replica or a non-empty protocol list.');
    }
    if (options.protocols !== 'all' && !Array.isArray(options.protocols)) {
      throw new Error('SyncEngineLevel: protocols must be \'all\' or a non-empty string array.');
    }
    if (Array.isArray(options.protocols) && options.protocols.length === 0) {
      throw new Error('SyncEngineLevel: protocols must be \'all\' or a non-empty array of protocol URIs. An empty array is ambiguous.');
    }
  }

  /** Validate that a protocol-set scope contains its complete dependency closure. */
  public async validateClosure(did: string, options: SyncIdentityOptions): Promise<void> {
    const scope = syncScopeFromProtocols(options.protocols);
    if (scope.kind === 'full') {
      return;
    }

    const state = SyncScopeClosureValidator.createValidationState(scope.protocols);
    await this.scanClosure(did, options, state);

    const details = SyncScopeClosureValidator.errorDetails(options, state);
    if (details.length > 0) {
      throw new Error(`SyncEngineLevel: sync scope closure validation failed for ${did}: ${details.join('; ')}`);
    }
  }

  private static createValidationState(protocols: NonEmptyStringArray): SyncScopeClosureValidationState {
    return {
      requestedProtocols     : new Set(protocols),
      protocolsToScan        : [...protocols],
      scannedProtocols       : new Set(),
      missingGrantProtocols  : new Set(),
      nonScopedUsesProtocols : new Set(),
      splitDependencyEdges   : new Map(),
    };
  }

  private async scanClosure(
    did: string,
    options: SyncIdentityOptions,
    state: SyncScopeClosureValidationState,
  ): Promise<void> {
    while (state.protocolsToScan.length > 0) {
      const protocol = state.protocolsToScan.shift();
      if (protocol === undefined || state.scannedProtocols.has(protocol)) {
        continue;
      }

      await this.scanProtocol(did, options, protocol, state);
    }
  }

  private async scanProtocol(
    did: string,
    options: SyncIdentityOptions,
    protocol: string,
    state: SyncScopeClosureValidationState,
  ): Promise<void> {
    state.scannedProtocols.add(protocol);

    let permissionGrantIds: NonEmptyStringArray | undefined;
    if (options.delegateDid !== undefined) {
      const resolution = await this._operations.resolvePermissionGrantIds({
        delegateDid: options.delegateDid,
        did,
        protocol,
      });
      if (resolution.kind === 'missing') {
        state.missingGrantProtocols.add(protocol);
        return;
      }
      permissionGrantIds = resolution.permissionGrantIds;
    }

    const definitions = await this.fetchProtocolHistory(did, protocol, options.delegateDid, permissionGrantIds);
    for (const definition of definitions) {
      SyncScopeClosureValidator.recordClosureEdges(state, definition);
    }
  }

  private static recordClosureEdges(
    state: SyncScopeClosureValidationState,
    definition: ProtocolDefinition,
  ): void {
    const edges = getProtocolClosureEdges(definition);
    SyncScopeClosureValidator.recordUsesProtocols(state, edges.usesProtocols);
    SyncScopeClosureValidator.recordDependencyProtocols(state, definition.protocol, edges.dependencyProtocols);
  }

  private static recordUsesProtocols(
    state: SyncScopeClosureValidationState,
    protocols: string[],
  ): void {
    for (const protocol of protocols) {
      if (!state.requestedProtocols.has(protocol)) {
        state.nonScopedUsesProtocols.add(protocol);
      }
      SyncScopeClosureValidator.enqueueProtocol(state, protocol);
    }
  }

  private static recordDependencyProtocols(
    state: SyncScopeClosureValidationState,
    sourceProtocol: string,
    protocols: string[],
  ): void {
    for (const protocol of protocols) {
      if (!state.requestedProtocols.has(protocol)) {
        SyncScopeClosureValidator.addProtocolEdge(state.splitDependencyEdges, sourceProtocol, protocol);
      }
      SyncScopeClosureValidator.enqueueProtocol(state, protocol);
    }
  }

  private static enqueueProtocol(state: SyncScopeClosureValidationState, protocol: string): void {
    if (!state.scannedProtocols.has(protocol)) {
      state.protocolsToScan.push(protocol);
    }
  }

  private static errorDetails(
    options: SyncIdentityOptions,
    state: SyncScopeClosureValidationState,
  ): string[] {
    if (state.missingGrantProtocols.size === 0 && state.splitDependencyEdges.size === 0) {
      return [];
    }

    const details: string[] = [];
    if (state.missingGrantProtocols.size > 0) {
      details.push(
        `delegate ${options.delegateDid} lacks Messages.Read grants for closure protocols: ` +
        SyncScopeClosureValidator.formatStringSet(state.missingGrantProtocols)
      );
    }
    if (state.splitDependencyEdges.size > 0) {
      details.push(
        `scope splits cross-protocol dependencies: ${SyncScopeClosureValidator.formatProtocolEdges(state.splitDependencyEdges)}`
      );
    }
    if (state.nonScopedUsesProtocols.size > 0) {
      details.push(
        `uses protocols outside the sync scope: ${SyncScopeClosureValidator.formatStringSet(state.nonScopedUsesProtocols)}`
      );
    }

    return details;
  }

  private async fetchProtocolHistory(
    did: string,
    protocol: string,
    delegateDid: string | undefined,
    permissionGrantIds: NonEmptyStringArray | undefined,
  ): Promise<ProtocolDefinition[]> {
    const definitions: ProtocolDefinition[] = [];
    let cursor: ProgressToken | undefined;

    for (;;) {
      const page = await this._operations.queryProtocolHistory({
        cursor,
        delegateDid,
        did,
        limit: SyncScopeClosureValidator.PROTOCOL_HISTORY_PAGE_LIMIT,
        permissionGrantIds,
        protocol,
      });

      if (page.status.code !== 200) {
        throw new Error(
          `SyncEngineLevel: local protocol history query failed for ${did} / ${protocol}: ` +
          `${page.status.code} ${page.status.detail}`
        );
      }

      for (const entry of page.entries ?? []) {
        const definition = SyncScopeClosureValidator.protocolDefinitionFromMessage(entry.message);
        if (definition !== undefined) {
          definitions.push(definition);
        }
      }

      if (page.drained === true) {
        return definitions;
      }
      if (page.cursor === undefined) {
        throw new Error(`SyncEngineLevel: local protocol history query returned no cursor before drain for ${did} / ${protocol}`);
      }

      cursor = page.cursor;
    }
  }

  private static protocolDefinitionFromMessage(message: GenericMessage | undefined): ProtocolDefinition | undefined {
    const descriptor = message?.descriptor as { interface?: string; method?: string; definition?: unknown } | undefined;
    if (
      descriptor?.interface !== DwnInterfaceName.Protocols ||
      descriptor.method !== DwnMethodName.Configure ||
      !SyncScopeClosureValidator.isProtocolDefinition(descriptor.definition)
    ) {
      return undefined;
    }

    return descriptor.definition;
  }

  private static isProtocolDefinition(value: unknown): value is ProtocolDefinition {
    return typeof value === 'object' &&
      value !== null &&
      typeof (value as { protocol?: unknown }).protocol === 'string';
  }

  private static addProtocolEdge(edges: Map<string, Set<string>>, from: string, to: string): void {
    let targets = edges.get(from);
    if (targets === undefined) {
      targets = new Set();
      edges.set(from, targets);
    }
    targets.add(to);
  }

  private static formatStringSet(values: Set<string>): string {
    return [...values].sort(lexicographicalCompare).join(', ');
  }

  private static formatProtocolEdges(edges: Map<string, Set<string>>): string {
    return [...edges.entries()]
      .sort(([a], [b]) => lexicographicalCompare(a, b))
      .flatMap(([from, targets]) => [...targets]
        .sort(lexicographicalCompare)
        .map(to => `${from} -> ${to}`))
      .join(', ');
  }
}
