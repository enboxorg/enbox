import type { PermissionScope, RecordsPermissionScope } from '../types/permission-types.js';
import type { ProtocolDefinition, ProtocolRuleSet } from '../types/protocols-types.js';

import { FilterUtility } from './filter.js';
import { KeyDerivationScheme } from './hd-key.js';
import { ProtocolAction } from '../types/protocols-types.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { getRuleSetAtPath, parseCrossProtocolRef } from './protocols.js';

type GrantKeyRecordsScopeBase = RecordsPermissionScope & {
  interface: typeof DwnInterfaceName.Records;
  protocol: string;
};

export type GrantKeyRecordsScope = GrantKeyRecordsScopeBase & {
  method: typeof DwnMethodName.Read | typeof DwnMethodName.Write;
};

export type GrantKeyReadRecordsScope = GrantKeyRecordsScopeBase & {
  contextId?: undefined;
  method: typeof DwnMethodName.Read;
};

export type GrantKeyWriteRecordsScope = GrantKeyRecordsScopeBase & {
  contextId?: undefined;
  method: typeof DwnMethodName.Write;
};

export type GrantKeyEligibleRecordsScope = GrantKeyReadRecordsScope | GrantKeyWriteRecordsScope;

export type GrantKeyProtocolPathScope = {
  scheme: typeof KeyDerivationScheme.ProtocolPath;
  protocol: string;
  protocolPath?: string;
};

type GrantKeyDeliveryScopeBuilder = (
  grantScope: GrantKeyEligibleRecordsScope,
  protocolDefinition?: ProtocolDefinition,
) => GrantKeyProtocolPathScope[];

type GrantKeyCoveragePredicate = (
  input: {
    grantScope: GrantKeyEligibleRecordsScope;
    deliveredScope: Pick<GrantKeyProtocolPathScope, 'protocol' | 'protocolPath'>;
    protocolDefinition?: ProtocolDefinition;
  },
) => boolean;

const grantKeyRecordsMethods = new Set<string>([
  DwnMethodName.Read,
  DwnMethodName.Write,
]);

const grantKeyDeliveryScopeBuilders: Record<GrantKeyRecordsScope['method'], GrantKeyDeliveryScopeBuilder> = {
  [DwnMethodName.Read]  : getReadGrantKeyDeliveryScopes,
  [DwnMethodName.Write] : getWriteGrantKeyDeliveryScopes,
};

const grantKeyCoveragePredicates: Record<GrantKeyRecordsScope['method'], GrantKeyCoveragePredicate> = {
  [DwnMethodName.Read]  : readGrantKeyScopeCoversDeliveredScope,
  [DwnMethodName.Write] : writeGrantKeyScopeCoversDeliveredScope,
};

export function isGrantKeyRecordsScope(scope: PermissionScope): scope is GrantKeyRecordsScope {
  const maybeProtocol = (scope as { protocol?: unknown }).protocol;
  return [
    scope.interface === DwnInterfaceName.Records,
    grantKeyRecordsMethods.has(scope.method),
    typeof maybeProtocol === 'string',
  ].every(Boolean);
}

export function isGrantKeyEligibleRecordsScope(scope: PermissionScope): scope is GrantKeyEligibleRecordsScope {
  return isGrantKeyRecordsScope(scope) &&
    !('contextId' in scope && scope.contextId !== undefined);
}

export function getGrantKeyDeliveryScopes(
  grantScope: GrantKeyReadRecordsScope,
  protocolDefinition?: ProtocolDefinition,
): GrantKeyProtocolPathScope[];

export function getGrantKeyDeliveryScopes(
  grantScope: GrantKeyWriteRecordsScope,
  protocolDefinition: ProtocolDefinition,
): GrantKeyProtocolPathScope[];

export function getGrantKeyDeliveryScopes(
  grantScope: GrantKeyEligibleRecordsScope,
  protocolDefinition?: ProtocolDefinition,
): GrantKeyProtocolPathScope[] {
  return uniqueGrantKeyScopes(grantKeyDeliveryScopeBuilders[grantScope.method](grantScope, protocolDefinition));
}

export function grantKeyScopeCoversDeliveredScope(input: {
  grantScope: GrantKeyEligibleRecordsScope;
  deliveredScope: Pick<GrantKeyProtocolPathScope, 'protocol' | 'protocolPath'>;
  protocolDefinition?: ProtocolDefinition;
}): boolean {
  const { grantScope, deliveredScope, protocolDefinition } = input;
  if (grantScope.protocol !== deliveredScope.protocol) {
    return false;
  }

  return grantKeyCoveragePredicates[grantScope.method]({ grantScope, deliveredScope, protocolDefinition });
}

function getReadGrantKeyDeliveryScopes(
  grantScope: GrantKeyEligibleRecordsScope,
  protocolDefinition?: ProtocolDefinition,
): GrantKeyProtocolPathScope[] {
  if (grantScope.protocolPath === undefined) {
    return [createProtocolGrantKeyScope(grantScope.protocol)];
  }

  const scopes = [
    createProtocolPathGrantKeyScope(grantScope.protocol, grantScope.protocolPath),
  ];

  if (protocolDefinition === undefined) {
    return scopes;
  }

  for (const rolePath of getGrantKeyReadRolePathsForScope(protocolDefinition, grantScope.protocolPath)) {
    scopes.push(createProtocolPathGrantKeyScope(grantScope.protocol, rolePath));
  }

  return scopes;
}

function getWriteGrantKeyDeliveryScopes(
  grantScope: GrantKeyEligibleRecordsScope,
  protocolDefinition?: ProtocolDefinition,
): GrantKeyProtocolPathScope[] {
  if (protocolDefinition === undefined) {
    throw new Error('getGrantKeyDeliveryScopes: write grants require a protocol definition.');
  }

  return getGrantKeyRolePathsCoveredByScope(protocolDefinition, grantScope.protocolPath)
    .map((rolePath) => createProtocolPathGrantKeyScope(grantScope.protocol, rolePath));
}

function createProtocolGrantKeyScope(protocol: string): GrantKeyProtocolPathScope {
  return {
    scheme: KeyDerivationScheme.ProtocolPath,
    protocol,
  };
}

function createProtocolPathGrantKeyScope(protocol: string, protocolPath: string): GrantKeyProtocolPathScope {
  return {
    scheme: KeyDerivationScheme.ProtocolPath,
    protocol,
    protocolPath,
  };
}

function readGrantKeyScopeCoversDeliveredScope(input: {
  grantScope: GrantKeyEligibleRecordsScope;
  deliveredScope: Pick<GrantKeyProtocolPathScope, 'protocol' | 'protocolPath'>;
  protocolDefinition?: ProtocolDefinition;
}): boolean {
  const { grantScope, deliveredScope, protocolDefinition } = input;
  const grantProtocolPath = grantScope.protocolPath;
  if (grantProtocolPath === undefined) {
    return true;
  }

  const deliveredProtocolPath = deliveredScope.protocolPath;
  if (deliveredProtocolPath === undefined) {
    return false;
  }

  if (FilterUtility.matchesSubtree(grantProtocolPath, deliveredProtocolPath)) {
    return true;
  }

  if (protocolDefinition === undefined) {
    return false;
  }

  return grantKeyReadScopeReferencesRolePath(protocolDefinition, grantProtocolPath, deliveredProtocolPath);
}

function writeGrantKeyScopeCoversDeliveredScope(input: {
  grantScope: GrantKeyEligibleRecordsScope;
  deliveredScope: Pick<GrantKeyProtocolPathScope, 'protocol' | 'protocolPath'>;
  protocolDefinition?: ProtocolDefinition;
}): boolean {
  const { grantScope, deliveredScope, protocolDefinition } = input;
  const deliveredProtocolPath = deliveredScope.protocolPath;
  if (deliveredProtocolPath === undefined) {
    return false;
  }

  if (protocolDefinition === undefined) {
    return false;
  }

  if (!isGrantKeyLocalRolePath(protocolDefinition, deliveredProtocolPath)) {
    return false;
  }

  const grantProtocolPath = grantScope.protocolPath;
  if (grantProtocolPath === undefined) {
    return true;
  }

  return FilterUtility.matchesSubtree(grantProtocolPath, deliveredProtocolPath);
}

function getGrantKeyReadRolePathsForScope(protocolDefinition: ProtocolDefinition, scopeProtocolPath: string): string[] {
  const scopedRuleSet = getRuleSetAtPath(scopeProtocolPath, protocolDefinition.structure);
  if (scopedRuleSet === undefined) {
    return [];
  }

  return [...collectReadRolePaths(protocolDefinition, scopedRuleSet)];
}

function grantKeyReadScopeReferencesRolePath(
  protocolDefinition: ProtocolDefinition,
  scopeProtocolPath: string,
  rolePath: string,
): boolean {
  if (!isGrantKeyLocalRolePath(protocolDefinition, rolePath)) {
    return false;
  }

  return getGrantKeyReadRolePathsForScope(protocolDefinition, scopeProtocolPath).includes(rolePath);
}

function collectReadRolePaths(protocolDefinition: ProtocolDefinition, ruleSet: ProtocolRuleSet): Set<string> {
  const rolePaths = new Set<string>();

  for (const actionRule of ruleSet.$actions ?? []) {
    if (!actionRule.can.includes(ProtocolAction.Read) || actionRule.role === undefined || parseCrossProtocolRef(actionRule.role) !== undefined) {
      continue;
    }

    if (isGrantKeyLocalRolePath(protocolDefinition, actionRule.role)) {
      rolePaths.add(actionRule.role);
    }
  }

  for (const [key, value] of Object.entries(ruleSet)) {
    if (key.startsWith('$')) {
      continue;
    }
    for (const rolePath of collectReadRolePaths(protocolDefinition, value as ProtocolRuleSet)) {
      rolePaths.add(rolePath);
    }
  }

  return rolePaths;
}

function getGrantKeyRolePathsCoveredByScope(protocolDefinition: ProtocolDefinition, scopeProtocolPath?: string): string[] {
  return collectRolePaths(protocolDefinition, protocolDefinition.structure as ProtocolRuleSet)
    .filter((rolePath) => scopeProtocolPath === undefined || FilterUtility.matchesSubtree(scopeProtocolPath, rolePath));
}

function collectRolePaths(protocolDefinition: ProtocolDefinition, ruleSet: ProtocolRuleSet, parentPath: string[] = []): string[] {
  const rolePaths: string[] = [];

  for (const [key, value] of Object.entries(ruleSet)) {
    if (key.startsWith('$')) {
      continue;
    }

    const path = [...parentPath, key];
    const protocolPath = path.join('/');
    const childRuleSet = value as ProtocolRuleSet;
    if (isGrantKeyLocalRolePath(protocolDefinition, protocolPath)) {
      rolePaths.push(protocolPath);
    }
    rolePaths.push(...collectRolePaths(protocolDefinition, childRuleSet, path));
  }

  return rolePaths;
}

function isGrantKeyLocalRolePath(protocolDefinition: ProtocolDefinition, protocolPath: string): boolean {
  const ruleSet = getRuleSetAtPath(protocolPath, protocolDefinition.structure);
  return ruleSet?.$role === true && ruleSet.$keyAgreement !== undefined;
}

function getGrantKeyScopeCacheKey(scope: GrantKeyProtocolPathScope): string {
  return JSON.stringify([scope.protocol, scope.protocolPath]);
}

function uniqueGrantKeyScopes(scopes: GrantKeyProtocolPathScope[]): GrantKeyProtocolPathScope[] {
  const deliveredScopes = new Map<string, GrantKeyProtocolPathScope>();
  for (const scope of scopes) {
    deliveredScopes.set(getGrantKeyScopeCacheKey(scope), scope);
  }

  return [...deliveredScopes.values()];
}
