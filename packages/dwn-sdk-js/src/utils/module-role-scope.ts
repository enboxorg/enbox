import type {
  ResolvedModuleAddress,
  ResolvedModuleGraph,
  ResolvedModuleNode,
  ResolvedRoleReference,
} from '../core/module-graph.js';

import { lexicographicalCompare } from './string.js';
import { ModuleAction } from '../types/modules-types.js';

/** Record paths under a context root that a role is authorized to access in this module. */
export type ResolvedModuleRoleScope = {
  /** Path of the context root node in this module (either the root record itself or a top-level `$ref` attachment). */
  contextPath: string;
  /** Role path as referenced in this module's `$actions` rules (e.g. `'notebook/editor'` or `'notes:notebook/editor'`). */
  moduleRole: string;
  /** All non-role record paths under `contextPath` that this role can access (read or write). */
  allowedPaths: ReadonlySet<string>;
  /** Non-role record paths under `contextPath` that this role can read. */
  readablePaths: [string, ...string[]];
};

/** Identifies a context root node in a resolved module graph by its owning module, path, depth, and ancestor chain. */
export type ModuleContextRoot = Pick<ResolvedModuleNode,
  'owningModuleUri' | 'owningModulePath' | 'physicalAncestors' | 'physicalDepth'>;

/** Find the node in `graph` that represents `root` — either the context root record itself or the top-level `$ref` node that attaches to it. */
export function resolveModuleContextRoot(graph: ResolvedModuleGraph, root: ModuleContextRoot): ResolvedModuleNode {
  const matchingNodes = [...graph.nodesByDeclaredPath.values()].filter(node =>
    node.ruleSet.$role !== true && sameModuleAddress(node, root) && node.physicalDepth === root.physicalDepth &&
    sameAncestorChain(node.physicalAncestors, root.physicalAncestors));
  if (matchingNodes.length !== 1) {
    throw new TypeError(`Module '${graph.rootModuleUri}' must declare one exact shared root.`);
  }
  return matchingNodes[0];
}

/** Return direct `$role` child paths under `contextPath` that have `read` access to `contextPath`, in authored `$actions` order. */
export function resolveModuleContextRoles(graph: ResolvedModuleGraph, contextPath: string): readonly string[] {
  const contextNode = graph.nodesByDeclaredPath.get(contextPath);
  if (contextNode === undefined || contextNode.ruleSet.$role === true) {
    throw new TypeError(`Context path '${contextPath}' must identify a non-role record.`);
  }
  if (contextNode.kind === 'ref') {
    return [];
  }
  return contextNode.actions.filter(action => {
    const invokedRole = action.resolvedRole;
    const roleNode = action.rule.role === undefined ? undefined : graph.nodesByDeclaredPath.get(action.rule.role);
    return invokedRole !== undefined && roleNode?.kind === 'record' && invokedRole.owningModuleUri === graph.rootModuleUri &&
      action.rule.can.includes(ModuleAction.Read) && invokedRole.parentAncestor !== undefined &&
      sameModuleAddress(invokedRole.parentAncestor, contextNode) &&
      sameAncestorChain(invokedRole.physicalAncestors, [...contextNode.physicalAncestors, contextNode]);
  }).map(action => action.rule.role!);
}

/**
 * Resolve the context root path and authorized record paths for `role` within `graph`.
 *
 * When `graph` is the defining root module, `role` must authorize reading the context root record itself.
 * When `graph` is an attached module with a top-level `$ref` to that context root, `role` must authorize
 * reading at least one record path beneath the `$ref` attachment.
 */
export function resolveModuleRoleScope(graph: ResolvedModuleGraph, role: ResolvedRoleReference): ResolvedModuleRoleScope {
  const parent = role.parentAncestor;
  if (parent === undefined || role.ruleSet.$role !== true ||
      role.parentPhysicalDepth !== role.physicalAncestors.length ||
      role.physicalDepth !== role.parentPhysicalDepth + 1 ||
      !sameModuleAddress(role.physicalAncestors.at(-1), parent)) {
    throw new TypeError('A context scope requires a contextual role and its physical parent.');
  }
  const contextRootNode = resolveModuleContextRoot(graph, {
    ...parent,
    physicalDepth     : role.parentPhysicalDepth,
    physicalAncestors : role.physicalAncestors.slice(0, -1),
  });
  const contextPath = contextRootNode.declaringModulePath;
  const allowedPaths: string[] = [];
  const readablePaths: string[] = [];
  const invokedRoles = new Set<string>();
  for (const [path, node] of graph.nodesByDeclaredPath) {
    if (!isRecordUnderContext(graph.rootModuleUri, contextPath, path, node)) {
      continue;
    }
    const matchingActions = node.actions.filter(action => action.resolvedRole !== undefined &&
      sameModuleAddress(action.resolvedRole, role) && sameAncestorChain(action.resolvedRole.physicalAncestors, role.physicalAncestors));
    if (matchingActions.length === 0) {
      continue;
    }
    allowedPaths.push(path);
    for (const action of matchingActions) {
      invokedRoles.add(action.rule.role!);
    }
    if (matchingActions.some(action => action.rule.can.includes(ModuleAction.Read))) {
      readablePaths.push(path);
    }
  }
  if (contextRootNode.kind === 'record' && !readablePaths.includes(contextPath)) {
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

function isRecordUnderContext(moduleUri: string, contextPath: string, path: string, node: ResolvedModuleNode): boolean {
  return node.kind === 'record' && node.owningModuleUri === moduleUri &&
    node.declaringModuleUri === moduleUri && node.ruleSet.$role !== true &&
    (path === contextPath || path.startsWith(`${contextPath}/`));
}

function sameModuleAddress(left: ResolvedModuleAddress | undefined, right: ResolvedModuleAddress): boolean {
  return left?.owningModuleUri === right.owningModuleUri && left.owningModulePath === right.owningModulePath;
}

function sameAncestorChain(left: readonly ResolvedModuleAddress[], right: readonly ResolvedModuleAddress[]): boolean {
  return left.length === right.length && left.every((ancestor, index) => sameModuleAddress(ancestor, right[index]));
}
