import type { GenericMessage } from '../types/message-types.js';
import type { KeyValues } from '../types/query-types.js';
import type { ReplicationFeedReader } from '../types/subscriptions.js';

import { EncryptionProtocol } from '../protocols/encryption.js';
import { PermissionsProtocol } from '../protocols/permissions.js';
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

  public static protocolDomain(protocolUri: string): string {
    return `protocol:${protocolUri}`;
  }

  public static permissionDomain(protocolUri: string): string {
    return `perm:${protocolUri}`;
  }

  public static encryptionDomain(protocolUri: string): string {
    return `enc:${protocolUri}`;
  }

  public static taggedCoreProtocolDomains(protocolUri: string, protocolsInScope: ReadonlySet<string> = new Set()): string[] {
    if (Replication.isCoreProtocolUri(protocolUri)) {
      return [];
    }

    const domains: string[] = [];
    if (!protocolsInScope.has(PermissionsProtocol.uri)) {
      domains.push(Replication.permissionDomain(protocolUri));
    }
    if (!protocolsInScope.has(EncryptionProtocol.uri)) {
      domains.push(Replication.encryptionDomain(protocolUri));
    }
    return domains;
  }

  /**
   * Narrows a message store to its replication feed surface when it implements
   * one. Returns `undefined` for stores without replication feed support.
   */
  public static asFeedReader(candidate: unknown): ReplicationFeedReader | undefined {
    const partial = candidate as Partial<ReplicationFeedReader>;
    if (
      typeof partial.logRead === 'function' &&
      typeof partial.logBounds === 'function' &&
      typeof partial.fingerprint === 'function' &&
      typeof partial.epoch === 'function'
    ) {
      return partial as ReplicationFeedReader;
    }
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
    const protocol = indexes.protocol;
    if (typeof protocol === 'string') {
      scopes.push(Replication.protocolDomain(protocol));

      const indexedTaggedProtocol = indexes['tag.protocol'];
      const taggedProtocol = indexedTaggedProtocol ?? descriptor.tags?.protocol;
      if (typeof taggedProtocol === 'string') {
        if (protocol === PermissionsProtocol.uri) {
          scopes.push(Replication.permissionDomain(taggedProtocol));
        } else if (protocol === EncryptionProtocol.uri) {
          scopes.push(Replication.encryptionDomain(taggedProtocol));
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

  /** Whether a protocol URI is one of the core protocols (permissions, encryption). */
  public static isCoreProtocolUri(protocolUri: string): boolean {
    return protocolUri === PermissionsProtocol.uri || protocolUri === EncryptionProtocol.uri;
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
