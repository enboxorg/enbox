import type {
  ResolvedModuleAddress,
  ResolvedModuleGraph,
  ResolvedModuleNode,
  ResolvedRoleReference,
} from '../core/module-graph.js';

import { FilterUtility } from './filter.js';
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

/** Identifies a context root by the module URI and record path that define it. */
export type ModuleContextRoot = ResolvedModuleAddress;

/** Find the node in `graph` that represents `root` — either the context root record itself or the top-level `$ref` node that attaches to it. */
export function resolveModuleContextRoot(graph: ResolvedModuleGraph, root: ModuleContextRoot): ResolvedModuleNode {
  const matchingNodes = [...graph.nodesByDeclaredPath.values()].filter(
    node => node.ruleSet.$role !== true && sameModuleAddress(node, root),
  );
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
  return contextNode.actions
    .filter(action =>
      action.rule.can.includes(ModuleAction.Read) &&
      action.rule.role !== undefined &&
      graph.nodesByDeclaredPath.get(action.rule.role)?.kind === 'record' &&
      sameModuleAddress(action.resolvedRole?.parentAncestor, contextNode),
    )
    .map(action => action.rule.role!);
}

/**
 * Resolve the context root path and authorized record paths for `role` within `graph`.
 *
 * When `graph` is the defining root module, `role` must authorize reading the context root record itself.
 * When `graph` is an attached module with a top-level `$ref` to that context root, `role` must authorize
 * reading at least one record path beneath the `$ref` attachment.
 */
export function resolveModuleRoleScope(graph: ResolvedModuleGraph, role: ResolvedRoleReference): ResolvedModuleRoleScope {
  if (role.parentAncestor === undefined || role.ruleSet.$role !== true) {
    throw new TypeError('A context scope requires a contextual role and its parent context.');
  }
  const contextRootNode = resolveModuleContextRoot(graph, role.parentAncestor);
  const contextPath = contextRootNode.declaringModulePath;
  const allowedPaths: string[] = [];
  const readablePaths: string[] = [];
  const invokedRoles = new Set<string>();
  for (const [path, node] of graph.nodesByDeclaredPath) {
    if (!isRecordUnderContext(graph.rootModuleUri, contextPath, path, node)) {
      continue;
    }
    let matched = false;
    let readable = false;
    for (const action of node.actions) {
      if (!sameModuleAddress(action.resolvedRole, role)) {
        continue;
      }
      matched = true;
      invokedRoles.add(action.rule.role!);
      if (action.rule.can.includes(ModuleAction.Read)) {
        readable = true;
      }
    }
    if (!matched) {
      continue;
    }
    allowedPaths.push(path);
    if (readable) {
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
    FilterUtility.matchesSubtree(contextPath, path);
}

function sameModuleAddress(left: ResolvedModuleAddress | undefined, right: ResolvedModuleAddress): boolean {
  return left?.owningModuleUri === right.owningModuleUri && left.owningModulePath === right.owningModulePath;
}
