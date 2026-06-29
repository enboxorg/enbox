import type { DerivedPrivateJwk } from '../utils/hd-key.js';
import type { EncryptionKeyDeriver } from '../types/encryption-types.js';
import type { PrivateKeyJwk, PublicKeyJwk } from '../types/jose-types.js';
import type { ProtocolDefinition, ProtocolRuleSet } from '../types/protocols-types.js';

import { X25519 } from '@enbox/crypto';
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
 * Extracts the last segment of a protocolPath — i.e. the type name.
 * e.g. `'thread/comment'` → `'comment'`, `'note'` → `'note'`.
 */
export function getTypeName(protocolPath: string): string {
  return protocolPath.split('/').slice(-1)[0];
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
      clone.$keyAgreement = {
        publicKeyJwk: await keyDeriver.derivePublicKey(basePath),
      };

      async function injectKeysViaCallback(
        ruleSet: ProtocolRuleSet, parentPath: string[],
      ): Promise<void> {
        for (const key in ruleSet) {
          if (!key.startsWith('$')) {
            const currentPath = [...parentPath, key];
            const childRuleSet = ruleSet[key] as ProtocolRuleSet;

            // Skip $ref nodes — they are governed by the referenced protocol's encryption keys.
            // Still recurse into children, which belong to the composing protocol.
            if (childRuleSet.$ref !== undefined) {
              await injectKeysViaCallback(childRuleSet, currentPath);
              continue;
            }

            const publicKeyJwk = await keyDeriver.derivePublicKey(currentPath);
            childRuleSet.$keyAgreement = { publicKeyJwk };
            await injectKeysViaCallback(childRuleSet, currentPath);
          }
        }
      }

      await injectKeysViaCallback(clone.structure as ProtocolRuleSet, basePath);
      return clone;
    }

    // Raw-key path
    const rootKeyId = rootKeyIdOrKeyDeriver;

    // a function that recursively creates and adds `$keyAgreement` property to every rule set
    async function addEncryptionProperty(ruleSet: ProtocolRuleSet, parentKey: DerivedPrivateJwk): Promise<void> {
      for (const key in ruleSet) {
        // if we encounter a nested rule set (a property name that doesn't begin with '$'), recursively inject the `$keyAgreement` property
        if (!key.startsWith('$')) {
          const derivedPrivateKey = await HdKey.derivePrivateKey(parentKey, [key]);
          const childRuleSet = ruleSet[key] as ProtocolRuleSet;

          // Skip $ref nodes — they are governed by the referenced protocol's encryption keys.
          // Still recurse into children, which belong to the composing protocol.
          if (childRuleSet.$ref !== undefined) {
            await addEncryptionProperty(childRuleSet, derivedPrivateKey);
            continue;
          }

          const publicKeyJwk = await X25519.getPublicKey({ key: derivedPrivateKey.derivedPrivateKey }) as PublicKeyJwk;

          childRuleSet.$keyAgreement = { publicKeyJwk };
          await addEncryptionProperty(childRuleSet, derivedPrivateKey);
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
    clone.$keyAgreement = {
      publicKeyJwk: await X25519.getPublicKey({ key: protocolLevelDerivedKey.derivedPrivateKey }) as PublicKeyJwk,
    };
    await addEncryptionProperty(clone.structure as ProtocolRuleSet, protocolLevelDerivedKey);

    return clone;
  }
}
