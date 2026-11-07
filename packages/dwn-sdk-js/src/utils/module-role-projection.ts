import type {
  ResolvedModuleAddress,
  ResolvedModuleGraph,
  ResolvedModuleNode,
  ResolvedRoleReference,
} from '../core/module-graph.js';

import { lexicographicalCompare } from './string.js';
import { ModuleAction } from '../types/modules-types.js';

/** Consumer-owned content authorized by a role on an explicitly attached shared root. */
export type ResolvedModuleRoleProjection = {
  /** Local virtual attachment path; this path itself is never a record. */
  attachmentPath: string;
  /** A consumer-local spelling of the verified root role, suitable for role invocation. */
  moduleRole: string;
  allowedPaths: ReadonlySet<string>;
  readablePaths: [string, ...string[]];
};

/** Canonical root coordinates needed to bind an explicitly selected module. */
export type ModuleAttachmentRoot = Pick<ResolvedModuleNode,
  'owningModuleUri' | 'owningModulePath' | 'physicalAncestors' | 'physicalDepth'>;

/** Resolve exactly one virtual mount to the supplied physical root, independently of actor authority. */
export function resolveModuleAttachment(graph: ResolvedModuleGraph, root: ModuleAttachmentRoot): ResolvedModuleNode {
  const attachments = [...graph.nodesByDeclaredPath.values()].filter(node =>
    node.kind === 'ref' && sameAddress(node, root) && node.physicalDepth === root.physicalDepth &&
    sameAncestors(node.physicalAncestors, root.physicalAncestors));
  if (attachments.length !== 1) {
    throw new TypeError(`Module '${graph.rootModuleUri}' must have one attachment to the exact shared root.`);
  }
  return attachments[0];
}

/**
 * Resolve one consumer's exact attachment to a contextual role's physical parent.
 * Callers supply a graph built from verified definitions for the same tenant.
 * This derives paths, not membership or delegated authority; those must be
 * verified independently before opening the corresponding replication link.
 */
export function resolveModuleRoleProjection(
  graph: ResolvedModuleGraph,
  rootRole: ResolvedRoleReference,
): ResolvedModuleRoleProjection {
  const parent = rootRole.parentAncestor;
  if (parent === undefined || rootRole.ruleSet.$role !== true ||
      rootRole.parentPhysicalDepth !== rootRole.physicalAncestors.length ||
      !sameAddress(rootRole.physicalAncestors.at(-1), parent)) {
    throw new TypeError('A module projection requires a contextual role and its physical parent.');
  }

  const attachment = resolveModuleAttachment(graph, {
    ...parent,
    physicalDepth     : rootRole.parentPhysicalDepth,
    physicalAncestors : rootRole.physicalAncestors.slice(0, -1),
  });
  const attachmentPath = attachment.declaringModulePath;
  const allowedPaths: string[] = [];
  const readablePaths: string[] = [];
  const invokedRoles = new Set<string>();
  for (const [path, node] of graph.nodesByDeclaredPath) {
    if (!isConsumerContent(graph.rootModuleUri, attachmentPath, path, node)) {
      continue;
    }
    const actions = node.actions.filter(action => action.resolvedRole !== undefined &&
      sameAddress(action.resolvedRole, rootRole) &&
      sameAncestors(action.resolvedRole.physicalAncestors, rootRole.physicalAncestors));
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
  if (readablePaths.length === 0) {
    throw new TypeError(`Module '${graph.rootModuleUri}' has no consumer records readable through the selected context role.`);
  }

  allowedPaths.sort(lexicographicalCompare);
  readablePaths.sort(lexicographicalCompare);
  return {
    attachmentPath,
    moduleRole    : [...invokedRoles].sort(lexicographicalCompare)[0],
    allowedPaths  : new Set(allowedPaths),
    readablePaths : readablePaths as [string, ...string[]],
  };
}

function isConsumerContent(moduleUri: string, attachmentPath: string, path: string, node: ResolvedModuleNode): boolean {
  return node.kind === 'record' && node.owningModuleUri === moduleUri &&
    node.declaringModuleUri === moduleUri && node.ruleSet.$role !== true &&
    path.startsWith(`${attachmentPath}/`);
}

function sameAddress(left: ResolvedModuleAddress | undefined, right: ResolvedModuleAddress): boolean {
  return left?.owningModuleUri === right.owningModuleUri && left.owningModulePath === right.owningModulePath;
}

function sameAncestors(left: readonly ResolvedModuleAddress[], right: readonly ResolvedModuleAddress[]): boolean {
  return left.length === right.length && left.every((ancestor, index) => sameAddress(ancestor, right[index]));
}
