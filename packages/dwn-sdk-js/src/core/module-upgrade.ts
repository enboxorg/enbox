import type { ModuleDefinition } from '../types/modules-types.js';
import type { ResolvedModuleGraph, ResolvedModuleNode, ResolvedRoleReference } from './module-graph.js';

import { lexicographicalCompare } from '../utils/string.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';

/** Validate a consumer's own immutable aliases and existing physical attachment bindings. */
export function validateModuleUpgrade(
  previous: ModuleDefinition,
  incoming: ModuleDefinition,
  oldGraph: ResolvedModuleGraph,
  newGraph: ResolvedModuleGraph,
  storedPaths: ReadonlySet<string>,
): void {
  validateUsesAliases(previous, incoming);

  for (const [path, oldNode] of oldGraph.nodesByDeclaredPath) {
    validateExistingNodeBinding(incoming.module, path, oldNode, newGraph, storedPaths);
  }

  // A temporary removal must not erase the physical binding of retained records.
  for (const [path, node] of newGraph.nodesByDeclaredPath) {
    if (node.kind === 'ref' && !oldGraph.nodesByDeclaredPath.has(path) && hasStoredRecordsInSubtree(storedPaths, path)) {
      incompatible(incoming.module, path, 'retained record parent binding');
    }
  }
}

/** Existing lexical aliases may be removed when unused, but cannot be renamed or retargeted. */
function validateUsesAliases(previous: ModuleDefinition, incoming: ModuleDefinition): void {
  const previousUses = previous.uses ?? {};
  const incomingUses = incoming.uses ?? {};
  for (const [alias, uri] of Object.entries(previousUses)) {
    const nextUri = incomingUses[alias];
    const renamed = nextUri === undefined && Object.entries(incomingUses)
      .some(([nextAlias, target]): boolean => nextAlias !== alias && target === uri);
    if ((nextUri !== undefined && nextUri !== uri) || renamed) {
      throw new DwnError(
        DwnErrorCode.ModulesConfigureInvalidUsesUpdate,
        `module '${incoming.module}' cannot rename or retarget uses alias '${alias}'`
      );
    }
  }
}

/** Keep each surviving node's kind and each retained reference's name and physical parent. */
function validateExistingNodeBinding(
  moduleUri: string,
  path: string,
  oldNode: ResolvedModuleNode,
  newGraph: ResolvedModuleGraph,
  storedPaths: ReadonlySet<string>,
): void {
  const newNode = newGraph.nodesByDeclaredPath.get(path);
  if (newNode !== undefined && oldNode.kind !== newNode.kind) {
    incompatible(moduleUri, path, 'node kind');
  }
  if (oldNode.kind !== 'ref') {
    return;
  }

  const renamed = [...newGraph.nodesByDeclaredPath.values()].some((node): boolean =>
    node.kind === 'ref' && node.declaringModulePath !== path && sameRecordAddress(oldNode, node)
  );
  if (renamed) {
    incompatible(moduleUri, path, 'attachment name');
  }
  const hasStoredDescendants = hasStoredRecordsInSubtree(storedPaths, path);
  if (newNode !== undefined || hasStoredDescendants) {
    if (newNode === undefined || oldNode.declaredRuleSet.$ref !== newNode.declaredRuleSet.$ref ||
        !sameRecordAddress(oldNode, newNode) || !equal(ancestry(oldNode), ancestry(newNode))) {
      incompatible(moduleUri, path, 'attachment parent');
    }
  }
}

/** Includes the path itself and every descendant that still has stored records. */
function hasStoredRecordsInSubtree(storedPaths: ReadonlySet<string>, path: string): boolean {
  return [...storedPaths].some(stored => stored === path || stored.startsWith(`${path}/`));
}

/** Compare only contracts explicitly imported by an unchanged reverse dependent. */
export function validateImportedModuleContracts(oldGraph: ResolvedModuleGraph, newGraph: ResolvedModuleGraph): void {
  for (const [path, oldNode] of oldGraph.nodesByDeclaredPath) {
    const newNode = newGraph.nodesByDeclaredPath.get(path);
    if (newNode === undefined) {
      incompatible(oldGraph.rootModuleUri, path, 'missing path');
    }
    if (oldNode.kind === 'ref' && !equal(attachmentContract(oldNode), attachmentContract(newNode))) {
      incompatible(oldGraph.rootModuleUri, path, 'attachment identity, ancestry, representation, or lifecycle');
    }

    validateImportedActionContracts(oldGraph.rootModuleUri, path, oldNode, newNode);
  }
}

/** An unchanged consumer must resolve each role and actor rule to the same imported contract. */
function validateImportedActionContracts(
  moduleUri: string, path: string, oldNode: ResolvedModuleNode, newNode: ResolvedModuleNode,
): void {
  for (let index = 0; index < oldNode.actions.length; index++) {
    const previous = oldNode.actions[index];
    const incoming = newNode.actions[index];
    if (previous.resolvedRole !== undefined &&
        (incoming?.resolvedRole === undefined || !equal(roleContract(previous.resolvedRole), roleContract(incoming.resolvedRole)))) {
      incompatible(moduleUri, path, `role '${previous.rule.role}' identity or context`);
    }
    if (previous.resolvedActor !== undefined &&
        (incoming?.resolvedActor === undefined || !equal(previous.resolvedActor, incoming.resolvedActor))) {
      incompatible(moduleUri, path, `actor '${previous.rule.of}' identity or ancestry`);
    }
  }
}

function sameRecordAddress(left: ResolvedModuleNode, right: ResolvedModuleNode): boolean {
  return left.owningModuleUri === right.owningModuleUri && left.owningModulePath === right.owningModulePath;
}

function ancestry(node: Pick<ResolvedModuleNode, 'physicalAncestors'>): readonly (readonly [string, string])[] {
  return node.physicalAncestors.map(step => [step.owningModuleUri, step.owningModulePath] as const);
}

function attachmentContract(node: ResolvedModuleNode): unknown {
  return {
    owner     : [node.owningModuleUri, node.owningModulePath],
    ancestors : ancestry(node),
    role      : node.ruleSet.$role === true,
    squash    : node.ruleSet.$squash === true,
    schema    : node.recordType.schema,
    formats   : node.recordType.dataFormats === undefined ? undefined : [...new Set(node.recordType.dataFormats)].sort(lexicographicalCompare),
    encrypted : node.recordType.encryptionRequired === true,
  };
}

function roleContract(role: ResolvedRoleReference): unknown {
  return {
    owner       : [role.owningModuleUri, role.owningModulePath],
    ancestors   : ancestry(role),
    parentDepth : role.parentPhysicalDepth,
    parent      : role.parentAncestor === undefined ? undefined : [role.parentAncestor.owningModuleUri, role.parentAncestor.owningModulePath],
    role        : role.ruleSet.$role === true,
  };
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function incompatible(consumer: string, path: string, contract: string): never {
  throw new DwnError(
    DwnErrorCode.ModulesConfigureIncompatibleContractUpdate,
    `module '${consumer}' path '${path}' has an incompatible ${contract}; use a new module URI`
  );
}
