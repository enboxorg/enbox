import type { EncryptionKeyDeriver } from '../types/encryption-types.js';
import type { ModuleDefinition, ModuleRuleSet } from '../types/modules-types.js';

import { canonicalJsonStringify } from '@enbox/common';
import { KeyDerivationScheme } from '../utils/hd-key.js';

/**
 * Result of parsing a cross-module reference in `alias:path` format.
 */
export type CrossModuleRef = {
  /** The alias key from the `uses` map. */
  alias: string;
  /** The module path within the referenced module. */
  modulePath: string;
};

export type { RoleRecordIdentity } from '../core/module-role-records.js';
export { getRoleAudienceContextId, getRoleContextPrefix, getRoleRecordIdentity, getRecordsWriteRoleIdentity } from '../core/module-role-records.js';

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
 * Class containing Module related utility methods.
 */
export class Modules {
  /** Roles need sealing keys even when their module owns no encrypted application types. */
  public static requiresKeyAgreement(definition: ModuleDefinition): boolean {
    if (Object.values(definition.types).some(type => type.encryptionRequired === true)) {
      return true;
    }
    let hasRole = false;
    walkModuleRuleSets(definition.structure as ModuleRuleSet, (_path, ruleSet): void => {
      if (ruleSet.$role === true) {
        hasRole = true;
      }
    });
    return hasRole;
  }

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

    async function injectKeys(ruleSet: ModuleRuleSet, parentPath: string[]): Promise<void> {
      for (const key in ruleSet) {
        if (key.startsWith('$')) {
          continue;
        }
        const currentPath = [...parentPath, key];
        const childRuleSet = ruleSet[key] as ModuleRuleSet;
        // Reference nodes use their provider's key, while their children remain local.
        if (childRuleSet.$ref === undefined) {
          const publicKeyJwk = await keyDeriver.derivePublicKey(currentPath); // NOSONAR: S9382 — bound concurrent KMS operations.
          childRuleSet.$keyAgreement = { publicKeyJwk };
        }
        await injectKeys(childRuleSet, currentPath); // NOSONAR: S9382 — finish each subtree before scheduling further derivations.
      }
    }

    await injectKeys(clone.structure as ModuleRuleSet, basePath);
    return clone;
  }
}
