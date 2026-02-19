import type { DerivedPrivateJwk } from '../utils/hd-key.js';
import type { EncryptionKeyDeriver } from '../types/encryption-types.js';
import type { PrivateKeyJwk } from '../types/jose-types.js';
import type { ProtocolDefinition, ProtocolRuleSet } from '../types/protocols-types.js';

import { Secp256k1 } from './secp256k1.js';
import { HdKey, KeyDerivationScheme } from '../utils/hd-key.js';

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
 * Gets the rule set at a given protocol path within a protocol definition's structure tree.
 * Returns `undefined` if the path does not exist.
 */
export function getRuleSetAtPath(protocolPath: string, structure: { [key: string]: ProtocolRuleSet }): ProtocolRuleSet | undefined {
  const segments = protocolPath.split('/');
  let current: ProtocolRuleSet | undefined;
  let currentLevel: { [key: string]: ProtocolRuleSet } = structure;

  for (const segment of segments) {
    current = currentLevel[segment];
    if (current === undefined) {
      return undefined;
    }
    currentLevel = current as { [key: string]: ProtocolRuleSet };
  }

  return current;
}

/**
 * Class containing Protocol related utility methods.
 */
export class Protocols {
  /**
   * Derives public encryptions keys and inject it in the `$encryption` property for each protocol path segment of the given Protocol definition,
   * then returns the final encryption-enabled protocol definition.
   * NOTE: The original definition passed in is unmodified.
   *
   * Overload 1 (callback-based): Accepts an EncryptionKeyDeriver that performs
   * key derivation internally. The private key never leaves the caller's boundary.
   */
  public static async deriveAndInjectPublicEncryptionKeys(
    protocolDefinition: ProtocolDefinition,
    keyDeriver: EncryptionKeyDeriver,
  ): Promise<ProtocolDefinition>;

  /**
   * Overload 2 (raw-key, existing): Takes rootKeyId and raw PrivateKeyJwk directly.
   * Preserved for backward compatibility with tests and non-KMS callers.
   */
  public static async deriveAndInjectPublicEncryptionKeys(
    protocolDefinition: ProtocolDefinition,
    rootKeyId: string,
    privateJwk: PrivateKeyJwk,
  ): Promise<ProtocolDefinition>;

  // Implementation dispatches based on argument type
  public static async deriveAndInjectPublicEncryptionKeys(
    protocolDefinition: ProtocolDefinition,
    rootKeyIdOrKeyDeriver: string | EncryptionKeyDeriver,
    privateJwk?: PrivateKeyJwk,
  ): Promise<ProtocolDefinition> {
    // clone before modify
    const clone = JSON.parse(JSON.stringify(protocolDefinition)) as ProtocolDefinition;

    if (typeof rootKeyIdOrKeyDeriver !== 'string') {
      // Callback-based path
      const keyDeriver = rootKeyIdOrKeyDeriver;
      const basePath = [KeyDerivationScheme.ProtocolPath, protocolDefinition.protocol];

      async function injectKeysViaCallback(
        ruleSet: ProtocolRuleSet, parentPath: string[],
      ): Promise<void> {
        for (const key in ruleSet) {
          if (!key.startsWith('$')) {
            const currentPath = [...parentPath, key];
            const publicKeyJwk = await keyDeriver.derivePublicKey(currentPath);
            ruleSet[key].$encryption = {
              rootKeyId: keyDeriver.rootKeyId,
              publicKeyJwk,
            };
            await injectKeysViaCallback(ruleSet[key], currentPath);
          }
        }
      }

      await injectKeysViaCallback(clone.structure, basePath);
      return clone;
    }

    // Raw-key path (existing logic, unchanged)
    const rootKeyId = rootKeyIdOrKeyDeriver;

    // a function that recursively creates and adds `$encryption` property to every rule set
    async function addEncryptionProperty(ruleSet: ProtocolRuleSet, parentKey: DerivedPrivateJwk): Promise<void> {
      for (const key in ruleSet) {
        // if we encounter a nested rule set (a property name that doesn't begin with '$'), recursively inject the `$encryption` property
        if (!key.startsWith('$')) {
          const derivedPrivateKey = await HdKey.derivePrivateKey(parentKey, [key]);
          const publicKeyJwk = await Secp256k1.getPublicJwk(derivedPrivateKey.derivedPrivateKey);

          ruleSet[key].$encryption = { rootKeyId, publicKeyJwk };
          await addEncryptionProperty(ruleSet[key], derivedPrivateKey);
        }
      }
    }

    // inject encryption property starting from each root level record type
    const rootKey: DerivedPrivateJwk = {
      derivationScheme  : KeyDerivationScheme.ProtocolPath,
      derivedPrivateKey : privateJwk!,
      rootKeyId
    };
    const protocolLevelDerivedKey = await HdKey.derivePrivateKey(rootKey, [KeyDerivationScheme.ProtocolPath, protocolDefinition.protocol]);
    await addEncryptionProperty(clone.structure, protocolLevelDerivedKey);

    return clone;
  }
}