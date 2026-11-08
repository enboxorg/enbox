import type {
  ResolvedModuleAddress,
  ResolvedModuleGraph,
  ResolvedModuleNode,
  ResolvedRoleReference,
} from '../core/module-graph.js';

import { lexicographicalCompare } from './string.js';
import { ModuleAction } from '../types/modules-types.js';

/** Concrete content authorized by one contextual role in the selected module. */
export type ResolvedModuleRoleScope = {
  /** Local concrete root or virtual attachment; a virtual root is never a record. */
  contextPath: string;
  /** A local spelling of the canonical role, suitable for invocation in this module. */
  moduleRole: string;
  allowedPaths: ReadonlySet<string>;
  readablePaths: [string, ...string[]];
};

/** Canonical coordinates of a physical context root. */
export type ModuleContextRoot = Pick<ResolvedModuleNode,
  'owningModuleUri' | 'owningModulePath' | 'physicalAncestors' | 'physicalDepth'>;

/** Resolve the concrete root or virtual attachment at exactly these physical coordinates. */
export function resolveModuleContextRoot(graph: ResolvedModuleGraph, root: ModuleContextRoot): ResolvedModuleNode {
  const roots = [...graph.nodesByDeclaredPath.values()].filter(node =>
    node.ruleSet.$role !== true && sameAddress(node, root) && node.physicalDepth === root.physicalDepth &&
    sameAncestors(node.physicalAncestors, root.physicalAncestors));
  if (roots.length !== 1) {
    throw new TypeError(`Module '${graph.rootModuleUri}' must declare one exact shared root.`);
  }
  return roots[0];
}

/** Select direct local context roles in authored read-action order, without establishing membership. */
export function resolveModuleContextRoles(graph: ResolvedModuleGraph, contextPath: string): readonly string[] {
  const context = graph.nodesByDeclaredPath.get(contextPath);
  if (context === undefined || context.ruleSet.$role === true) {
    throw new TypeError(`Context path '${contextPath}' must identify a non-role record.`);
  }
  if (context.kind === 'ref') {
    return [];
  }
  return context.actions.filter(action => {
    const role = action.resolvedRole;
    const localRole = action.rule.role === undefined ? undefined : graph.nodesByDeclaredPath.get(action.rule.role);
    return role !== undefined && localRole?.kind === 'record' && role.owningModuleUri === graph.rootModuleUri &&
      action.rule.can.includes(ModuleAction.Read) && role.parentAncestor !== undefined &&
      sameAddress(role.parentAncestor, context) &&
      sameAncestors(role.physicalAncestors, [...context.physicalAncestors, context]);
  }).map(action => action.rule.role!);
}

/**
 * Derive native or attached content from the same resolved graph. Native roots
 * require their own read rule; virtual roots contribute no record or inherited
 * authority. Membership, owner signatures, and delegated grants are verified by
 * callers independently of this policy calculation.
 */
export function resolveModuleRoleScope(graph: ResolvedModuleGraph, role: ResolvedRoleReference): ResolvedModuleRoleScope {
  const parent = role.parentAncestor;
  if (parent === undefined || role.ruleSet.$role !== true ||
      role.parentPhysicalDepth !== role.physicalAncestors.length ||
      role.physicalDepth !== role.parentPhysicalDepth + 1 ||
      !sameAddress(role.physicalAncestors.at(-1), parent)) {
    throw new TypeError('A context scope requires a contextual role and its physical parent.');
  }
  const root = resolveModuleContextRoot(graph, {
    ...parent,
    physicalDepth     : role.parentPhysicalDepth,
    physicalAncestors : role.physicalAncestors.slice(0, -1),
  });
  const contextPath = root.declaringModulePath;
  const allowedPaths: string[] = [];
  const readablePaths: string[] = [];
  const invokedRoles = new Set<string>();
  for (const [path, node] of graph.nodesByDeclaredPath) {
    if (!isContextContent(graph.rootModuleUri, contextPath, path, node)) {
      continue;
    }
    const actions = node.actions.filter(action => action.resolvedRole !== undefined &&
      sameAddress(action.resolvedRole, role) && sameAncestors(action.resolvedRole.physicalAncestors, role.physicalAncestors));
    if (actions.length === 0) {
      continue;
    }
    allowedPaths.push(path);
    for (const action of actions) {
      invokedRoles.add(action.rule.role!);
    }
    if (actions.some(action => action.rule.can.includes(ModuleAction.Read))) {
      readablePaths.push(path);
    }
  }
  if (root.kind === 'record' && !readablePaths.includes(contextPath)) {
    throw new TypeError(`Context role '${role.rawRole}' must authorize reading its parent context '${contextPath}'.`);
  }
  if (readablePaths.length === 0) {
    throw new TypeError(`Module '${graph.rootModuleUri}' has no records readable through the selected context role.`);
  }
  allowedPaths.sort(lexicographicalCompare);
  readablePaths.sort(lexicographicalCompare);
  return {
    contextPath,
    moduleRole    : [...invokedRoles].sort(lexicographicalCompare)[0],
    allowedPaths  : new Set(allowedPaths),
    readablePaths : readablePaths as [string, ...string[]],
  };
}

function isContextContent(moduleUri: string, contextPath: string, path: string, node: ResolvedModuleNode): boolean {
  return node.kind === 'record' && node.owningModuleUri === moduleUri &&
    node.declaringModuleUri === moduleUri && node.ruleSet.$role !== true &&
    (path === contextPath || path.startsWith(`${contextPath}/`));
}

function sameAddress(left: ResolvedModuleAddress | undefined, right: ResolvedModuleAddress): boolean {
  return left?.owningModuleUri === right.owningModuleUri && left.owningModulePath === right.owningModulePath;
}

function sameAncestors(left: readonly ResolvedModuleAddress[], right: readonly ResolvedModuleAddress[]): boolean {
  return left.length === right.length && left.every((ancestor, index) => sameAddress(ancestor, right[index]));
}
