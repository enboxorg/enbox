import type { ModuleDefinition, ModuleRuleSet } from '../types/modules-types.js';
import type { PermissionScope, RecordsPermissionScope } from '../types/permission-types.js';

import { FilterUtility } from './filter.js';
import { KeyDerivationScheme } from './hd-key.js';
import { ModuleAction } from '../types/modules-types.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { getRuleSetAtPath, parseCrossModuleRef } from './modules.js';

type GrantKeyRecordsScopeBase = RecordsPermissionScope & {
  interface: typeof DwnInterfaceName.Records;
  module: string;
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

export type GrantKeyModulePathScope = {
  scheme: typeof KeyDerivationScheme.ModulePath;
  module: string;
  modulePath?: string;
};

type GrantKeyDeliveryScopeBuilder = (
  grantScope: GrantKeyEligibleRecordsScope,
  moduleDefinition?: ModuleDefinition,
) => GrantKeyModulePathScope[];

type GrantKeyCoveragePredicate = (
  input: {
    grantScope: GrantKeyEligibleRecordsScope;
    deliveredScope: Pick<GrantKeyModulePathScope, 'module' | 'modulePath'>;
    moduleDefinition?: ModuleDefinition;
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
  const maybeModule = (scope as { module?: unknown }).module;
  return [
    scope.interface === DwnInterfaceName.Records,
    grantKeyRecordsMethods.has(scope.method),
    typeof maybeModule === 'string',
  ].every(Boolean);
}

export function isGrantKeyEligibleRecordsScope(scope: PermissionScope): scope is GrantKeyEligibleRecordsScope {
  return isGrantKeyRecordsScope(scope) &&
    !('contextId' in scope && scope.contextId !== undefined);
}

export function getGrantKeyDeliveryScopes(
  grantScope: GrantKeyReadRecordsScope,
  moduleDefinition?: ModuleDefinition,
): GrantKeyModulePathScope[];

export function getGrantKeyDeliveryScopes(
  grantScope: GrantKeyWriteRecordsScope,
  moduleDefinition: ModuleDefinition,
): GrantKeyModulePathScope[];

export function getGrantKeyDeliveryScopes(
  grantScope: GrantKeyEligibleRecordsScope,
  moduleDefinition?: ModuleDefinition,
): GrantKeyModulePathScope[] {
  return uniqueGrantKeyScopes(grantKeyDeliveryScopeBuilders[grantScope.method](grantScope, moduleDefinition));
}

export function grantKeyScopeCoversDeliveredScope(input: {
  grantScope: GrantKeyEligibleRecordsScope;
  deliveredScope: Pick<GrantKeyModulePathScope, 'module' | 'modulePath'>;
  moduleDefinition?: ModuleDefinition;
}): boolean {
  const { grantScope, deliveredScope, moduleDefinition } = input;
  if (grantScope.module !== deliveredScope.module) {
    return false;
  }

  return grantKeyCoveragePredicates[grantScope.method]({ grantScope, deliveredScope, moduleDefinition });
}

function getReadGrantKeyDeliveryScopes(
  grantScope: GrantKeyEligibleRecordsScope,
  moduleDefinition?: ModuleDefinition,
): GrantKeyModulePathScope[] {
  if (grantScope.modulePath === undefined) {
    return [createModuleGrantKeyScope(grantScope.module)];
  }

  const scopes = [
    createModulePathGrantKeyScope(grantScope.module, grantScope.modulePath),
  ];

  if (moduleDefinition === undefined) {
    return scopes;
  }

  for (const rolePath of getGrantKeyReadRolePathsForScope(moduleDefinition, grantScope.modulePath)) {
    scopes.push(createModulePathGrantKeyScope(grantScope.module, rolePath));
  }

  return scopes;
}

function getWriteGrantKeyDeliveryScopes(
  grantScope: GrantKeyEligibleRecordsScope,
  moduleDefinition?: ModuleDefinition,
): GrantKeyModulePathScope[] {
  if (moduleDefinition === undefined) {
    throw new Error('getGrantKeyDeliveryScopes: write grants require a module definition.');
  }

  return getGrantKeyRolePathsCoveredByScope(moduleDefinition, grantScope.modulePath)
    .map((rolePath) => createModulePathGrantKeyScope(grantScope.module, rolePath));
}

function createModuleGrantKeyScope(module: string): GrantKeyModulePathScope {
  return {
    scheme: KeyDerivationScheme.ModulePath,
    module,
  };
}

function createModulePathGrantKeyScope(module: string, modulePath: string): GrantKeyModulePathScope {
  return {
    scheme: KeyDerivationScheme.ModulePath,
    module,
    modulePath,
  };
}

function readGrantKeyScopeCoversDeliveredScope(input: {
  grantScope: GrantKeyEligibleRecordsScope;
  deliveredScope: Pick<GrantKeyModulePathScope, 'module' | 'modulePath'>;
  moduleDefinition?: ModuleDefinition;
}): boolean {
  const { grantScope, deliveredScope, moduleDefinition } = input;
  const grantModulePath = grantScope.modulePath;
  if (grantModulePath === undefined) {
    return true;
  }

  const deliveredModulePath = deliveredScope.modulePath;
  if (deliveredModulePath === undefined) {
    return false;
  }

  if (FilterUtility.matchesSubtree(grantModulePath, deliveredModulePath)) {
    return true;
  }

  if (moduleDefinition === undefined) {
    return false;
  }

  return grantKeyReadScopeReferencesRolePath(moduleDefinition, grantModulePath, deliveredModulePath);
}

function writeGrantKeyScopeCoversDeliveredScope(input: {
  grantScope: GrantKeyEligibleRecordsScope;
  deliveredScope: Pick<GrantKeyModulePathScope, 'module' | 'modulePath'>;
  moduleDefinition?: ModuleDefinition;
}): boolean {
  const { grantScope, deliveredScope, moduleDefinition } = input;
  const deliveredModulePath = deliveredScope.modulePath;
  if (deliveredModulePath === undefined) {
    return false;
  }

  if (moduleDefinition === undefined) {
    return false;
  }

  if (!isGrantKeyLocalRolePath(moduleDefinition, deliveredModulePath)) {
    return false;
  }

  const grantModulePath = grantScope.modulePath;
  if (grantModulePath === undefined) {
    return true;
  }

  return FilterUtility.matchesSubtree(grantModulePath, deliveredModulePath);
}

function getGrantKeyReadRolePathsForScope(moduleDefinition: ModuleDefinition, scopeModulePath: string): string[] {
  const scopedRuleSet = getRuleSetAtPath(scopeModulePath, moduleDefinition.structure);
  if (scopedRuleSet === undefined) {
    return [];
  }

  return [...collectReadRolePaths(moduleDefinition, scopedRuleSet)];
}

function grantKeyReadScopeReferencesRolePath(
  moduleDefinition: ModuleDefinition,
  scopeModulePath: string,
  rolePath: string,
): boolean {
  if (!isGrantKeyLocalRolePath(moduleDefinition, rolePath)) {
    return false;
  }

  return getGrantKeyReadRolePathsForScope(moduleDefinition, scopeModulePath).includes(rolePath);
}

function collectReadRolePaths(moduleDefinition: ModuleDefinition, ruleSet: ModuleRuleSet): Set<string> {
  const rolePaths = new Set<string>();

  for (const actionRule of ruleSet.$actions ?? []) {
    if (!actionRule.can.includes(ModuleAction.Read) || actionRule.role === undefined || parseCrossModuleRef(actionRule.role) !== undefined) {
      continue;
    }

    if (isGrantKeyLocalRolePath(moduleDefinition, actionRule.role)) {
      rolePaths.add(actionRule.role);
    }
  }

  for (const [key, value] of Object.entries(ruleSet)) {
    if (key.startsWith('$')) {
      continue;
    }
    for (const rolePath of collectReadRolePaths(moduleDefinition, value as ModuleRuleSet)) {
      rolePaths.add(rolePath);
    }
  }

  return rolePaths;
}

function getGrantKeyRolePathsCoveredByScope(moduleDefinition: ModuleDefinition, scopeModulePath?: string): string[] {
  return collectRolePaths(moduleDefinition, moduleDefinition.structure as ModuleRuleSet)
    .filter((rolePath) => scopeModulePath === undefined || FilterUtility.matchesSubtree(scopeModulePath, rolePath));
}

function collectRolePaths(moduleDefinition: ModuleDefinition, ruleSet: ModuleRuleSet, parentPath: string[] = []): string[] {
  const rolePaths: string[] = [];

  for (const [key, value] of Object.entries(ruleSet)) {
    if (key.startsWith('$')) {
      continue;
    }

    const path = [...parentPath, key];
    const modulePath = path.join('/');
    const childRuleSet = value as ModuleRuleSet;
    if (isGrantKeyLocalRolePath(moduleDefinition, modulePath)) {
      rolePaths.push(modulePath);
    }
    rolePaths.push(...collectRolePaths(moduleDefinition, childRuleSet, path));
  }

  return rolePaths;
}

function isGrantKeyLocalRolePath(moduleDefinition: ModuleDefinition, modulePath: string): boolean {
  const ruleSet = getRuleSetAtPath(modulePath, moduleDefinition.structure);
  return ruleSet?.$role === true && ruleSet.$keyAgreement !== undefined;
}

function getGrantKeyScopeCacheKey(scope: GrantKeyModulePathScope): string {
  return JSON.stringify([scope.module, scope.modulePath]);
}

function uniqueGrantKeyScopes(scopes: GrantKeyModulePathScope[]): GrantKeyModulePathScope[] {
  const deliveredScopes = new Map<string, GrantKeyModulePathScope>();
  for (const scope of scopes) {
    deliveredScopes.set(getGrantKeyScopeCacheKey(scope), scope);
  }

  return [...deliveredScopes.values()];
}
