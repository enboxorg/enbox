import type { GenericMessage } from '../types/message-types.js';
import type { KeyValues } from '../types/query-types.js';

import { EncryptionProtocol } from '../protocols/encryption.js';
import { PermissionsProtocol } from '../protocols/permissions.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import {
  EncryptionControlRecordType,
  getEncryptionControlRecordType,
  isEncryptionControlPath,
} from '../core/constants.js';

const POSITION_PAD_WIDTH = 20;

type ReplicationMessageDescriptor = GenericMessage['descriptor'] & {
  protocol?: string;
  protocolPath?: string;
  tags?: Record<string, unknown>;
};

export type ReplicationIndexProjection = {
  fingerprintScopes: string[];
  indexes: KeyValues;
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

  public static audienceControlDomain(protocolUri: string): string {
    return `ctl:${protocolUri}:audience`;
  }

  public static deliveryControlDomain(protocolUri: string): string {
    return `ctl:${protocolUri}:delivery`;
  }

  public static async deriveStreamId(tenant: string): Promise<string> {
    const bytes = new TextEncoder().encode(tenant);
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray.slice(0, 8), (b: number) => b.toString(16).padStart(2, '0')).join('');
  }

  public static projectIndexes(message: GenericMessage, indexes: KeyValues): ReplicationIndexProjection {
    const controlScopes = Replication.computeControlFingerprintScopes(message, indexes);
    const fingerprintScopes = controlScopes ?? Replication.computeStandardFingerprintScopes(message, indexes);

    return {
      fingerprintScopes,
      indexes,
    };
  }

  public static assertFingerprintScopesMatch(
    persistedScopes: string[],
    expectedScopes: string[],
    messageCid: string,
  ): void {
    if (!Replication.scopeSetsMatch(persistedScopes, expectedScopes)) {
      Replication.throwFingerprintScopeMutation(messageCid);
    }
  }

  private static computeStandardFingerprintScopes(message: GenericMessage, indexes: KeyValues): string[] {
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

  private static computeControlFingerprintScopes(
    message: GenericMessage,
    indexes: KeyValues,
  ): string[] | undefined {
    const descriptor: ReplicationMessageDescriptor = message.descriptor;
    if (
      descriptor.interface !== DwnInterfaceName.Records ||
      descriptor.method !== DwnMethodName.Write ||
      typeof descriptor.protocolPath !== 'string' ||
      !isEncryptionControlPath(descriptor.protocolPath)
    ) {
      return undefined;
    }

    const protocol = Replication.getProtocolIndex(indexes, descriptor);
    if (protocol === undefined) {
      return undefined;
    }

    const controlClass = getEncryptionControlRecordType(descriptor.protocolPath);
    if (controlClass === EncryptionControlRecordType.Audience) {
      return [Replication.globalDomain, Replication.audienceControlDomain(protocol)];
    }

    return [Replication.globalDomain, Replication.deliveryControlDomain(protocol)];
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

  private static isCoreProtocolUri(protocolUri: string): boolean {
    return protocolUri === PermissionsProtocol.uri || protocolUri === EncryptionProtocol.uri;
  }

  private static getProtocolIndex(indexes: KeyValues, descriptor: ReplicationMessageDescriptor): string | undefined {
    const descriptorValue = descriptor.protocol;
    const value = indexes.protocol ?? descriptorValue;
    return typeof value === 'string' ? value : undefined;
  }

  public static async hashMessageCid(messageCid: string): Promise<Uint8Array> {
    const bytes = new TextEncoder().encode(messageCid);
    return Replication.sha256(bytes);
  }

  private static async sha256(bytes: Uint8Array): Promise<Uint8Array> {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    const hashBuffer = await crypto.subtle.digest('SHA-256', copy);
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
