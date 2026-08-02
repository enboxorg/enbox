import type { EncryptionKeyDeriver } from '../types/encryption-types.js';
import type { ProtocolDefinition, ProtocolRuleSet } from '../types/protocols-types.js';

import { KeyDerivationScheme } from '../utils/hd-key.js';
import { ProtocolAction } from '../types/protocols-types.js';

/**
 * Result of parsing a cross-protocol reference in `alias:path` format.
 */
export type CrossProtocolRef = {
  /** The alias key from the `uses` map. */
  alias: string;
  /** The protocol path within the referenced protocol. */
  protocolPath: string;
};

/**
 * Parses a string that may be a cross-protocol reference in `alias:path` format.
 * Returns `undefined` if the string is a local (non-cross-protocol) reference.
 *
 * Examples:
 * - `"threads:thread"` → `{ alias: "threads", protocolPath: "thread" }`
 * - `"threads:thread/participant"` → `{ alias: "threads", protocolPath: "thread/participant" }`
 * - `"thread/comment"` → `undefined` (local reference, no alias)
 */
export function parseCrossProtocolRef(ref: string): CrossProtocolRef | undefined {
  const colonIndex = ref.indexOf(':');
  if (colonIndex === -1) {
    return undefined;
  }

  const alias = ref.substring(0, colonIndex);
  const protocolPath = ref.substring(colonIndex + 1);

  return { alias, protocolPath };
}

/**
 * Returns `true` if the given string contains a `:` indicating a cross-protocol reference.
 */
export function isCrossProtocolRef(ref: string): boolean {
  return ref.includes(':');
}

/**
 * Extracts the last segment of a protocolPath — i.e. the type name.
 * e.g. `'thread/comment'` → `'comment'`, `'note'` → `'note'`.
 */
export function getTypeName(protocolPath: string): string {
  return protocolPath.split('/').at(-1)!;
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
 * Gets the rule set at a given protocol path within a protocol definition's structure tree.
 * Returns `undefined` if the path does not exist.
 */
export function getRuleSetAtPath(protocolPath: string, structure: { [key: string]: ProtocolRuleSet }): ProtocolRuleSet | undefined {
  const segments = protocolPath.split('/');
  let current: ProtocolRuleSet | undefined;
  let currentLevel: { [key: string]: ProtocolRuleSet } = structure;

  for (const segment of segments) {
    if (!Object.hasOwn(currentLevel, segment)) {
      return undefined;
    }
    current = currentLevel[segment];
    currentLevel = current as { [key: string]: ProtocolRuleSet };
  }

  return current;
}

/** Resolve the non-role content scope governed by one nested protocol role. */
export function resolveProtocolRoleContextScope(
  definition: ProtocolDefinition,
  rolePath: string,
): {
  allowedPaths: ReadonlySet<string>;
  protocolPath: string;
  readablePaths: [string, ...string[]];
} {
  if (getRuleSetAtPath(rolePath, definition.structure)?.$role !== true) {
    throw new TypeError(`Context role '${rolePath}' is not a protocol role path.`);
  }

  const protocolPath = rolePath.split('/').slice(0, -1).join('/');
  if (protocolPath === '') {
    throw new TypeError('Context roles must be nested below a context root.');
  }
  const allowedPaths: string[] = [];
  const readablePaths: string[] = [];
  const visit = (ruleSet: ProtocolRuleSet, parentPath: string): void => {
    for (const [name, value] of Object.entries(ruleSet)) {
      if (name.startsWith('$')) {continue;}
      const path = parentPath === '' ? name : `${parentPath}/${name}`;
      const child = value as ProtocolRuleSet;
      const contentPath = child.$role !== true &&
        (path === protocolPath || path.startsWith(`${protocolPath}/`));
      if (contentPath) {
        const actions = (child.$actions ?? []).filter(rule => rule.role === rolePath);
        if (actions.length > 0) {
          allowedPaths.push(path);
        }
        if (actions.some(rule => rule.can.includes(ProtocolAction.Read))) {
          readablePaths.push(path);
        }
      }
      visit(child, path);
    }
  };
  visit(definition.structure as ProtocolRuleSet, '');
  allowedPaths.sort();
  readablePaths.sort();
  if (!readablePaths.includes(protocolPath)) {
    throw new TypeError(`Context role '${rolePath}' must authorize reading its parent context '${protocolPath}'.`);
  }

  return {
    allowedPaths  : new Set(allowedPaths),
    protocolPath,
    readablePaths : readablePaths as [string, ...string[]],
  };
}

/**
 * Class containing Protocol related utility methods.
 */
export class Protocols {
  /**
   * Derives public encryption keys and injects them in `$keyAgreement`.
   * NOTE: The original definition passed in is unmodified.
   *
   * `$ref` nodes (cross-protocol attachment points) are skipped during `$keyAgreement` injection
   * because their records belong to the referenced protocol, whose own encryption keys govern them.
   * Children of `$ref` nodes are still processed because they belong to the composing protocol.
   *
   * Accepts an EncryptionKeyDeriver that performs key derivation internally.
   * The private key never leaves the caller's boundary.
   */
  public static async deriveAndInjectPublicEncryptionKeys(
    protocolDefinition: ProtocolDefinition,
    keyDeriver: EncryptionKeyDeriver,
  ): Promise<ProtocolDefinition> {
    // clone before modify
    const clone = structuredClone(protocolDefinition);

    const basePath = [KeyDerivationScheme.ProtocolPath, protocolDefinition.protocol];
    clone.$keyAgreement = {
      publicKeyJwk: await keyDeriver.derivePublicKey(basePath),
    };

    async function injectKeys(
      ruleSet: ProtocolRuleSet, parentPath: string[],
    ): Promise<void> {
      for (const key in ruleSet) {
        if (!key.startsWith('$')) {
          const currentPath = [...parentPath, key];
          const childRuleSet = ruleSet[key] as ProtocolRuleSet;

          // Skip $ref nodes — they are governed by the referenced protocol's encryption keys.
          // Still recurse into children, which belong to the composing protocol.
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

    await injectKeys(clone.structure as ProtocolRuleSet, basePath);
    return clone;
  }
}
