import type { DwnDataEncodedRecordsWriteMessage, DwnResponseStatus, EnboxAgent } from '@enbox/agent';

import { AgentPermissionsApi, getRecordAuthor } from '@enbox/agent';

import { sendPermissionRecordMessage, storePermissionRecordMessage } from './permission-record-transport.js';

/**
 * Represents the structured data model of a GrantRevocation record, encapsulating the essential fields that define.
 */
export interface GrantRevocationModel {
  /** The DWN message used to construct this revocation */
  rawMessage: DwnDataEncodedRecordsWriteMessage;
}

/**
 * Represents the options for creating a new GrantRevocation instance.
 */
export interface GrantRevocationOptions {
  /** The DID of the DWN tenant under which record operations are being performed. */
  connectedDid: string;
  /** The DWN message used to construct this revocation */
  message: DwnDataEncodedRecordsWriteMessage;
}

/**
 * The `PermissionGrantRevocation` class encapsulates a permissions protocol `grant/revocation` record, providing a more
 * developer-friendly interface for working with Decentralized Web Node (DWN) records.
 *
 * Methods are provided to manage the grant revocation's lifecycle, including writing to remote DWNs.
 *
 * @beta
 */
export class PermissionGrantRevocation implements GrantRevocationModel {
  /** The PermissionsAPI used to interact with the underlying revocation  */
  private readonly _permissions: AgentPermissionsApi;
  /** The DID to use as the author and default target for the underlying revocation */
  private readonly _connectedDid: string;
  /** The DWN `RecordsWrite` message, along with encodedData that represents the revocation */
  private _message: DwnDataEncodedRecordsWriteMessage;

  private constructor(permissions: AgentPermissionsApi, options: GrantRevocationOptions) {
    this._permissions = permissions;
    this._connectedDid = options.connectedDid;

    // Store the message that represents the grant.
    this._message = options.message;
  }

  /** The author of the underlying revocation message */
  get author(): string | undefined {
    return getRecordAuthor(this._message);
  }

  /** parses the grant revocation given am agent, connectedDid and data encoded records write message  */
  static async parse({ connectedDid, agent, message }:{
    connectedDid: string;
    agent: EnboxAgent;
    message: DwnDataEncodedRecordsWriteMessage;
  }): Promise<PermissionGrantRevocation> {
    const permissions = new AgentPermissionsApi({ agent });
    return new PermissionGrantRevocation(permissions, { connectedDid, message });
  }

  /** The agent to use for this instantiation of the grant revocation */
  private get agent(): EnboxAgent {
    return this._permissions.agent;
  }

  /** The raw `RecordsWrite` DWN message with encoded data that was used to instantiate this grant revocation */
  get rawMessage(): DwnDataEncodedRecordsWriteMessage {
    return this._message;
  }

  /**
   * Send the current grant revocation to a remote DWN by specifying their DID
   * If no DID is specified, the target is assumed to be the owner (connectedDID).
   *
   * @param target - the optional DID to send the grant revocation to, if none is set it is sent to the connectedDid
   * @returns the status of the send grant revocation request
   *
   * @beta
   */
  async send(target?: string): Promise<DwnResponseStatus> {
    return sendPermissionRecordMessage({
      agent        : this.agent,
      connectedDid : this._connectedDid,
      message      : this._message,
      target,
    });
  }

  /**
   * Stores the current grant revocation to the owner's DWN.
   *
   * @param importGrant - if true, the grant revocation will signed by the owner before storing it to the owner's DWN. Defaults to false.
   * @returns the status of the store request
   *
   * @beta
   */
  async store(importRevocation?: boolean): Promise<DwnResponseStatus> {
    const { message, status } = await storePermissionRecordMessage({
      agent        : this.agent,
      connectedDid : this._connectedDid,
      message      : this.rawMessage,
      signAsOwner  : importRevocation,
    });

    this._message = message;
    return status;
  }
}