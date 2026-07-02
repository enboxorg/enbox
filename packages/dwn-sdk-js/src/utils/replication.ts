import type { GenericMessage } from '../types/message-types.js';
import type { KeyValues } from '../types/query-types.js';

import { Encoder } from './encoder.js';
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
  recipient?: string;
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
  public static readonly controlClassIndex = 'controlClass';
  public static readonly recipientHashIndex = 'recipientHash';
  public static readonly roleAudienceHashIndex = 'roleAudienceHash';

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

  public static audienceControlRoleDomain(protocolUri: string, roleAudienceHash: string): string {
    return `${Replication.audienceControlDomain(protocolUri)}:${roleAudienceHash}`;
  }

  public static deliveryControlDomain(protocolUri: string): string {
    return `ctl:${protocolUri}:delivery`;
  }

  public static deliveryControlRoleDomain(protocolUri: string, roleAudienceHash: string): string {
    return `${Replication.deliveryControlDomain(protocolUri)}:${roleAudienceHash}`;
  }

  public static deliveryControlRecipientDomain(protocolUri: string, recipientHash: string): string {
    return `${Replication.deliveryControlDomain(protocolUri)}:rcpt:${recipientHash}`;
  }

  public static async deriveStreamId(tenant: string): Promise<string> {
    const bytes = new TextEncoder().encode(tenant);
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray.slice(0, 8), (b: number) => b.toString(16).padStart(2, '0')).join('');
  }

  public static async projectIndexes(message: GenericMessage, indexes: KeyValues): Promise<ReplicationIndexProjection> {
    const controlRecord = await Replication.classifyControlRecord(message, indexes);
    const baseIndexes = Replication.stripControlIndexes(indexes);
    if (controlRecord !== undefined) {
      return {
        fingerprintScopes : controlRecord.fingerprintScopes,
        indexes           : {
          ...baseIndexes,
          [Replication.controlClassIndex]     : controlRecord.controlClass,
          [Replication.roleAudienceHashIndex] : controlRecord.roleAudienceHash,
          ...(controlRecord.recipientHash !== undefined && { [Replication.recipientHashIndex]: controlRecord.recipientHash }),
        },
      };
    }

    return {
      fingerprintScopes : Replication.computeStandardFingerprintScopes(message, baseIndexes),
      indexes           : baseIndexes,
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

  public static async roleAudienceHash(input: {
    contextId: string;
    protocol: string;
    rolePath: string;
  }): Promise<string> {
    const canonicalTuple = JSON.stringify([input.protocol, input.rolePath, input.contextId]);
    const digest = await Replication.sha256(Encoder.stringToBytes(canonicalTuple));
    return Encoder.bytesToBase64Url(digest);
  }

  public static async recipientHash(recipient: string): Promise<string> {
    const digest = await Replication.sha256(Encoder.stringToBytes(recipient));
    return Encoder.bytesToBase64Url(digest);
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

  private static async classifyControlRecord(
    message: GenericMessage,
    indexes: KeyValues,
  ): Promise<{
    controlClass: EncryptionControlRecordType;
    fingerprintScopes: string[];
    recipientHash?: string;
    roleAudienceHash: string;
  } | undefined> {
    const descriptor: ReplicationMessageDescriptor = message.descriptor;
    if (
      descriptor.interface !== DwnInterfaceName.Records ||
      descriptor.method !== DwnMethodName.Write ||
      typeof descriptor.protocolPath !== 'string' ||
      !isEncryptionControlPath(descriptor.protocolPath)
    ) {
      return undefined;
    }

    const protocol = Replication.getStringIndex(indexes, 'protocol', descriptor);
    const rolePath = Replication.getStringTag(message, indexes, 'rolePath');
    const contextId = Replication.getStringTag(message, indexes, 'contextId');
    if (protocol === undefined || rolePath === undefined || contextId === undefined) {
      return undefined;
    }

    const roleAudienceHash = await Replication.roleAudienceHash({ contextId, protocol, rolePath });
    const controlClass = getEncryptionControlRecordType(descriptor.protocolPath);

    if (controlClass === EncryptionControlRecordType.Audience) {
      return {
        controlClass,
        roleAudienceHash,
        fingerprintScopes: [
          Replication.globalDomain,
          Replication.audienceControlDomain(protocol),
          Replication.audienceControlRoleDomain(protocol, roleAudienceHash),
        ],
      };
    }

    const recipient = Replication.getStringIndex(indexes, 'recipient', descriptor);
    if (recipient === undefined) {
      return undefined;
    }

    const recipientHash = await Replication.recipientHash(recipient);
    return {
      controlClass,
      recipientHash,
      roleAudienceHash,
      fingerprintScopes: [
        Replication.globalDomain,
        Replication.deliveryControlDomain(protocol),
        Replication.deliveryControlRoleDomain(protocol, roleAudienceHash),
        Replication.deliveryControlRecipientDomain(protocol, recipientHash),
      ],
    };
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

  private static stripControlIndexes(indexes: KeyValues): KeyValues {
    const {
      [Replication.controlClassIndex]     : _controlClass,
      [Replication.recipientHashIndex]    : _recipientHash,
      [Replication.roleAudienceHashIndex] : _roleAudienceHash,
      ...cleanIndexes
    } = indexes;
    return cleanIndexes;
  }

  private static getStringIndex(indexes: KeyValues, key: 'protocol' | 'recipient', descriptor: ReplicationMessageDescriptor): string | undefined {
    const descriptorValue = key === 'protocol' ? descriptor.protocol : descriptor.recipient;
    const value = indexes[key] ?? descriptorValue;
    return typeof value === 'string' ? value : undefined;
  }

  private static getStringTag(message: GenericMessage, indexes: KeyValues, key: string): string | undefined {
    const indexedValue = indexes[`tag.${key}`];
    const descriptor: ReplicationMessageDescriptor = message.descriptor;
    const descriptorValue = descriptor.tags?.[key];
    const value = indexedValue ?? descriptorValue;
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
