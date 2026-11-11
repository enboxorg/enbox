import { lexicographicalCompare } from './types/sync.js';

/** Maximum concurrent followed-source operations per pass. */
export const FOLLOWED_SOURCE_CONCURRENCY = 4;

/** Verified role-authorized content within one explicitly selected module. */
export type FollowedModuleScope = {
  /** Context root path in the root module, or top-level `$ref` attachment path in a composing module. */
  contextPath: string;
  moduleRole: string;
  modulePaths: [string, ...string[]];
};

/** One accepted foreign root and its explicitly selected module scopes. */
export type FollowedSyncSource = {
  acceptanceId: string;
  /** The accepted role record ID; replacement retires the whole group. */
  id: string;
  sourceDid: string;
  remoteEndpoint: string;
  actorDid: string;
  rootModule: string;
  contextId: string;
  /** Root-role candidates in preference order. */
  roles: [string, ...string[]];
  /** The root is always verified. Null means selected but unavailable; absent means unselected. */
  modules: Record<string, FollowedModuleScope | null>;
};

/** Context root details and optional attached module selections supplied before authority is verified. */
export type FollowedSyncSourceInput = Pick<FollowedSyncSource, 'actorDid' | 'contextId' | 'rootModule' | 'sourceDid' | 'roles'> & {
  contextPath: string;
  /** Desired attached module URIs; root verification always inserts `rootModule` separately. */
  modules: readonly string[];
};

export type FollowedSyncSourceStoreEntry = {
  status: 'valid';
  source: FollowedSyncSource;
} | {
  status: 'corrupt';
  id: string;
  error: unknown;
};

export interface FollowedSyncSourceStore {
  delete(id: string): Promise<void>;
  get(id: string): Promise<FollowedSyncSource | undefined>;
  list(): Promise<FollowedSyncSourceStoreEntry[]>;
  /** Atomically save an acceptance and remove any former source rows. */
  replace(source: FollowedSyncSource, replacedIds?: readonly string[]): Promise<void>;
}

export function normalizeFollowedSyncSourceInput(source: FollowedSyncSourceInput): FollowedSyncSourceInput {
  const authority = normalizeAuthority(source);
  assertPath(source.contextPath, 'contextPath');
  return { ...authority, contextPath: source.contextPath, modules: normalizeFollowedModules(source.modules) };
}

/** Require the new source shape; older rows are rejected instead of synthesized. */
export function normalizeFollowedSyncSource(source: FollowedSyncSource): FollowedSyncSource {
  const authority = normalizeAuthority(source);
  assertString(source.acceptanceId, 'acceptanceId');
  assertString(source.id, 'id');
  assertString(source.remoteEndpoint, 'remoteEndpoint');
  if (source.modules === null || typeof source.modules !== 'object' || Array.isArray(source.modules)) {
    throw new TypeError('FollowedSyncSource: modules must be a required URI-to-scope map.');
  }
  const modules: FollowedSyncSource['modules'] = Object.create(null);
  for (const module of Object.keys(source.modules).sort(lexicographicalCompare)) {
    assertString(module, 'module URI');
    const scope = source.modules[module];
    modules[module] = scope === null ? null : normalizeScope(scope, module === authority.rootModule);
  }
  const root = modules[authority.rootModule];
  if (root === undefined || root === null || !authority.roles.includes(root.moduleRole)) {
    throw new TypeError('FollowedSyncSource: rootModule must have a verified scope using a requested root role.');
  }
  return { ...authority, acceptanceId: source.acceptanceId, id: source.id, remoteEndpoint: source.remoteEndpoint, modules };
}

/** Optional modules never participate in the root acceptance's authority equality. */
export function followedSyncSourceAuthorityEqual(a: FollowedSyncSource, b: FollowedSyncSource): boolean {
  return a.id === b.id && a.sourceDid === b.sourceDid && a.remoteEndpoint === b.remoteEndpoint &&
    a.actorDid === b.actorDid && a.rootModule === b.rootModule && a.contextId === b.contextId &&
    sameStrings(a.roles, b.roles) && followedModuleScopeEqual(a.modules[a.rootModule]!, b.modules[b.rootModule]!);
}

export function followedSyncSourceActiveEqual(a: FollowedSyncSource, b: FollowedSyncSource): boolean {
  return a.acceptanceId === b.acceptanceId && followedSyncSourceAuthorityEqual(a, b);
}

export function followedModuleScopeEqual(a: FollowedModuleScope, b: FollowedModuleScope): boolean {
  return a.contextPath === b.contextPath && a.moduleRole === b.moduleRole && sameStrings(a.modulePaths, b.modulePaths);
}

export function followedModuleSelectionEqual(
  left: FollowedModuleScope | null | undefined,
  right: FollowedModuleScope | null | undefined,
): boolean {
  if (left === undefined || left === null) {
    return left === right;
  }
  return right !== undefined && right !== null && followedModuleScopeEqual(left, right);
}

/** Durable state equality includes unavailable selections while root equality does not. */
export function followedSyncSourceStateEqual(a: FollowedSyncSource, b: FollowedSyncSource): boolean {
  const modules = Object.keys(a.modules);
  return followedSyncSourceActiveEqual(a, b) &&
    modules.length === Object.keys(b.modules).length &&
    modules.every(module => followedModuleSelectionEqual(a.modules[module], b.modules[module]));
}

export function normalizeFollowedModules(modules: readonly string[]): string[] {
  if (!Array.isArray(modules)) {
    throw new TypeError('FollowedSyncSource: modules must be an explicit array of module URIs.');
  }
  for (const module of modules) {assertString(module, 'module URI');}
  return [...new Set(modules)].sort(lexicographicalCompare);
}

function normalizeAuthority(source: Pick<FollowedSyncSource, 'actorDid' | 'contextId' | 'rootModule' | 'roles' | 'sourceDid'>):
Pick<FollowedSyncSource, 'actorDid' | 'contextId' | 'rootModule' | 'roles' | 'sourceDid'> {
  assertString(source.actorDid, 'actorDid');
  assertString(source.contextId, 'contextId');
  assertString(source.rootModule, 'rootModule');
  assertString(source.sourceDid, 'sourceDid');
  if (!Array.isArray(source.roles) || source.roles.length === 0) {
    throw new TypeError('FollowedSyncSource: roles must contain at least one candidate.');
  }
  for (const role of source.roles) {assertString(role, 'role');}
  if (new Set(source.roles).size !== source.roles.length) {
    throw new TypeError('FollowedSyncSource: roles must not contain duplicates.');
  }
  return {
    actorDid   : source.actorDid, contextId  : source.contextId, rootModule : source.rootModule,
    sourceDid  : source.sourceDid, roles      : [...source.roles] as [string, ...string[]],
  };
}

function normalizeScope(scope: FollowedModuleScope, isRoot: boolean): FollowedModuleScope {
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new TypeError('FollowedSyncSource: a selected module requires a verified scope or null.');
  }
  assertPath(scope.contextPath, 'contextPath');
  assertString(scope.moduleRole, 'moduleRole');
  if (!Array.isArray(scope.modulePaths) || scope.modulePaths.length === 0) {
    throw new TypeError('FollowedSyncSource: a verified scope requires at least one readable path.');
  }
  for (const path of scope.modulePaths) {
    assertPath(path, 'modulePath');
    if ((!isRoot || path !== scope.contextPath) && !path.startsWith(`${scope.contextPath}/`)) {
      throw new TypeError('FollowedSyncSource: readable paths must belong to their selected context.');
    }
  }
  const modulePaths = [...new Set(scope.modulePaths)].sort(lexicographicalCompare) as [string, ...string[]];
  if (isRoot && !modulePaths.includes(scope.contextPath)) {
    throw new TypeError('FollowedSyncSource: the root scope must authorize reading the context root.');
  }
  return { contextPath: scope.contextPath, moduleRole: scope.moduleRole, modulePaths };
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`FollowedSyncSource: ${field} must be a non-empty string.`);
  }
}

function assertPath(value: unknown, field: string): asserts value is string {
  assertString(value, field);
  if (value.split('/').some(segment => segment === '' || segment.startsWith('$'))) {
    throw new TypeError(`FollowedSyncSource: ${field} must be a canonical module path.`);
  }
}

export function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
