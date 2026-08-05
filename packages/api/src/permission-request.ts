import type {
  DwnDataEncodedRecordsWriteMessage,
  DwnPermissionConditions,
  DwnPermissionScope,
  DwnResponseStatus,
  EnboxAgent,
} from '@enbox/agent';

import { AgentPermissionsApi, DwnPermissionRequest } from '@enbox/agent';

import { PermissionGrant } from './permission-grant.js';
import { sendPermissionRecordMessage, storePermissionRecordMessage } from './permission-record-transport.js';

/**
 * Represents the structured data model of a PermissionsRequest record, encapsulating the essential fields that define
 * the request's data and payload within a Decentralized Web Node (DWN).
 */
export interface PermissionRequestModel {
  /**
   * The ID of the permission request, which is the record ID DWN message.
   */
  readonly id: string;

  /**
   * The requester for of the permission.
   */
  readonly requester: string;

  /**
   * Optional string that communicates what the requested grant would be used for.
   */
  readonly description?: string;

  /**
   * Whether the requested grant is delegated or not.
   * If `true`, the `requestor` will be able to act as the grantor of the permission within the scope of the requested grant.
   */
  readonly delegated?: boolean;

  /**
   * The scope of the allowed access.
   */
  readonly scope: DwnPermissionScope;

  /**
   * Optional conditions that must be met when the requested grant is used.
   */
  readonly conditions?: DwnPermissionConditions;
}

/**
 * The `PermissionRequest` class encapsulates a permissions protocol `request` record, providing a more
 * developer-friendly interface for working with Decentralized Web Node (DWN) records.
 *
 * Methods are provided to grant the request and manage the request's lifecycle, including writing to remote DWNs.
 *
 * @beta
 */
export class PermissionRequest implements PermissionRequestModel {
  /** The PermissionsAPI used to interact with the underlying permission request */
  private readonly _permissions: AgentPermissionsApi;
  /** The DID to use as the author and default target for the underlying permission request */
  private readonly _connectedDid: string;
  /** The underlying DWN `RecordsWrite` message along with encoded data that represent the request */
  private _message: DwnDataEncodedRecordsWriteMessage;
  /** The parsed permission request object */
  private readonly _request: DwnPermissionRequest;

  private constructor({ api, connectedDid, message, request }: {
    api: AgentPermissionsApi;
    connectedDid: string;
    message: DwnDataEncodedRecordsWriteMessage;
    request: DwnPermissionRequest;
  }) {
    this._permissions = api;
    this._connectedDid = connectedDid;

    // Store the parsed request object.
    this._request = request;

    // Store the message that represents the grant.
    this._message = message;
  }

  /** parses the request given an agent, connectedDid and data encoded records write message  */
  static parse({ connectedDid, agent, message }:{
    connectedDid: string;
    agent: EnboxAgent;
    message: DwnDataEncodedRecordsWriteMessage;
  }): PermissionRequest {
    const request = DwnPermissionRequest.parse(message);
    const api = new AgentPermissionsApi({ agent });
    return new PermissionRequest({ api, connectedDid, message, request });
  }

  /** The agent to use for this instantiation of the request */
  private get agent(): EnboxAgent {
    return this._permissions.agent;
  }

  /** The request's ID, which is also the underlying record's ID  */
  get id(): string {
    return this._request.id;
  }

  /** The DID that is requesting a permission */
  get requester(): string {
    return this._request.requester;
  }

  /** (optional) Description of the permission request */
  get description(): string | undefined {
    return this._request.description;
  }

  /** Whether or not the permission request can be used to impersonate the grantor */
  get delegated(): boolean | undefined {
    return this._request.delegated;
  }

  /** The permission scope under which the requested grant would be valid */
  get scope(): DwnPermissionScope {
    return this._request.scope;
  }

  /** The conditions under which the requested grant would be valid */
  get conditions(): DwnPermissionConditions | undefined {
    return this._request.conditions;
  }

  /** The `RecordsWrite` DWN message with encoded data that was used to instantiate this request */
  get rawMessage(): DwnDataEncodedRecordsWriteMessage {
    return this._message;
  }

  /**
   * Send the current permission request to a remote DWN by specifying their DID
   * If no DID is specified, the target is assumed to be the owner (connectedDID).
   *
   * @param target - the optional DID to send the permission request to, if none is set it is sent to the connectedDid
   * @returns the status of the send permission request
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
   * Stores the current permission request to the owner's DWN.
   *
   * @param importGrant - if true, the permission request will signed by the owner before storing it to the owner's DWN. Defaults to false.
   * @returns the status of the store request
   *
   * @beta
   */
  async store(): Promise<DwnResponseStatus> {
    const { message, status } = await storePermissionRecordMessage({
      agent        : this.agent,
      connectedDid : this._connectedDid,
      message      : this.rawMessage,
    });

    this._message = message;
    return status;
  }

  /**
   * Grants the permission request to the requester.
   *
   * @param dateExpires - the date when the permission grant will expire.
   * @param store - if true, the permission grant will be stored in the owner's DWN. Defaults to true.
   * @returns {PermissionGrant} the granted permission.
   *
   * @beta
   */
  async grant(dateExpires: string, store: boolean = true): Promise<PermissionGrant> {
    const { message } = await this._permissions.createGrant({
      requestId : this.id,
      grantedTo : this.requester,
      scope     : this.scope,
      delegated : this.delegated,
      author    : this._connectedDid,
      store,
      dateExpires,
    });

    return PermissionGrant.parse({
      connectedDid : this._connectedDid,
      agent        : this.agent,
      message
    });
  }

  /**
   * @returns the JSON representation of the permission request
   */
  toJSON(): PermissionRequestModel {
    return this._request;
  }
}