import type { DataEncodedRecordsWriteMessage } from '../types/records-types.js';
import type { ConnectSessionMetadata, PermissionConditions, PermissionGrantData, PermissionScope } from '../types/permission-types.js';

import { Encoder } from '../utils/encoder.js';
import { Message } from '../core/message.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';


/**
 * A class representing a Permission Grant for a more convenient abstraction.
 */
export class PermissionGrant {

  /**
   * The ID of the permission grant, which is the record ID DWN message.
   */
  public readonly id: string;

  /**
   * The grantor of the permission.
   */
  public readonly grantor: string;

  /**
   * The grantee of the permission.
   */
  public readonly grantee: string;

  /**
   * The date at which the grant was given.
   */
  public readonly dateGranted: string;

  /**
   * Optional string that communicates what the grant would be used for
   */
  public readonly description?: string;

  /**
   * Optional CID of a permission request. This is optional because grants may be given without being officially requested
   */
  public readonly requestId?: string;

  /**
   * Timestamp at which this grant will no longer be active.
   */
  public readonly dateExpires: string;

  /**
   * Whether this grant is delegated or not. If `true`, the `grantedTo` will be able to act as the `grantedTo` within the scope of this grant.
   */
  public readonly delegated?: boolean;

  /**
   * The scope of the allowed access.
   */
  public readonly scope: PermissionScope;

  /**
   * Optional conditions that must be met when the grant is used.
   */
  public readonly conditions?: PermissionConditions;

  /**
   * Optional metadata describing the connect approval session that created this grant.
   */
  public readonly connectSession?: ConnectSessionMetadata;

  /**
   * Parses a `DataEncodedRecordsWriteMessage` into a `PermissionGrant`.
   * Validates that the message contains required structural fields:
   * `encodedData`, `authorization` (for grantor extraction), `descriptor.recipient` (grantee),
   * and that the decoded data contains `scope` and `dateExpires`.
   * @throws {DwnError} if any required field is missing.
   */
  public static parse(message: DataEncodedRecordsWriteMessage): PermissionGrant {
    PermissionGrant.validateMessage(message);
    const permissionGrant = new PermissionGrant(message);
    return permissionGrant;
  }

  /**
   * Validates that the message has the required structural fields for a permission grant.
   */
  private static validateMessage(message: DataEncodedRecordsWriteMessage): void {
    if (message.encodedData === undefined || message.encodedData === null) {
      throw new DwnError(
        DwnErrorCode.PermissionGrantParseMissingEncodedData,
        'permission grant message is missing encodedData'
      );
    }

    if (Message.getSigner(message) === undefined) {
      throw new DwnError(
        DwnErrorCode.PermissionGrantParseMissingAuthorization,
        'permission grant message is missing authorization (unable to extract grantor)'
      );
    }

    if (message.descriptor.recipient === undefined) {
      throw new DwnError(
        DwnErrorCode.PermissionGrantParseMissingRecipient,
        'permission grant message is missing descriptor.recipient (grantee)'
      );
    }

    const grantData = Encoder.base64UrlToObject(message.encodedData) as Partial<PermissionGrantData>;

    if (grantData.scope === undefined) {
      throw new DwnError(
        DwnErrorCode.PermissionGrantParseMissingScope,
        'permission grant data is missing required property `scope`'
      );
    }

    if (grantData.dateExpires === undefined) {
      throw new DwnError(
        DwnErrorCode.PermissionGrantParseMissingDateExpires,
        'permission grant data is missing required property `dateExpires`'
      );
    }
  }

  private constructor(message: DataEncodedRecordsWriteMessage) {
    // properties derived from the generic DWN message properties
    this.id = message.recordId;
    this.grantor = Message.getSigner(message)!;
    this.grantee = message.descriptor.recipient!;
    this.dateGranted = message.descriptor.dateCreated;

    // properties from the data payload itself.
    const permissionGrantEncoded = message.encodedData;
    const permissionGrant = Encoder.base64UrlToObject(permissionGrantEncoded) as PermissionGrantData;
    this.dateExpires = permissionGrant.dateExpires;
    this.delegated = permissionGrant.delegated;
    this.description = permissionGrant.description;
    this.requestId = permissionGrant.requestId;
    this.scope = permissionGrant.scope;
    this.conditions = permissionGrant.conditions;
    this.connectSession = permissionGrant.connectSession;
  }
}
