import type { GenericMessage } from '../types/message-types.js';
import type { KeyValues } from '../types/query-types.js';

import { EncryptionModule } from '../modules/encryption.js';
import { PermissionsModule } from '../modules/permissions.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

const POSITION_PAD_WIDTH = 20;

type ReplicationMessageDescriptor = GenericMessage['descriptor'] & {
  tags?: Record<string, unknown>;
};

/**
 * Shared helpers for the replication log substrate.
 */
export class Replication {
  public static readonly globalDomain = '';

  public static moduleDomain(moduleUri: string): string {
    return `module:${moduleUri}`;
  }

  public static permissionDomain(moduleUri: string): string {
    return `perm:${moduleUri}`;
  }

  public static encryptionDomain(moduleUri: string): string {
    return `enc:${moduleUri}`;
  }

  public static taggedCoreModuleDomains(moduleUri: string, modulesInScope: ReadonlySet<string> = new Set()): string[] {
    if (Replication.isCoreModuleUri(moduleUri)) {
      return [];
    }

    const domains: string[] = [];
    if (!modulesInScope.has(PermissionsModule.uri)) {
      domains.push(Replication.permissionDomain(moduleUri));
    }
    if (!modulesInScope.has(EncryptionModule.uri)) {
      domains.push(Replication.encryptionDomain(moduleUri));
    }
    return domains;
  }

  public static async deriveStreamId(tenant: string): Promise<string> {
    const bytes = new TextEncoder().encode(tenant);
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray.slice(0, 8), (b: number) => b.toString(16).padStart(2, '0')).join('');
  }

  public static computeFingerprintScopes(message: GenericMessage, indexes: KeyValues): string[] {
    const scopes = [Replication.globalDomain];

    const descriptor: ReplicationMessageDescriptor = message.descriptor;
    const module = indexes.module;
    if (typeof module === 'string') {
      scopes.push(Replication.moduleDomain(module));

      const indexedTaggedModule = indexes['tag.module'];
      const taggedModule = indexedTaggedModule ?? descriptor.tags?.module;
      if (typeof taggedModule === 'string') {
        if (module === PermissionsModule.uri) {
          scopes.push(Replication.permissionDomain(taggedModule));
        } else if (module === EncryptionModule.uri) {
          scopes.push(Replication.encryptionDomain(taggedModule));
        }
      }
    }

    return scopes;
  }

  public static assertFingerprintScopesUntouched(
    persistedScopes: string[],
    message: GenericMessage,
    messageCid: string,
    newIndexes: KeyValues,
  ): void {
    const expectedScopes = Replication.computeFingerprintScopes(message, newIndexes);
    if (!Replication.scopeSetsMatch(persistedScopes, expectedScopes)) {
      Replication.throwFingerprintScopeMutation(messageCid);
    }
  }

  private static scopeSetsMatch(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
      return false;
    }

    return right.every((scope) => left.includes(scope));
  }

  private static throwFingerprintScopeMutation(messageCid: string): never {
    throw new DwnError(
      DwnErrorCode.MessageStoreFingerprintScopeMutation,
      `index replacement for message ${messageCid} would change its persisted fingerprint scopes`
    );
  }

  /** Whether a module URI is one of the core modules (permissions, encryption). */
  public static isCoreModuleUri(moduleUri: string): boolean {
    return moduleUri === PermissionsModule.uri || moduleUri === EncryptionModule.uri;
  }

  public static async hashMessageCid(messageCid: string): Promise<Uint8Array> {
    const bytes = new TextEncoder().encode(messageCid);
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(hashBuffer);
  }

  public static emptyFingerprint(): Uint8Array {
    return new Uint8Array(32);
  }

  public static xorFingerprint(fingerprint: Uint8Array, contribution: Uint8Array): Uint8Array {
    const result = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      result[i] = fingerprint[i] ^ contribution[i];
    }
    return result;
  }

  public static fingerprintToHex(fingerprint: Uint8Array): string {
    return Array.from(fingerprint, (b: number) => b.toString(16).padStart(2, '0')).join('');
  }

  public static hexToFingerprint(hex: string): Uint8Array {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  public static encodePositionKey(position: bigint): string {
    const decimal = position.toString();
    if (position < 0n || decimal.length > POSITION_PAD_WIDTH) {
      throw new DwnError(
        DwnErrorCode.MessageStoreReplicationPositionOverflow,
        `log position ${decimal} cannot be encoded within ${POSITION_PAD_WIDTH} digits`
      );
    }

    return decimal.padStart(POSITION_PAD_WIDTH, '0');
  }
}
