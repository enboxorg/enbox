import type { PermissionScope, RecordsPermissionScope } from '../types/permission-types.js';
import type { ProtocolDefinition, ProtocolRuleSet } from '../types/protocols-types.js';

import { KeyDerivationScheme } from './hd-key.js';
import { ProtocolAction } from '../types/protocols-types.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { getRuleSetAtPath, parseCrossProtocolRef } from './protocols.js';

export type GrantKeyRecordsScope = RecordsPermissionScope & {
  interface: typeof DwnInterfaceName.Records;
  method: typeof DwnMethodName.Read | typeof DwnMethodName.Write;
  protocol: string;
};

export type GrantKeyEligibleRecordsScope = GrantKeyRecordsScope & {
  contextId?: undefined;
};

export type GrantKeyProtocolPathScope = {
  scheme: typeof KeyDerivationScheme.ProtocolPath;
  protocol: string;
  protocolPath?: string;
};

export function isGrantKeyRecordsScope(scope: PermissionScope): scope is GrantKeyRecordsScope {
  return scope.interface === DwnInterfaceName.Records &&
    (scope.method === DwnMethodName.Read || scope.method === DwnMethodName.Write) &&
    'protocol' in scope &&
    typeof scope.protocol === 'string';
}

export function isGrantKeyEligibleRecordsScope(scope: PermissionScope): scope is GrantKeyEligibleRecordsScope {
  return isGrantKeyRecordsScope(scope) &&
    !('contextId' in scope && scope.contextId !== undefined);
}

export function getGrantKeyDeliveryScopes(
  grantScope: GrantKeyEligibleRecordsScope,
  protocolDefinition?: ProtocolDefinition,
): GrantKeyProtocolPathScope[] {
  const deliveredScopes = new Map<string, GrantKeyProtocolPathScope>();
  const addScope = (scope: GrantKeyProtocolPathScope): void => {
    deliveredScopes.set(getGrantKeyScopeCacheKey(scope), scope);
  };

  if (grantScope.method === DwnMethodName.Read) {
    if (grantScope.protocolPath === undefined) {
      addScope({
        scheme   : KeyDerivationScheme.ProtocolPath,
        protocol : grantScope.protocol,
      });
      return [...deliveredScopes.values()];
    }

    addScope({
      scheme       : KeyDerivationScheme.ProtocolPath,
      protocol     : grantScope.protocol,
      protocolPath : grantScope.protocolPath,
    });

    if (protocolDefinition !== undefined) {
      for (const rolePath of getGrantKeyReadRolePathsForScope(protocolDefinition, grantScope.protocolPath)) {
        addScope({
          scheme       : KeyDerivationScheme.ProtocolPath,
          protocol     : grantScope.protocol,
          protocolPath : rolePath,
        });
      }
    }
  }

  if (grantScope.method === DwnMethodName.Write && protocolDefinition !== undefined) {
    for (const rolePath of getGrantKeyRolePathsCoveredByScope(protocolDefinition, grantScope.protocolPath)) {
      addScope({
        scheme       : KeyDerivationScheme.ProtocolPath,
        protocol     : grantScope.protocol,
        protocolPath : rolePath,
      });
    }
  }

  return [...deliveredScopes.values()];
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

  if (grantScope.method === DwnMethodName.Read) {
    if (grantScope.protocolPath === undefined) {
      return true;
    }

    if (deliveredScope.protocolPath !== undefined && isBoundaryAwareSubtree(grantScope.protocolPath, deliveredScope.protocolPath)) {
      return true;
    }

    if (deliveredScope.protocolPath === undefined || protocolDefinition === undefined) {
      return false;
    }

    return grantKeyReadScopeReferencesRolePath(protocolDefinition, grantScope.protocolPath, deliveredScope.protocolPath);
  }

  if (deliveredScope.protocolPath === undefined) {
    return false;
  }

  if (grantScope.protocolPath !== undefined && !isBoundaryAwareSubtree(grantScope.protocolPath, deliveredScope.protocolPath)) {
    return false;
  }

  return protocolDefinition !== undefined && isGrantKeyLocalRolePath(protocolDefinition, deliveredScope.protocolPath);
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
    .filter((rolePath) => scopeProtocolPath === undefined || isBoundaryAwareSubtree(scopeProtocolPath, rolePath));
}

function collectRolePaths(protocolDefinition: ProtocolDefinition, ruleSet: ProtocolRuleSet, parentPath?: string): string[] {
  const rolePaths: string[] = [];

  for (const [key, value] of Object.entries(ruleSet)) {
    if (key.startsWith('$')) {
      continue;
    }

    const protocolPath = parentPath === undefined ? key : `${parentPath}/${key}`;
    const childRuleSet = value as ProtocolRuleSet;
    if (isGrantKeyLocalRolePath(protocolDefinition, protocolPath)) {
      rolePaths.push(protocolPath);
    }
    rolePaths.push(...collectRolePaths(protocolDefinition, childRuleSet, protocolPath));
  }

  return rolePaths;
}

function isGrantKeyLocalRolePath(protocolDefinition: ProtocolDefinition, protocolPath: string): boolean {
  const ruleSet = getRuleSetAtPath(protocolPath, protocolDefinition.structure);
  return ruleSet?.$role === true && ruleSet.$keyAgreement !== undefined;
}

function isBoundaryAwareSubtree(scopePath: string, candidatePath: string): boolean {
  return candidatePath === scopePath || candidatePath.startsWith(scopePath + '/');
}

function getGrantKeyScopeCacheKey(scope: GrantKeyProtocolPathScope): string {
  return scope.protocolPath === undefined
    ? `${scope.protocol}~protocol`
    : `${scope.protocol}~protocolPath~${scope.protocolPath}`;
}
