import type { KeyValues } from '../types/query-types.js';

import { PermissionsProtocol } from '../protocols/permissions.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

const POSITION_PAD_WIDTH = 20;

/**
 * Shared helpers for the replication log substrate.
 */
export class Replication {
  public static readonly globalDomain = '';

  public static protocolDomain(protocolUri: string): string {
    return `protocol:${protocolUri}`;
  }

  public static permissionDomain(protocolUri: string): string {
    return `perm:${protocolUri}`;
  }

  public static async deriveStreamId(tenant: string): Promise<string> {
    const bytes = new TextEncoder().encode(tenant);
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray.slice(0, 8), (b: number) => b.toString(16).padStart(2, '0')).join('');
  }

  public static computeFingerprintScopes(indexes: KeyValues): string[] {
    const scopes = [Replication.globalDomain];

    const protocol = indexes.protocol;
    if (typeof protocol === 'string') {
      scopes.push(Replication.protocolDomain(protocol));

      if (protocol === PermissionsProtocol.uri) {
        const taggedProtocol = indexes['tag.protocol'];
        if (typeof taggedProtocol === 'string') {
          scopes.push(Replication.permissionDomain(taggedProtocol));
        }
      }
    }

    return scopes;
  }

  public static assertFingerprintScopesUntouched(persistedScopes: string[], newIndexes: KeyValues, messageCid: string): void {
    const protocol = newIndexes.protocol;
    const expectedProtocolDomain = typeof protocol === 'string' ? Replication.protocolDomain(protocol) : undefined;
    const persistedProtocolDomain = persistedScopes.find((scope) => scope.startsWith('protocol:'));

    if (expectedProtocolDomain !== persistedProtocolDomain) {
      throw new DwnError(
        DwnErrorCode.MessageStoreFingerprintScopeMutation,
        `index replacement for message ${messageCid} would change its persisted fingerprint scopes`
      );
    }

    const taggedProtocol = newIndexes['tag.protocol'];
    const expectedPermissionDomain =
      protocol === PermissionsProtocol.uri && typeof taggedProtocol === 'string'
        ? Replication.permissionDomain(taggedProtocol)
        : undefined;
    const persistedPermissionDomain = persistedScopes.find((scope) => scope.startsWith('perm:'));

    if (expectedPermissionDomain !== undefined && expectedPermissionDomain !== persistedPermissionDomain) {
      throw new DwnError(
        DwnErrorCode.MessageStoreFingerprintScopeMutation,
        `index replacement for message ${messageCid} would change its persisted fingerprint scopes`
      );
    }
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
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
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

  public static decodePositionKey(key: string): bigint {
    return BigInt(key);
  }
}
