import type { CreateGrantParams, CreateRequestParams, CreateRevocationParams, FetchPermissionRequestParams, FetchPermissionsParams, GetPermissionParams, IsGrantRevokedParams, PermissionGrantEntry, PermissionRequestEntry, PermissionRevocationEntry, PermissionsApi } from './types/permissions.js';
import type { DwnDataEncodedRecordsWriteMessage, DwnMessageParams, DwnRecordsPermissionScope, ProcessDwnRequest } from './types/dwn.js';
import type { EnboxAgent, EnboxPlatformAgent } from './types/agent.js';
import type { MessageStore, PermissionGrant, PermissionGrantData, PermissionRequestData, PermissionRevocationData } from '@enbox/dwn-sdk-js';

import { isRecordsType } from './dwn-api.js';
import { Convert, TtlCache } from '@enbox/common';
import { DwnInterface, DwnPermissionGrant, DwnPermissionRequest } from './types/dwn.js';
import { PermissionScopeMatcher, PermissionsProtocol } from '@enbox/dwn-sdk-js';

export class AgentPermissionsApi implements PermissionsApi {

  /** cache for fetching a permission {@link PermissionGrant}, keyed by a specific MessageType and protocol */
  private readonly _cachedPermissions: TtlCache<string, PermissionGrantEntry> = new TtlCache({ ttl: 60 * 1000 });

  private _agent?: EnboxAgent;

  get agent(): EnboxAgent {
    if (!this._agent) {
      throw new Error('AgentPermissionsApi: Agent is not set');
    }
    return this._agent;
  }

  set agent(agent:EnboxAgent) {
    this._agent = agent;
  }

  constructor({ agent }: { agent?: EnboxAgent } = {}) {
    this._agent = agent;
  }

  async getPermissionForRequest({
    connectedDid,
    delegateDid,
    delegate,
    messageType,
    protocol,
    protocolPath,
    contextId,
    cached = false
  }: GetPermissionParams): Promise<PermissionGrantEntry> {
    const cacheKey = JSON.stringify([ connectedDid, delegateDid, messageType, protocol, protocolPath, contextId ]);
    const cachedGrant = cached ? this._cachedPermissions.get(cacheKey) : undefined;
    if (cachedGrant) {
      return cachedGrant;
    }

    const permissionGrants = await this.fetchGrants({
      author  : delegateDid,
      target  : delegateDid,
      grantor : connectedDid,
      grantee : delegateDid,
    });

    // get the delegate grants that match the messageParams and are associated with the connectedDid as the grantor
    const grant = await AgentPermissionsApi.matchGrantFromArray(
      connectedDid,
      delegateDid,
      { messageType, protocol, protocolPath, contextId },
      permissionGrants,
      delegate
    );

    if (!grant) {
      throw new Error(`CachedPermissions: No permissions found for ${messageType}: ${[protocol, protocolPath, contextId].filter(Boolean).join('/') || undefined}`);
    }

    this._cachedPermissions.set(cacheKey, grant);
    return grant;
  }

  async fetchGrants({
    author,
    target,
    grantee,
    grantor,
    protocol,
    remote = false,
    checkRevoked = true,
  }: FetchPermissionsParams): Promise<PermissionGrantEntry[]> {

    // filter by a protocol using tags if provided
    const tags = protocol ? { protocol } : undefined;

    const params: ProcessDwnRequest<DwnInterface.RecordsQuery> = {
      author        : author,
      target        : target,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          author       : grantor, // the author of the grant would be the grantor
          recipient    : grantee, // the recipient of the grant would be the grantee
          protocol     : PermissionsProtocol.uri,
          protocolPath : PermissionsProtocol.grantPath,
          tags
        }
      }
    };

    const { reply } = remote ? await this.agent.sendDwnRequest(params) : await this.agent.processDwnRequest(params);
    if (reply.status.code !== 200) {
      throw new Error(`PermissionsApi: Failed to fetch grants: ${reply.status.detail}`);
    }

    const grantMessages = reply.entries! as DwnDataEncodedRecordsWriteMessage[];

    // Build a set of revoked grant IDs so that revoked grants can be filtered out.
    const revokedGrantIds = checkRevoked
      ? await this.fetchRevokedGrantIds({ author, target, grantMessages, remote })
      : new Set<string>();

    const grants:PermissionGrantEntry[] = [];
    for (const entry of grantMessages) {
      if (revokedGrantIds.has(entry.recordId)) {
        continue;
      }
      const grant = DwnPermissionGrant.parse(entry);
      grants.push({ grant, message: entry });
    }

    return grants;
  }

  /**
   * Fetch all revocation record IDs for grants, returned as a Set of parent grant record IDs.
   */
  private async fetchRevokedGrantIds({ author, target, grantMessages, remote }: {
    author: string;
    target: string;
    grantMessages: DwnDataEncodedRecordsWriteMessage[];
    remote: boolean;
  }): Promise<Set<string>> {
    if (grantMessages.length === 0) {
      return new Set<string>();
    }

    // Bulk grant listings are local/synced views: owner reads can use the local
    // store predicate directly, while cross-tenant or remote reads go through
    // the message path for authorization and authoritative remote state.
    const messageStore = this.getOwnerLocalMessageStore({ author, target, remote });
    const revokedGrantIds = new Set<string>();
    await Promise.all(grantMessages.map(async (grantMessage): Promise<void> => {
      const revoked = messageStore !== undefined
        ? await this.isGrantRevokedInLocalStore(target, grantMessage.recordId, messageStore)
        : await this.isGrantRevoked({
          author,
          target,
          grantRecordId: grantMessage.recordId,
          remote,
        });
      if (revoked) {
        revokedGrantIds.add(grantMessage.recordId);
      }
    }));

    return revokedGrantIds;
  }

  private async isGrantRevokedInLocalStore(tenant: string, grantRecordId: string, messageStore: MessageStore): Promise<boolean> {
    const { messages } = await messageStore.query(
      tenant,
      [PermissionsProtocol.grantRevocationFilter(grantRecordId)],
      undefined,
      { limit: 1 },
    );
    return messages.length > 0;
  }

  private getOwnerLocalMessageStore({ author, target, remote }: {
    author: string;
    target: string;
    remote: boolean;
  }): MessageStore | undefined {
    if (remote || author !== target) {
      return undefined;
    }

    const dwn = (this.agent as Partial<EnboxPlatformAgent>).dwn;
    if (dwn === undefined || dwn.isRemoteMode) {
      return undefined;
    }

    return dwn.node.storage.messageStore;
  }

  async fetchRequests({
    author,
    target,
    protocol,
    remote = false
  }:FetchPermissionRequestParams):Promise<PermissionRequestEntry[]> {
    // filter by a protocol using tags if provided
    const tags = protocol ? { protocol } : undefined;

    const params: ProcessDwnRequest<DwnInterface.RecordsQuery> = {
      author        : author,
      target        : target,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : PermissionsProtocol.uri,
          protocolPath : PermissionsProtocol.requestPath,
          tags
        }
      }
    };

    const { reply } = remote ? await this.agent.sendDwnRequest(params) : await this.agent.processDwnRequest(params);
    if (reply.status.code !== 200) {
      throw new Error(`PermissionsApi: Failed to fetch requests: ${reply.status.detail}`);
    }

    const requests: PermissionRequestEntry[] = [];
    for (const entry of reply.entries! as DwnDataEncodedRecordsWriteMessage[]) {
      const request = DwnPermissionRequest.parse(entry);
      requests.push({ request, message: entry });
    }

    return requests;
  }

  async isGrantRevoked({
    author,
    target,
    grantRecordId,
    remote = false
  }: IsGrantRevokedParams): Promise<boolean> {
    const revocationFilter = PermissionsProtocol.grantRevocationFilter(grantRecordId);
    const params: ProcessDwnRequest<DwnInterface.RecordsRead> = {
      author,
      target,
      messageType   : DwnInterface.RecordsRead,
      messageParams : {
        filter: {
          parentId     : revocationFilter.parentId as string,
          protocol     : PermissionsProtocol.uri,
          protocolPath : revocationFilter.protocolPath as string,
        }
      }
    };

    const { reply: revocationReply } = remote ? await this.agent.sendDwnRequest(params) : await this.agent.processDwnRequest(params);
    if (revocationReply.status.code === 404) {
      // no revocation found, the grant is not revoked
      return false;
    } else if (revocationReply.status.code === 200) {
      // a revocation was found, the grant is revoked
      return true;
    }

    throw new Error(`PermissionsApi: Failed to check if grant is revoked: ${revocationReply.status.detail}`);
  }

  async createGrant(params: CreateGrantParams): Promise<PermissionGrantEntry> {
    const { author, store = false, delegated = false, ...createGrantParams } = params;

    let tags = undefined;
    if (PermissionsProtocol.hasProtocolScope(createGrantParams.scope)) {
      tags = { protocol: createGrantParams.scope.protocol };
    }

    const permissionGrantData: PermissionGrantData = {
      dateExpires : createGrantParams.dateExpires,
      requestId   : createGrantParams.requestId,
      description : createGrantParams.description,
      delegated,
      scope       : createGrantParams.scope,
    };

    // Attach delegate key-delivery metadata to the grant data payload.
    // This is stored in the grant's encoded data (not tags) to avoid
    // SQL column size limits on tag values.
    if (createGrantParams.delegateKeyDelivery) {
      permissionGrantData.delegateKeyDelivery = createGrantParams.delegateKeyDelivery;
    }

    const permissionsGrantBytes = Convert.object(permissionGrantData).toUint8Array();

    const messageParams: DwnMessageParams[DwnInterface.RecordsWrite] = {
      recipient    : createGrantParams.grantedTo,
      protocol     : PermissionsProtocol.uri,
      protocolPath : PermissionsProtocol.grantPath,
      dataFormat   : 'application/json',
      tags
    };

    const { reply, message } = await this.agent.processDwnRequest({
      store,
      author,
      target      : author,
      messageType : DwnInterface.RecordsWrite,
      messageParams,
      dataStream  : new Blob([ permissionsGrantBytes as BlobPart ])
    });

    if (reply.status.code !== 202) {
      throw new Error(`PermissionsApi: Failed to create grant: ${reply.status.detail}`);
    }

    const dataEncodedMessage: DwnDataEncodedRecordsWriteMessage = {
      ...message!,
      encodedData: Convert.uint8Array(permissionsGrantBytes).toBase64Url()
    };

    const grant = DwnPermissionGrant.parse(dataEncodedMessage);

    return { grant, message: dataEncodedMessage };
  }

  async createRequest(params: CreateRequestParams): Promise<PermissionRequestEntry> {
    const { author, store = false, delegated = false, ...createGrantParams } = params;

    let tags = undefined;
    if (PermissionsProtocol.hasProtocolScope(createGrantParams.scope)) {
      tags = { protocol: createGrantParams.scope.protocol };
    }

    const permissionRequestData: PermissionRequestData = {
      description : createGrantParams.description,
      delegated,
      scope       : createGrantParams.scope
    };

    const permissionRequestBytes = Convert.object(permissionRequestData).toUint8Array();

    const messageParams: DwnMessageParams[DwnInterface.RecordsWrite] = {
      protocol     : PermissionsProtocol.uri,
      protocolPath : PermissionsProtocol.requestPath,
      dataFormat   : 'application/json',
      tags
    };

    const { reply, message } = await this.agent.processDwnRequest({
      store,
      author,
      target      : author,
      messageType : DwnInterface.RecordsWrite,
      messageParams,
      dataStream  : new Blob([ permissionRequestBytes as BlobPart ])
    });

    if (reply.status.code !== 202) {
      throw new Error(`PermissionsApi: Failed to create request: ${reply.status.detail}`);
    }

    const dataEncodedMessage: DwnDataEncodedRecordsWriteMessage = {
      ...message!,
      encodedData: Convert.uint8Array(permissionRequestBytes).toBase64Url()
    };

    const request = DwnPermissionRequest.parse(dataEncodedMessage);

    return { request, message: dataEncodedMessage };
  }

  async createRevocation(params: CreateRevocationParams): Promise<PermissionRevocationEntry> {
    const { author, store = false, grant, description } = params;

    const revokeData: PermissionRevocationData = { description };

    const permissionRevocationBytes = Convert.object(revokeData).toUint8Array();

    let tags = undefined;
    if (PermissionsProtocol.hasProtocolScope(grant.scope)) {
      tags = { protocol: grant.scope.protocol };
    }

    const messageParams: DwnMessageParams[DwnInterface.RecordsWrite] = {
      parentContextId : grant.id,
      protocol        : PermissionsProtocol.uri,
      protocolPath    : PermissionsProtocol.revocationPath,
      dataFormat      : 'application/json',
      tags
    };

    if (params.permissionGrantId) {
      messageParams.permissionGrantId = params.permissionGrantId;
    }

    const { reply, message } = await this.agent.processDwnRequest({
      store,
      author,
      target      : author,
      messageType : DwnInterface.RecordsWrite,
      messageParams,
      granteeDid  : params.granteeDid,
      dataStream  : new Blob([ permissionRevocationBytes as BlobPart ])
    });

    if (reply.status.code !== 202) {
      throw new Error(`PermissionsApi: Failed to create revocation: ${reply.status.detail}`);
    }

    const dataEncodedMessage: DwnDataEncodedRecordsWriteMessage = {
      ...message!,
      encodedData: Convert.uint8Array(permissionRevocationBytes).toBase64Url()
    };

    return { message: dataEncodedMessage };
  }

  async clear():Promise<void> {
    this._cachedPermissions.clear();
  }

  /**
   * Matches the appropriate grant from an array of grants based on the provided parameters.
   *
   * @param delegated if true, only delegated grants are turned, if false all grants are returned including delegated ones.
   */
  static async matchGrantFromArray<T extends DwnInterface>(
    grantor: string,
    grantee: string,
    messageParams: {
      messageType: T,
      protocol?: string,
      protocolPath?: string,
      contextId?: string,
    },
    grants: PermissionGrantEntry[],
    delegated: boolean = false
  ): Promise<PermissionGrantEntry | undefined> {
    // Two-pass matching: prefer exact scope matches over unified Messages.Read fallback.
    // Messages.Read is the only valid Messages scope, but the exact-match path
    // preserves normal behavior for non-Messages grants and MessagesRead itself.
    let unifiedFallback: PermissionGrantEntry | undefined;

    for (const entry of grants) {
      const { grant, message } = entry;
      if (delegated === true && grant.delegated !== true) {
        continue;
      }
      const { messageType, protocol, protocolPath, contextId } = messageParams;

      if (this.matchScopeFromGrant(grantor, grantee, messageType, grant, protocol, protocolPath, contextId)) {
        const scopeMessageType = grant.scope.interface + grant.scope.method;
        // Exact match — return immediately
        if (scopeMessageType === messageType) {
          return { grant, message };
        }
        // Unified fallback match — hold for later in case an exact match is found
        if (!unifiedFallback) {
          unifiedFallback = { grant, message };
        }
      }
    }

    return unifiedFallback;
  }

  private static matchScopeFromGrant<T extends DwnInterface>(
    grantor: string,
    grantee: string,
    messageType: T,
    grant: PermissionGrant,
    protocol?: string,
    protocolPath?: string,
    contextId?: string
  ): boolean {
    // Check if the grant matches the provided parameters
    if (grant.grantee !== grantee || grant.grantor !== grantor) {
      return false;
    }

    const scope = grant.scope;
    const scopeMessageType = scope.interface + scope.method;

    // Messages.Read is the only valid Messages scope and covers Query, Read, and Subscribe operations.
    // Defensively require method === Read so malformed grants with method Query/Subscribe
    // are rejected rather than treated as valid scopes.
    const isMessagesScopeMatch = scope.interface === 'Messages'
      ? scope.method === 'Read'
        && (messageType === DwnInterface.MessagesQuery
          || messageType === DwnInterface.MessagesRead
          || messageType === DwnInterface.MessagesSubscribe)
      : scopeMessageType === messageType;

    if (isMessagesScopeMatch) {
      if (isRecordsType(messageType)) {
        const recordScope = scope as DwnRecordsPermissionScope;
        return PermissionScopeMatcher.matches(recordScope, { protocol, protocolPath, contextId });
      } else {
        const messagesScope = scope;
        return PermissionScopeMatcher.matches(messagesScope, { protocol, protocolPath, contextId });
      }
    }

    return false;
  }
}
