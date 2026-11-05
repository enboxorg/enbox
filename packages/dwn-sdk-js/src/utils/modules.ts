import type { EncryptionKeyDeriver } from '../types/encryption-types.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ModuleDefinition, ModuleRuleSet } from '../types/modules-types.js';

import { canonicalJsonStringify } from '@enbox/common';
import { KeyDerivationScheme } from '../utils/hd-key.js';
import { lexicographicalCompare } from './string.js';
import { ModuleAction } from '../types/modules-types.js';

/**
 * Result of parsing a cross-module reference in `alias:path` format.
 */
export type CrossModuleRef = {
  /** The alias key from the `uses` map. */
  alias: string;
  /** The module path within the referenced module. */
  modulePath: string;
};

/**
 * Canonical lookup identity of a module role assignment. Distinct role
 * records that regrant the same role in the same scope intentionally share it.
 */
export type RoleRecordIdentity = {
  contextIdPrefix: string | undefined;
  key: string;
  module: string;
  modulePath: string;
  recipient: string;
};

/**
 * Parses a string that may be a cross-module reference in `alias:path` format.
 * Returns `undefined` if the string is a local (non-cross-module) reference.
 *
 * Examples:
 * - `"threads:thread"` → `{ alias: "threads", modulePath: "thread" }`
 * - `"threads:thread/participant"` → `{ alias: "threads", modulePath: "thread/participant" }`
 * - `"thread/comment"` → `undefined` (local reference, no alias)
 */
export function parseCrossModuleRef(ref: string): CrossModuleRef | undefined {
  const colonIndex = ref.indexOf(':');
  if (colonIndex === -1) {
    return undefined;
  }

  const alias = ref.substring(0, colonIndex);
  const modulePath = ref.substring(colonIndex + 1);

  return { alias, modulePath };
}

/**
 * Returns `true` if the given string contains a `:` indicating a cross-module reference.
 */
export function isCrossModuleRef(ref: string): boolean {
  return ref.includes(':');
}

/**
 * Extracts the last segment of a modulePath — i.e. the type name.
 * e.g. `'thread/comment'` → `'comment'`, `'note'` → `'note'`.
 */
export function getTypeName(modulePath: string): string {
  return modulePath.split('/').at(-1)!;
}

/**
 * Computes the role-audience context id for a role path relative to a source record context id.
 * Root-level role audiences use the empty string; nested role audiences use the ancestor
 * context prefix at the same depth as the role parent.
 */
export function getRoleAudienceContextId(rolePath: string, contextId?: string): string | undefined {
  const roleParentDepth = rolePath.split('/').length - 1;
  if (roleParentDepth === 0) {
    return '';
  }

  if (contextId === undefined) {
    return undefined;
  }

  const contextSegments = contextId.split('/');
  if (contextSegments.length < roleParentDepth) {
    return undefined;
  }

  return contextSegments.slice(0, roleParentDepth).join('/');
}

/**
 * Computes the context prefix used when querying for role records. Root-level
 * role records are queried without a context prefix.
 */
export function getRoleContextPrefix(rolePath: string, contextId?: string): string | undefined {
  const roleAudienceContextId = getRoleAudienceContextId(rolePath, contextId);
  return roleAudienceContextId === '' ? undefined : roleAudienceContextId;
}

/**
 * Returns the canonical lookup identity of a module role assignment. The
 * supplied context may be either the role record context or a descendant
 * context; root-level roles intentionally have no context dimension, and
 * same-scope regrants intentionally resolve to the same identity.
 */
export function getRoleRecordIdentity(input: {
  contextId?: string;
  module: string;
  modulePath: string;
  recipient: string;
}): RoleRecordIdentity {
  const { module, modulePath, recipient } = input;
  const contextIdPrefix = getRoleContextPrefix(modulePath, input.contextId);
  return {
    contextIdPrefix,
    key: JSON.stringify([module, modulePath, recipient, contextIdPrefix]),
    module,
    modulePath,
    recipient,
  };
}

/**
 * Returns the canonical role identity described by a RecordsWrite, or
 * `undefined` when the required descriptor fields are absent.
 */
export function getRecordsWriteRoleIdentity(message: RecordsWriteMessage): RoleRecordIdentity | undefined {
  const { module, modulePath, recipient } = message.descriptor;
  if (module === undefined || modulePath === undefined || recipient === undefined) {
    return undefined;
  }

  return getRoleRecordIdentity({
    contextId: message.contextId,
    module,
    modulePath,
    recipient,
  });
}

/**
 * Removes runtime-injected encryption metadata before comparing authored
 * module policy. Returns a new value without mutating the definition.
 */
function stripModuleEncryptionMetadata(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => stripModuleEncryptionMetadata(item));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === '$encryption' || key === '$keyAgreement') {
      continue;
    }
    result[key] = stripModuleEncryptionMetadata(entry);
  }
  return result;
}

/** Whether two module definitions have the same authored policy. */
export function authoredModuleDefinitionsEqual(left: ModuleDefinition, right: ModuleDefinition): boolean {
  return canonicalJsonStringify(stripModuleEncryptionMetadata(left))
    === canonicalJsonStringify(stripModuleEncryptionMetadata(right));
}

/**
 * Gets the rule set at a given module path within a module definition's structure tree.
 * Returns `undefined` if the path does not exist.
 */
export function getRuleSetAtPath(modulePath: string, structure: { [key: string]: ModuleRuleSet }): ModuleRuleSet | undefined {
  const segments = modulePath.split('/');
  let current: ModuleRuleSet | undefined;
  let currentLevel: { [key: string]: ModuleRuleSet } = structure;

  for (const segment of segments) {
    if (!Object.hasOwn(currentLevel, segment)) {
      return undefined;
    }
    current = currentLevel[segment];
    currentLevel = current as { [key: string]: ModuleRuleSet };
  }

  return current;
}

/**
 * Walks every non-directive rule set in a module structure in pre-order,
 * visiting each node with its slash-joined module path. Recursion into a
 * node is skipped when its value is not a plain record, so malformed input
 * fails the caller's own validation rather than the walk itself.
 */
export function walkModuleRuleSets(
  structure: ModuleRuleSet,
  visit: (modulePath: string, ruleSet: ModuleRuleSet) => void,
): void {
  const walk = (ruleSet: ModuleRuleSet, parentPath: string): void => {
    for (const [name, child] of Object.entries(ruleSet)) {
      if (name.startsWith('$')) {
        continue;
      }
      const path = parentPath === '' ? name : `${parentPath}/${name}`;
      visit(path, child as ModuleRuleSet);
      if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
        walk(child as ModuleRuleSet, path);
      }
    }
  };
  walk(structure, '');
}

/**
 * Resolve local context roles in the order of the root's read action rules.
 * Only roles directly beneath the requested context qualify; ancestor and
 * cross-module roles are not resolved. An empty result means no roles qualify.
 *
 * This selection order does not change authorization or establish exclusivity
 * between assignments. The definition must already be validated.
 *
 * @param definition - The validated module definition.
 * @param contextPath - The canonical module path of a non-role record.
 * @returns A new array in authored `$actions` order.
 * @throws {TypeError} If the path is not canonical, does not exist, or names a role.
 */
export function resolveModuleContextRoles(definition: ModuleDefinition, contextPath: string): readonly string[] {
  if (contextPath.split('/').some(segment => segment === '' || segment.startsWith('$'))) {
    throw new TypeError(`Context path '${contextPath}' must be a canonical module path.`);
  }
  const context = getRuleSetAtPath(contextPath, definition.structure);
  if (context === undefined || context.$role === true) {
    throw new TypeError(`Context path '${contextPath}' must identify a non-role record.`);
  }

  const roles: string[] = [];
  for (const action of context.$actions ?? []) {
    const role = action.role;
    if (role !== undefined && !isCrossModuleRef(role) && action.can.includes(ModuleAction.Read)
      && role.split('/').slice(0, -1).join('/') === contextPath
      && getRuleSetAtPath(role, definition.structure)?.$role === true) {
      roles.push(role);
    }
  }
  return roles;
}

/** Resolve the non-role content scope governed by one nested module role. */
export function resolveModuleRoleContextScope(
  definition: ModuleDefinition,
  rolePath: string,
): {
  allowedPaths: ReadonlySet<string>;
  modulePath: string;
  readablePaths: [string, ...string[]];
} {
  if (getRuleSetAtPath(rolePath, definition.structure)?.$role !== true) {
    throw new TypeError(`Context role '${rolePath}' is not a module role path.`);
  }

  const modulePath = rolePath.split('/').slice(0, -1).join('/');
  if (modulePath === '') {
    throw new TypeError('Context roles must be nested below a context root.');
  }
  const allowedPaths: string[] = [];
  const readablePaths: string[] = [];
  walkModuleRuleSets(definition.structure as ModuleRuleSet, (path, child): void => {
    const contentPath = child.$role !== true &&
      (path === modulePath || path.startsWith(`${modulePath}/`));
    if (contentPath) {
      const actions = (child.$actions ?? []).filter(rule => rule.role === rolePath);
      if (actions.length > 0) {
        allowedPaths.push(path);
      }
      if (actions.some(rule => rule.can.includes(ModuleAction.Read))) {
        readablePaths.push(path);
      }
    }
  });
  allowedPaths.sort(lexicographicalCompare);
  readablePaths.sort(lexicographicalCompare);
  if (!readablePaths.includes(modulePath)) {
    throw new TypeError(`Context role '${rolePath}' must authorize reading its parent context '${modulePath}'.`);
  }

  return {
    allowedPaths  : new Set(allowedPaths),
    modulePath,
    readablePaths : readablePaths as [string, ...string[]],
  };
}

/**
 * Class containing Module related utility methods.
 */
export class Modules {
  /**
   * Derives public encryption keys and injects them in `$keyAgreement`.
   * NOTE: The original definition passed in is unmodified.
   *
   * `$ref` nodes (cross-module attachment points) are skipped during `$keyAgreement` injection
   * because their records belong to the referenced module, whose own encryption keys govern them.
   * Children of `$ref` nodes are still processed because they belong to the composing module.
   *
   * Accepts an EncryptionKeyDeriver that performs key derivation internally.
   * The private key never leaves the caller's boundary.
   */
  public static async deriveAndInjectPublicEncryptionKeys(
    moduleDefinition: ModuleDefinition,
    keyDeriver: EncryptionKeyDeriver,
  ): Promise<ModuleDefinition> {
    // clone before modify
    const clone = structuredClone(moduleDefinition);

    const basePath = [KeyDerivationScheme.ModulePath, moduleDefinition.module];
    clone.$keyAgreement = {
      publicKeyJwk: await keyDeriver.derivePublicKey(basePath),
    };

    async function injectKeys(
      ruleSet: ModuleRuleSet, parentPath: string[],
    ): Promise<void> {
      for (const key in ruleSet) {
        if (!key.startsWith('$')) {
          const currentPath = [...parentPath, key];
          const childRuleSet = ruleSet[key] as ModuleRuleSet;

          // Skip $ref nodes — they are governed by the referenced module's encryption keys.
          // Still recurse into children, which belong to the composing module.
          if (childRuleSet.$ref !== undefined) {
            await injectKeys(childRuleSet, currentPath);
            continue;
          }

          const publicKeyJwk = await keyDeriver.derivePublicKey(currentPath);
          childRuleSet.$keyAgreement = { publicKeyJwk };
          await injectKeys(childRuleSet, currentPath);
        }
      }
    }

    await injectKeys(clone.structure as ModuleRuleSet, basePath);
    return clone;
  }
}
