import type { GenericMessage, MessagesQueryReply, ModuleDefinition, ProgressToken } from '@enbox/dwn-sdk-js';

import type { NonEmptyStringArray, SyncIdentityOptions } from './types/sync.js';

import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

import { getModuleClosureEdges } from './sync-scope-closure.js';
import { lexicographicalCompare, normalizeSyncModules, syncScopeFromModules } from './types/sync.js';

/** Grant lookup required to inspect one delegated closure module. */
export type SyncScopeClosureGrantQuery = {
  delegateDid: string;
  did: string;
  module: string;
};

/** Result of resolving delegated Messages.Read authorization for one module. */
export type SyncScopeClosureGrantResolution =
  | { kind: 'granted'; permissionGrantIds?: NonEmptyStringArray }
  | { kind: 'missing' };

/** Backend-neutral query for one retained module-history page. */
export type SyncScopeModuleHistoryQuery = {
  cursor?: ProgressToken;
  delegateDid?: string;
  did: string;
  limit: number;
  permissionGrantIds?: NonEmptyStringArray;
  module: string;
};

/** Module-history reply fields consumed by closure validation. */
export type SyncScopeModuleHistoryPage = Pick<MessagesQueryReply, 'cursor' | 'drained' | 'entries' | 'status'>;

/** Engine-owned effects required by backend-neutral scope-closure policy. */
export interface SyncScopeClosureValidatorOperations {
  queryModuleHistory(query: SyncScopeModuleHistoryQuery): Promise<SyncScopeModuleHistoryPage>;

  resolvePermissionGrantIds(query: SyncScopeClosureGrantQuery): Promise<SyncScopeClosureGrantResolution>;
}

export type SyncScopeClosureValidatorParams = {
  operations: SyncScopeClosureValidatorOperations;
};

type SyncScopeClosureValidationState = {
  requestedModules: Set<string>;
  modulesToScan: string[];
  scannedModules: Set<string>;
  missingGrantModules: Set<string>;
  nonScopedUsesModules: Set<string>;
  splitDependencyEdges: Map<string, Set<string>>;
};

/**
 * Validates sync registration scopes against retained module history.
 *
 * Grant resolution and history access are injected so the traversal and
 * closure policy can be reused independently of an engine's persistence and
 * transport implementation.
 */
export class SyncScopeClosureValidator {
  /** Page size for local retained ModulesConfigure history scans. */
  private static readonly MODULE_HISTORY_PAGE_LIMIT = 500;

  private readonly _operations: SyncScopeClosureValidatorOperations;

  constructor({ operations }: SyncScopeClosureValidatorParams) {
    this._operations = operations;
  }

  /** Validate the shape and non-empty scope contract of identity options. */
  public validateOptions(options: SyncIdentityOptions): void {
    if (!options || !('modules' in options)) {
      throw new Error('SyncScopeClosureValidator: options.modules is required — pass \'all\' for a full replica or a non-empty module list.');
    }
    if (Object.keys(options).some(key => key !== 'modules' && key !== 'delegateDid')) {
      throw new Error('SyncScopeClosureValidator: unrecognized sync identity option; use module-format options.');
    }
    if (options.modules !== 'all' && !Array.isArray(options.modules)) {
      throw new Error('SyncScopeClosureValidator: modules must be \'all\' or a non-empty string array.');
    }
    if (Array.isArray(options.modules) && options.modules.length === 0) {
      throw new Error('SyncScopeClosureValidator: modules must be \'all\' or a non-empty array of module URIs. An empty array is ambiguous.');
    }
  }

  /** Validate that a module-set scope contains its complete dependency closure. */
  public async validateClosure(did: string, options: SyncIdentityOptions): Promise<void> {
    const scope = syncScopeFromModules(options.modules);
    if (scope.kind === 'full') {
      return;
    }

    const state = SyncScopeClosureValidator.createValidationState(scope.modules);
    await this.scanClosure(did, options, state);

    const details = SyncScopeClosureValidator.errorDetails(options, state);
    if (details.length > 0) {
      throw new Error(`SyncScopeClosureValidator: sync scope closure validation failed for ${did}: ${details.join('; ')}`);
    }
  }

  /** Resolve an owner's roots through all retained definition history without changing registration or grants. */
  public async resolveOwnerModuleScope(did: string, roots: NonEmptyStringArray): Promise<NonEmptyStringArray> {
    const modules = normalizeSyncModules(roots);
    const state = SyncScopeClosureValidator.createValidationState(modules);
    await this.scanClosure(did, { modules }, state);
    return normalizeSyncModules([...state.scannedModules]);
  }

  private static createValidationState(modules: NonEmptyStringArray): SyncScopeClosureValidationState {
    return {
      requestedModules     : new Set(modules),
      modulesToScan        : [...modules],
      scannedModules       : new Set(),
      missingGrantModules  : new Set(),
      nonScopedUsesModules : new Set(),
      splitDependencyEdges : new Map(),
    };
  }

  private async scanClosure(
    did: string,
    options: SyncIdentityOptions,
    state: SyncScopeClosureValidationState,
  ): Promise<void> {
    while (state.modulesToScan.length > 0) {
      const moduleUri = state.modulesToScan.shift();
      if (moduleUri === undefined || state.scannedModules.has(moduleUri)) {
        continue;
      }

      // Each scan discovers more dependencies; finish its retained history before advancing the queue.
      await this.scanModule(did, options, moduleUri, state); // NOSONAR: S9382 — dependent traversal, one history buffer at a time.
    }
  }

  private async scanModule(
    did: string,
    options: SyncIdentityOptions,
    module: string,
    state: SyncScopeClosureValidationState,
  ): Promise<void> {
    state.scannedModules.add(module);

    let permissionGrantIds: NonEmptyStringArray | undefined;
    if (options.delegateDid !== undefined) {
      const resolution = await this._operations.resolvePermissionGrantIds({
        delegateDid: options.delegateDid,
        did,
        module,
      });
      if (resolution.kind === 'missing') {
        state.missingGrantModules.add(module);
        return;
      }
      permissionGrantIds = resolution.permissionGrantIds;
    }

    const definitions = await this.fetchModuleHistory(did, module, options.delegateDid, permissionGrantIds);
    for (const definition of definitions) {
      SyncScopeClosureValidator.recordClosureEdges(state, definition);
    }
  }

  private static recordClosureEdges(
    state: SyncScopeClosureValidationState,
    definition: ModuleDefinition,
  ): void {
    const edges = getModuleClosureEdges(definition);
    SyncScopeClosureValidator.recordUsesModules(state, edges.usesModules);
    SyncScopeClosureValidator.recordDependencyModules(state, definition.module, edges.dependencyModules);
  }

  private static recordUsesModules(
    state: SyncScopeClosureValidationState,
    modules: string[],
  ): void {
    for (const module of modules) {
      if (!state.requestedModules.has(module)) {
        state.nonScopedUsesModules.add(module);
      }
      SyncScopeClosureValidator.enqueueModule(state, module);
    }
  }

  private static recordDependencyModules(
    state: SyncScopeClosureValidationState,
    sourceModule: string,
    modules: string[],
  ): void {
    for (const module of modules) {
      if (!state.requestedModules.has(module)) {
        SyncScopeClosureValidator.addModuleEdge(state.splitDependencyEdges, sourceModule, module);
      }
      SyncScopeClosureValidator.enqueueModule(state, module);
    }
  }

  private static enqueueModule(state: SyncScopeClosureValidationState, module: string): void {
    if (!state.scannedModules.has(module)) {
      state.modulesToScan.push(module);
    }
  }

  private static errorDetails(
    options: SyncIdentityOptions,
    state: SyncScopeClosureValidationState,
  ): string[] {
    if (state.missingGrantModules.size === 0 && state.splitDependencyEdges.size === 0) {
      return [];
    }

    const details: string[] = [];
    if (state.missingGrantModules.size > 0) {
      details.push(
        `delegate ${options.delegateDid} lacks Messages.Read grants for closure modules: ` +
        SyncScopeClosureValidator.formatStringSet(state.missingGrantModules)
      );
    }
    if (state.splitDependencyEdges.size > 0) {
      details.push(
        `scope splits cross-module dependencies: ${SyncScopeClosureValidator.formatModuleEdges(state.splitDependencyEdges)}`
      );
    }
    if (state.nonScopedUsesModules.size > 0) {
      details.push(
        `uses modules outside the sync scope: ${SyncScopeClosureValidator.formatStringSet(state.nonScopedUsesModules)}`
      );
    }

    return details;
  }

  private async fetchModuleHistory(
    did: string,
    module: string,
    delegateDid: string | undefined,
    permissionGrantIds: NonEmptyStringArray | undefined,
  ): Promise<ModuleDefinition[]> {
    const definitions: ModuleDefinition[] = [];
    let cursor: ProgressToken | undefined;

    for (;;) {
      const page = await this._operations.queryModuleHistory({
        cursor,
        delegateDid,
        did,
        limit: SyncScopeClosureValidator.MODULE_HISTORY_PAGE_LIMIT,
        permissionGrantIds,
        module,
      });

      if (page.status.code !== 200) {
        throw new Error(
          `SyncScopeClosureValidator: local module history query failed for ${did} / ${module}: ` +
          `${page.status.code} ${page.status.detail}`
        );
      }

      for (const entry of page.entries ?? []) {
        const definition = SyncScopeClosureValidator.moduleDefinitionFromMessage(entry.message);
        if (definition !== undefined) {
          definitions.push(definition);
        }
      }

      if (page.drained === true) {
        return definitions;
      }
      if (page.cursor === undefined) {
        throw new Error(`SyncScopeClosureValidator: local module history query returned no cursor before drain for ${did} / ${module}`);
      }

      cursor = page.cursor;
    }
  }

  private static moduleDefinitionFromMessage(message: GenericMessage | undefined): ModuleDefinition | undefined {
    const descriptor = message?.descriptor as { interface?: string; method?: string; definition?: unknown } | undefined;
    if (
      descriptor?.interface !== DwnInterfaceName.Modules ||
      descriptor.method !== DwnMethodName.Configure ||
      !SyncScopeClosureValidator.isModuleDefinition(descriptor.definition)
    ) {
      return undefined;
    }

    return descriptor.definition;
  }

  private static isModuleDefinition(value: unknown): value is ModuleDefinition {
    return typeof value === 'object' &&
      value !== null &&
      typeof (value as { module?: unknown }).module === 'string';
  }

  private static addModuleEdge(edges: Map<string, Set<string>>, from: string, to: string): void {
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

  private static formatModuleEdges(edges: Map<string, Set<string>>): string {
    return [...edges.entries()]
      .sort(([a], [b]) => lexicographicalCompare(a, b))
      .flatMap(([from, targets]) => [...targets]
        .sort(lexicographicalCompare)
        .map(to => `${from} -> ${to}`))
      .join(', ');
  }
}
