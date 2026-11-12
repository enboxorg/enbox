import type { ResolvedModuleNode } from '@enbox/dwn-sdk-js';

import { canonicalJsonStringify } from '@enbox/common';
import { lexicographicalCompare } from '@enbox/dwn-sdk-js';

/** Deterministic equality for module definitions, including runtime encryption keys. */
export function installedModuleDefinitionsEqual(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

/** Whether two resolved record nodes have the same wire representation, owning module/path, and ancestor chain. */
export function recordRepresentationsEqual(expected: ResolvedModuleNode, actual: ResolvedModuleNode): boolean {
  if (
    expected.owningModuleUri !== actual.owningModuleUri
    || expected.owningModulePath !== actual.owningModulePath
    || expected.recordType.schema !== actual.recordType.schema
    || (expected.recordType.encryptionRequired === true) !== (actual.recordType.encryptionRequired === true)
    || (expected.ruleSet.$role === true) !== (actual.ruleSet.$role === true)
    || (expected.ruleSet.$squash === true) !== (actual.ruleSet.$squash === true)
    || expected.physicalAncestors.length !== actual.physicalAncestors.length
  ) {
    return false;
  }
  for (let index = 0; index < expected.physicalAncestors.length; index++) {
    const left = expected.physicalAncestors[index];
    const right = actual.physicalAncestors[index];
    if (left.owningModuleUri !== right.owningModuleUri || left.owningModulePath !== right.owningModulePath) {
      return false;
    }
  }
  return sameDataFormats(expected.recordType.dataFormats, actual.recordType.dataFormats);
}

function sameDataFormats(
  expected: readonly string[] | undefined,
  actual: readonly string[] | undefined,
): boolean {
  if (expected === undefined || actual === undefined) {
    return expected === actual;
  }
  const left = [...new Set(expected)].sort(lexicographicalCompare);
  const right = [...new Set(actual)].sort(lexicographicalCompare);
  return left.length === right.length && left.every((format, index) => format === right[index]);
}
