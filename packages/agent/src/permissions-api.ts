import type { EnboxAgent } from './types/agent.js';
import type { CreateGrantParams, CreateRequestParams, CreateRevocationParams, FetchPermissionRequestParams, FetchPermissionsParams, GetPermissionParams, IsGrantRevokedParams, PermissionGrantEntry, PermissionRequestEntry, PermissionRevocationEntry, PermissionsApi } from './types/permissions.js';
import type { DwnDataEncodedRecordsWriteMessage, DwnMessageParams, DwnRecordsPermissionScope, ProcessDwnRequest } from './types/dwn.js';
import type { PermissionGrant, PermissionGrantData, PermissionRequestData, PermissionRevocationData } from '@enbox/dwn-sdk-js';

import { isRecordsType } from './dwn-type-guards.js';
import { mapConcurrent } from './utils.js';
import { Convert, TtlCache } from '@enbox/common';
import { DwnInterface, DwnPermissionGrant, DwnPermissionRequest } from './types/dwn.js';
import { DwnInterfaceName, DwnMethodName, PermissionScopeMatcher, PermissionsProtocol, Time } from '@enbox/dwn-sdk-js';

const REVOCATION_CHECK_CONCURRENCY = 8;
const PERMISSION_CATALOG_CACHE_MAX = 100;
const PERMISSION_CATALOG_CACHE_TTL = 60 * 1000;

type GrantMatchRank = {
  exactMessageType: boolean;
  specificity: number;
  dateExpires: string;
  dateGranted: string;
};

/** Indicates that no active permission grant matches a delegated request. */
export class PermissionGrantNotFoundError extends Error {
  public constructor({ messageType, protocol, protocolPath, contextId }: Pick<
    GetPermissionParams,
    'messageType' | 'protocol' | 'protocolPath' | 'contextId'
  >) {
    const scope = [protocol, protocolPath, contextId].filter(Boolean).join('/') || undefined;
    super(`AgentPermissionsApi: No matching permission grant found for ${messageType}: ${scope}`);
    this.name = 'PermissionGrantNotFoundError';
  }
}

export class AgentPermissionsApi implements PermissionsApi {

  /** Active grant catalogs keyed by grantor and grantee, with scope matching performed per request. */
  private readonly _permissionCatalogCache = new TtlCache<string, PermissionGrantEntry[]>({
    max : PERMISSION_CATALOG_CACHE_MAX,
    ttl : PERMISSION_CATALOG_CACHE_TTL,
  });
  private readonly _permissionCatalogFetches = new Map<string, Promise<PermissionGrantEntry[]>>();
  private readonly _revokedGrantIds = new Set<string>();
  private _permissionCacheGeneration = 0;

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
    forceRefresh = false
  }: GetPermissionParams): Promise<PermissionGrantEntry> {
    const catalogKey = JSON.stringify([connectedDid, delegateDid]);
    const cachedCatalog = forceRefresh ? undefined : this._permissionCatalogCache.get(catalogKey);
    if (cachedCatalog !== undefined) {
      const cachedGrant = await this.matchGrantForRequest({
        connectedDid,
        delegateDid,
        delegate,
        messageType,
        protocol,
        protocolPath,
        contextId,
      }, cachedCatalog);
      if (cachedGrant !== undefined) {
        return cachedGrant;
      }
    }

    // A catalog miss is refreshed even when a cached catalog exists so newly
    // stored or newly delegated grants are discoverable before its TTL expires.
    const permissionGrants = await this.fetchPermissionCatalog({
      catalogKey,
      connectedDid,
      delegateDid,
      forceRefresh,
    });

    const grant = await this.matchGrantForRequest({
      connectedDid,
      delegateDid,
      delegate,
      messageType,
      protocol,
      protocolPath,
      contextId,
    }, permissionGrants);

    if (grant === undefined) {
      throw new PermissionGrantNotFoundError({ messageType, protocol, protocolPath, contextId });
    }

    return grant;
  }

  /** Fetches and caches one grant catalog while coalescing concurrent refreshes for the same DID pair. */
  private async fetchPermissionCatalog({ catalogKey, connectedDid, delegateDid, forceRefresh }: {
    catalogKey: string;
    connectedDid: string;
    delegateDid: string;
    forceRefresh: boolean;
  }): Promise<PermissionGrantEntry[]> {
    let activeFetch = this._permissionCatalogFetches.get(catalogKey);
    if (!forceRefresh && activeFetch !== undefined) {
      return activeFetch;
    }

    // An explicit fresh lookup must not join an older local-store read. Let
    // the older read settle, then issue a new one;
    // otherwise the forced lookup could join a stale pre-mutation snapshot.
    while (forceRefresh && activeFetch !== undefined) {
      try {
        await activeFetch;
      } catch {
        // The forced lookup below owns its own result and failure.
      }
      activeFetch = this._permissionCatalogFetches.get(catalogKey);
    }

    const generation = this._permissionCacheGeneration;
    const fetch = this.fetchGrants({
      author       : delegateDid,
      target       : delegateDid,
      grantor      : connectedDid,
      grantee      : delegateDid,
      checkRevoked : true,
    }).then((grants): PermissionGrantEntry[] => {
      if (this._permissionCacheGeneration === generation) {
        this._permissionCatalogCache.set(catalogKey, grants);
      }
      return grants;
    }).finally((): void => {
      if (this._permissionCatalogFetches.get(catalogKey) === fetch) {
        this._permissionCatalogFetches.delete(catalogKey);
      }
    });

    this._permissionCatalogFetches.set(catalogKey, fetch);
    return fetch;
  }

  /** Selects one active, non-revoked grant from a pair-level catalog. */
  private async matchGrantForRequest(
    { connectedDid, delegateDid, delegate, messageType, protocol, protocolPath, contextId }: Omit<GetPermissionParams, 'forceRefresh'>,
    permissionGrants: PermissionGrantEntry[],
  ): Promise<PermissionGrantEntry | undefined> {
    const activeGrants = permissionGrants.filter(({ grant }): boolean => !this._revokedGrantIds.has(grant.id));
    return AgentPermissionsApi.matchGrantFromArray(
      connectedDid,
      delegateDid,
      { messageType, protocol, protocolPath, contextId },
      activeGrants,
      delegate,
    );
  }

  async fetchGrants({
    author,
    target,
    grantee,
    grantor,
    protocol,
    remote = false,
    checkRevoked = false,
  }: FetchPermissionsParams): Promise<PermissionGrantEntry[]> {
    const cacheGeneration = this._permissionCacheGeneration;

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

    // Revocation filtering is opt-in and intentionally checks one grant at a
    // time. If this becomes hot, add a dedicated revocation-read path instead
    // of broad nested queries or parentId set filters.
    const revokedGrantIds = checkRevoked
      ? await this.fetchRevokedGrantIds({ author, target, grantMessages, remote, cacheGeneration })
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
   * Fetches the grant record IDs that have a stored revocation.
   */
  private async fetchRevokedGrantIds({ author, target, grantMessages, remote, cacheGeneration }: {
    author: string;
    target: string;
    grantMessages: DwnDataEncodedRecordsWriteMessage[];
    remote: boolean;
    cacheGeneration: number;
  }): Promise<Set<string>> {
    if (grantMessages.length === 0) {
      return new Set<string>();
    }

    const revokedGrantIds = new Set<string>();
    await mapConcurrent(grantMessages, REVOCATION_CHECK_CONCURRENCY, async (grantMessage): Promise<void> => {
      if (this._revokedGrantIds.has(grantMessage.recordId)) {
        revokedGrantIds.add(grantMessage.recordId);
        return;
      }

      const revoked = await this.readGrantRevocation({
        author,
        target,
        grantRecordId: grantMessage.recordId,
        remote,
      }, cacheGeneration);
      if (revoked) {
        revokedGrantIds.add(grantMessage.recordId);
      }
    });

    return revokedGrantIds;
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
    return this.readGrantRevocation({ author, target, grantRecordId, remote }, this._permissionCacheGeneration);
  }

  /** Reads one revocation while keeping cache writes owned by the initiating cache generation. */
  private async readGrantRevocation({
    author,
    target,
    grantRecordId,
    remote,
  }: Required<IsGrantRevokedParams>, cacheGeneration: number): Promise<boolean> {
    if (this._revokedGrantIds.has(grantRecordId)) {
      return true;
    }

    const params: ProcessDwnRequest<DwnInterface.RecordsRead> = {
      author,
      target,
      messageType   : DwnInterface.RecordsRead,
      messageParams : {
        filter: {
          parentId     : grantRecordId,
          protocol     : PermissionsProtocol.uri,
          protocolPath : PermissionsProtocol.revocationPath,
        }
      }
    };

    const { reply: revocationReply } = remote ? await this.agent.sendDwnRequest(params) : await this.agent.processDwnRequest(params);
    if (revocationReply.status.code === 404) {
      // no revocation found, the grant is not revoked
      return false;
    } else if (revocationReply.status.code === 200) {
      // a revocation was found, the grant is revoked
      if (this._permissionCacheGeneration === cacheGeneration) {
        this._revokedGrantIds.add(grantRecordId);
      }
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

    if (createGrantParams.connectSession) {
      permissionGrantData.connectSession = createGrantParams.connectSession;
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

    if (store) {
      this.invalidatePermissionLookups();
    }

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
    if (store) {
      this.invalidatePermissionLookups();
      this._revokedGrantIds.add(grant.id);
    }

    const dataEncodedMessage: DwnDataEncodedRecordsWriteMessage = {
      ...message!,
      encodedData: Convert.uint8Array(permissionRevocationBytes).toBase64Url()
    };

    return { message: dataEncodedMessage };
  }

  async clear():Promise<void> {
    this.invalidatePermissionLookups();
    this._revokedGrantIds.clear();
  }

  /** Invalidates grant lookup state while fencing cache writes from in-flight store reads. */
  private invalidatePermissionLookups(): void {
    this._permissionCacheGeneration++;
    this._permissionCatalogCache.clear();
    this._permissionCatalogFetches.clear();
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
    let bestEntry: PermissionGrantEntry | undefined;
    let bestRank: GrantMatchRank | undefined;
    const now = Time.getCurrentTimestamp();

    for (const entry of grants) {
      const { grant, message } = entry;
      if (!this.isGrantActive(grant, now)) {
        continue;
      }
      if (delegated === true && grant.delegated !== true) {
        continue;
      }
      const { messageType, protocol, protocolPath, contextId } = messageParams;

      if (this.matchScopeFromGrant(grantor, grantee, messageType, grant, protocol, protocolPath, contextId)) {
        const rank = AgentPermissionsApi.getGrantMatchRank(messageType, grant);
        if (bestRank === undefined || AgentPermissionsApi.isGrantMatchRankBetter(rank, bestRank)) {
          bestEntry = { grant, message };
          bestRank = rank;
        }
      }
    }

    return bestEntry;
  }

  private static getGrantMatchRank<T extends DwnInterface>(messageType: T, grant: PermissionGrant): GrantMatchRank {
    const scopeMessageType = grant.scope.interface + grant.scope.method;
    return {
      exactMessageType : scopeMessageType === messageType,
      specificity      : AgentPermissionsApi.getScopeSpecificity(grant),
      dateExpires      : grant.dateExpires,
      dateGranted      : grant.dateGranted,
    };
  }

  private static getScopeSpecificity(grant: PermissionGrant): number {
    const scope = grant.scope;
    if ('protocolPath' in scope && typeof scope.protocolPath === 'string') {
      return 2_000 + scope.protocolPath.split('/').length;
    }
    if ('contextId' in scope && typeof scope.contextId === 'string') {
      return 1_000 + scope.contextId.split('/').length;
    }
    if ('protocol' in scope && typeof scope.protocol === 'string') {
      return 1;
    }
    return 0;
  }

  private static isGrantMatchRankBetter(candidate: GrantMatchRank, current: GrantMatchRank): boolean {
    if (candidate.exactMessageType !== current.exactMessageType) {
      return candidate.exactMessageType;
    }

    if (candidate.specificity !== current.specificity) {
      return candidate.specificity > current.specificity;
    }

    if (candidate.dateExpires !== current.dateExpires) {
      return candidate.dateExpires > current.dateExpires;
    }

    return candidate.dateGranted > current.dateGranted;
  }

  private static isGrantActive(grant: PermissionGrant, now: string): boolean {
    return grant.dateGranted <= now && now < grant.dateExpires;
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
    const isMessagesScopeMatch = scope.interface === DwnInterfaceName.Messages
      ? scope.method === DwnMethodName.Read
        && (messageType === DwnInterface.MessagesQuery
          || messageType === DwnInterface.MessagesRead
          || messageType === DwnInterface.MessagesSubscribe)
      : false;

    // Records.Read is the canonical read-like Records scope and covers Query,
    // Read, Subscribe, and Count operations at the agent permission lookup layer.
    const isRecordsReadLikeMessage = messageType === DwnInterface.RecordsCount
      || messageType === DwnInterface.RecordsQuery
      || messageType === DwnInterface.RecordsRead
      || messageType === DwnInterface.RecordsSubscribe;
    let isRecordsScopeMatch = false;
    if (scope.interface === DwnInterfaceName.Records) {
      if (isRecordsReadLikeMessage) {
        isRecordsScopeMatch = scope.method === DwnMethodName.Read;
      } else {
        isRecordsScopeMatch = scopeMessageType === messageType;
      }
    }

    const isOtherScopeMatch = scope.interface !== DwnInterfaceName.Messages
      && scope.interface !== DwnInterfaceName.Records
      && scopeMessageType === messageType;

    if (isMessagesScopeMatch || isRecordsScopeMatch || isOtherScopeMatch) {
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
