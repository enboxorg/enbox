import type { ProtocolDefinition, ProtocolRuleSet } from '@enbox/dwn-sdk-js';

import { parseCrossProtocolRef } from '@enbox/dwn-sdk-js';

import { lexicographicalCompare } from './types/sync.js';

export type ProtocolClosureEdges = {
  dependencyProtocols: string[];
  usesProtocols: string[];
};

/**
 * Extracts the protocol-level closure edges a retained protocol definition can
 * introduce for sync registration validation.
 */
export function getProtocolClosureEdges(definition: ProtocolDefinition): ProtocolClosureEdges {
  const usesProtocols = sortedUnique(Object.values(definition.uses ?? {}));
  const dependencyProtocols = sortedUnique(collectDependencyProtocols(definition));

  return { dependencyProtocols, usesProtocols };
}

function collectDependencyProtocols(definition: ProtocolDefinition): string[] {
  const protocols: string[] = [];
  for (const ruleSet of Object.values(definition.structure)) {
    collectDependencyProtocolsFromRuleSet(ruleSet, definition.uses ?? {}, protocols);
  }

  return protocols;
}

function collectDependencyProtocolsFromRuleSet(
  ruleSet: ProtocolRuleSet,
  uses: Record<string, string>,
  protocols: string[],
): void {
  collectReferencedProtocol(ruleSet.$ref, uses, protocols);

  for (const actionRule of ruleSet.$actions ?? []) {
    collectReferencedProtocol(actionRule.role, uses, protocols);
    collectReferencedProtocol(actionRule.of, uses, protocols);
  }

  for (const [key, value] of Object.entries(ruleSet)) {
    if (key.startsWith('$') || !isProtocolRuleSet(value)) {
      continue;
    }

    collectDependencyProtocolsFromRuleSet(value, uses, protocols);
  }
}

function collectReferencedProtocol(
  ref: string | undefined,
  uses: Record<string, string>,
  protocols: string[],
): void {
  if (ref === undefined) {
    return;
  }

  const parsed = parseCrossProtocolRef(ref);
  if (parsed === undefined) {
    return;
  }

  const protocol = uses[parsed.alias];
  if (protocol !== undefined) {
    protocols.push(protocol);
  }
}

function isProtocolRuleSet(value: unknown): value is ProtocolRuleSet {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(lexicographicalCompare);
}
