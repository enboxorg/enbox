import type { ResolvedModuleNode } from '@enbox/dwn-sdk-js';

import { canonicalJsonStringify } from '@enbox/common';

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/** Deterministic equality for module definitions, including runtime encryption keys. */
export function installedModuleDefinitionsEqual(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

/** Representation and physical placement are codec contracts; mutable access policies are not. */
export function consumedRecordRepresentation(node: ResolvedModuleNode): unknown {
  return {
    owner     : [node.owningModuleUri, node.owningModulePath],
    ancestors : node.physicalAncestors.map(parent => [parent.owningModuleUri, parent.owningModulePath]),
    schema    : node.recordType.schema,
    formats   : node.recordType.dataFormats === undefined
      ? undefined
      : [...new Set(node.recordType.dataFormats)].sort(compareCodeUnits),
    encrypted : node.recordType.encryptionRequired === true,
    role      : node.ruleSet.$role === true,
    squash    : node.ruleSet.$squash === true,
  };
}

/** Whether two resolved record nodes share the exact wire representation and physical ancestry. */
export function recordRepresentationsEqual(expected: ResolvedModuleNode, actual: ResolvedModuleNode): boolean {
  return installedModuleDefinitionsEqual(
    consumedRecordRepresentation(expected),
    consumedRecordRepresentation(actual),
  );
}
