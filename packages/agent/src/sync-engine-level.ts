import type { AbstractLevel } from 'abstract-level';
import type {
  GenericMessage,
  MessagesReadReply,
  MessagesSyncReply,
  UnionMessageReply,
} from '@enbox/dwn-sdk-js';

import ms from 'ms';

import { Level } from 'level';
import {
  DataStream,
  DwnInterfaceName,
  DwnMethodName,
  Message,
  PermissionsProtocol,
} from '@enbox/dwn-sdk-js';

import type { PermissionsApi } from './types/permissions.js';
import type { SyncEngine, SyncIdentityOptions } from './types/sync.js';
import type { Web5Agent, Web5PlatformAgent } from './types/agent.js';

import { AgentPermissionsApi } from './permissions-api.js';
import { DwnInterface } from './types/dwn.js';
import { getDwnServiceEndpointUrls, isRecordsWrite } from './utils.js';

export type SyncEngineLevelParams = {
  agent?: Web5PlatformAgent;
  dataPath?: string;
  db?: AbstractLevel<string | Buffer | Uint8Array>;
};

/**
 * Maximum bit prefix depth before falling back to leaf enumeration.
 * At depth 16, each subtree covers ~1/65536 of the key space, which is a good
 * balance between round-trip count and leaf-set size.
 */
const MAX_DIFF_DEPTH = 16;

export class SyncEngineLevel implements SyncEngine {
  /**
   * Holds the instance of a `Web5PlatformAgent` that represents the current execution context for
   * the `SyncEngineLevel`. This agent is used to interact with other Web5 agent components. It's
   * vital to ensure this instance is set to correctly contextualize operations within the broader
   * Web5 Agent framework.
   */
  private _agent?: Web5PlatformAgent;

  /**
   * An instance of the `AgentPermissionsApi` that is used to interact with permissions grants used during sync
   */
  private _permissionsApi: PermissionsApi;

  private _db: AbstractLevel<string | Buffer | Uint8Array>;
  private _syncIntervalId?: ReturnType<typeof setInterval>;
  private _syncLock = false;

  constructor({ agent, dataPath, db }: SyncEngineLevelParams) {
    this._agent = agent;
    this._permissionsApi = new AgentPermissionsApi({ agent: agent as Web5Agent });
    this._db = (db) ? db : new Level<string, string>(dataPath ?? 'DATA/AGENT/SYNC_STORE');
  }

  /**
   * Retrieves the `Web5PlatformAgent` execution context.
   *
   * @returns The `Web5PlatformAgent` instance that represents the current execution context.
   * @throws Will throw an error if the `agent` instance property is undefined.
   */
  get agent(): Web5PlatformAgent {
    if (this._agent === undefined) {
      throw new Error('SyncEngineLevel: Unable to determine agent execution context.');
    }

    return this._agent;
  }

  set agent(agent: Web5PlatformAgent) {
    this._agent = agent;
    this._permissionsApi = new AgentPermissionsApi({ agent: agent as Web5Agent });
  }

  public async clear(): Promise<void> {
    await this._permissionsApi.clear();
    await this._db.clear();
  }

  public async close(): Promise<void> {
    await this._db.close();
  }

  public async registerIdentity({ did, options }: { did: string; options?: SyncIdentityOptions }): Promise<void> {
    const registeredIdentities = this._db.sublevel('registeredIdentities');

    const existing = await this.getIdentityOptions(did);
    if (existing) {
      throw new Error(`SyncEngineLevel: Identity with DID ${did} is already registered.`);
    }

    // if no options are provided, we default to no delegateDid and all protocols (empty array)
    options ??= { protocols: [] };

    await registeredIdentities.put(did, JSON.stringify(options));
  }

  public async unregisterIdentity(did: string): Promise<void> {
    const registeredIdentities = this._db.sublevel('registeredIdentities');
    const existing = await this.getIdentityOptions(did);
    if (!existing) {
      throw new Error(`SyncEngineLevel: Identity with DID ${did} is not registered.`);
    }

    await registeredIdentities.del(did);
  }

  public async getIdentityOptions(did: string): Promise<SyncIdentityOptions | undefined> {
    const registeredIdentities = this._db.sublevel('registeredIdentities');
    try {
      const options = await registeredIdentities.get(did);
      if (options) {
        return JSON.parse(options) as SyncIdentityOptions;
      }
    } catch (error) {
      const e = error as { code: string };
      // `Level` throws an error if the key is not present. Return `undefined` in this case.
      if (e.code === 'LEVEL_NOT_FOUND') {
        return;
      } else {
        throw new Error(`SyncEngineLevel: Error reading level: ${e.code}.`);
      }
    }
  }

  public async updateIdentityOptions({ did, options }: { did: string, options: SyncIdentityOptions }): Promise<void> {
    const registeredIdentities = this._db.sublevel('registeredIdentities');
    const existingOptions = await this.getIdentityOptions(did);
    if (!existingOptions) {
      throw new Error(`SyncEngineLevel: Identity with DID ${did} is not registered.`);
    }

    await registeredIdentities.put(did, JSON.stringify(options));
  }

  public async sync(direction?: 'push' | 'pull'): Promise<void> {
    if (this._syncLock) {
      throw new Error('SyncEngineLevel: Sync operation is already in progress.');
    }

    this._syncLock = true;
    try {
      // Iterate over all registered identities and their DWN endpoints.
      const syncTargets = await this.getSyncTargets();
      const errored = new Set<string>();

      for (const target of syncTargets) {
        const { did, delegateDid, dwnUrl, protocol } = target;

        if (errored.has(dwnUrl)) {
          continue;
        }

        try {
          // Phase 1: Compare SMT roots between local and remote.
          const localRoot = await this.getLocalRoot(did, delegateDid, protocol);
          const remoteRoot = await this.getRemoteRoot(did, dwnUrl, delegateDid, protocol);

          if (localRoot === remoteRoot) {
            // Trees are identical — nothing to sync for this target.
            continue;
          }

          // Phase 2: Walk the tree to find differing subtrees.
          const diff = await this.walkTreeDiff({
            did, dwnUrl, delegateDid, protocol,
          });

          // Phase 3: Pull missing messages (remote has, local doesn't).
          if (!direction || direction === 'pull') {
            if (diff.onlyRemote.length > 0) {
              await this.pullMessages({ did, dwnUrl, delegateDid, protocol, messageCids: diff.onlyRemote });
            }
          }

          // Phase 4: Push missing messages (local has, remote doesn't).
          if (!direction || direction === 'push') {
            if (diff.onlyLocal.length > 0) {
              await this.pushMessages({ did, dwnUrl, delegateDid, protocol, messageCids: diff.onlyLocal });
            }
          }
        } catch (error: any) {
          // If the remote DWN is unreachable, skip this target and continue.
          errored.add(dwnUrl);
          console.error(`SyncEngineLevel: Error syncing ${did} with ${dwnUrl}`, error);
        }
      }
    } finally {
      this._syncLock = false;
    }
  }

  public async startSync({ interval }: {
    interval: string
  }): Promise<void> {
    const intervalMilliseconds = ms(interval);

    const intervalSync = async (): Promise<void> => {
      if (this._syncLock) {
        return;
      }

      clearInterval(this._syncIntervalId);
      this._syncIntervalId = undefined;

      try {
        await this.sync();
      } catch (error) {
        console.error('SyncEngineLevel: Error during sync operation', error);
      }

      if (!this._syncIntervalId) {
        this._syncIntervalId = setInterval(intervalSync, intervalMilliseconds);
      }
    };

    if (this._syncIntervalId) {
      clearInterval(this._syncIntervalId);
    }

    this._syncIntervalId = setInterval(intervalSync, intervalMilliseconds);

    // Initiate an immediate sync.
    if (!this._syncLock) {
      await this.sync();
    }
  }

  /**
   * stopSync awaits the completion of the current sync operation before stopping the sync interval.
   */
  public async stopSync(timeout: number = 2000): Promise<void> {
    let elapsedTimeout = 0;

    while (this._syncLock) {
      if (elapsedTimeout >= timeout) {
        throw new Error(`SyncEngineLevel: Existing sync operation did not complete within ${timeout} milliseconds.`);
      }

      elapsedTimeout += 100;
      await new Promise((resolve): void => { setTimeout(resolve, timeout < 100 ? timeout : 100); });
    }

    if (this._syncIntervalId) {
      clearInterval(this._syncIntervalId);
      this._syncIntervalId = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // SMT Root Comparison
  // ---------------------------------------------------------------------------

  /**
   * Get the SMT root hash from the local DWN via a MessagesSync 'root' action.
   * Returns a hex-encoded root hash string.
   */
  private async getLocalRoot(did: string, delegateDid?: string, protocol?: string): Promise<string> {
    const permissionGrantId = await this.getSyncPermissionGrantId(did, delegateDid, protocol);

    const response = await this.agent.dwn.processRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.MessagesSync,
      granteeDid    : delegateDid,
      messageParams : {
        action: 'root',
        protocol,
        permissionGrantId
      }
    });

    const reply = response.reply as MessagesSyncReply;
    return reply.root ?? '';
  }

  /**
   * Get the SMT root hash from a remote DWN via a MessagesSync 'root' action.
   * Returns a hex-encoded root hash string.
   */
  private async getRemoteRoot(did: string, dwnUrl: string, delegateDid?: string, protocol?: string): Promise<string> {
    const permissionGrantId = await this.getSyncPermissionGrantId(did, delegateDid, protocol);

    const syncMessage = await this.agent.dwn.processRequest({
      store         : false,
      author        : did,
      target        : did,
      messageType   : DwnInterface.MessagesSync,
      granteeDid    : delegateDid,
      messageParams : {
        action: 'root',
        protocol,
        permissionGrantId
      }
    });

    const reply = await this.agent.rpc.sendDwnRequest({
      dwnUrl,
      targetDid : did,
      message   : syncMessage.message,
    }) as MessagesSyncReply;

    return reply.root ?? '';
  }

  // ---------------------------------------------------------------------------
  // Tree Diff — walk the SMT to find divergent leaf sets
  // ---------------------------------------------------------------------------

  /**
   * Walks the local and remote SMTs in parallel, recursing into subtrees whose
   * hashes differ, until reaching `MAX_DIFF_DEPTH` where leaves are enumerated.
   *
   * Returns the sets of messageCids that exist only locally or only remotely.
   */
  private async walkTreeDiff({ did, dwnUrl, delegateDid, protocol }: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
  }): Promise<{ onlyLocal: string[]; onlyRemote: string[] }> {
    const onlyLocal: string[] = [];
    const onlyRemote: string[] = [];

    // Hoist permission grant lookup — resolved once and reused for all subtree/leaf requests.
    const permissionGrantId = await this.getSyncPermissionGrantId(did, delegateDid, protocol);

    const walk = async (prefix: string): Promise<void> => {
      // Get subtree hashes for this prefix from local and remote.
      const [localHash, remoteHash] = await Promise.all([
        this.getLocalSubtreeHash(did, prefix, delegateDid, protocol, permissionGrantId),
        this.getRemoteSubtreeHash(did, dwnUrl, prefix, delegateDid, protocol, permissionGrantId),
      ]);

      // If hashes match, this subtree is identical — skip.
      if (localHash === remoteHash) {
        return;
      }

      // Short-circuit: if one side is entirely empty, all entries on the other
      // side are unique.  Enumerate leaves directly instead of recursing further
      // into the tree — this avoids the exponential walk when the remote DWN
      // returns empty responses (e.g. auth failure or truly empty tree).
      if (!remoteHash && localHash) {
        const localLeaves = await this.getLocalLeaves(did, prefix, delegateDid, protocol, permissionGrantId);
        onlyLocal.push(...localLeaves);
        return;
      }
      if (!localHash && remoteHash) {
        const remoteLeaves = await this.getRemoteLeaves(did, dwnUrl, prefix, delegateDid, protocol, permissionGrantId);
        onlyRemote.push(...remoteLeaves);
        return;
      }

      // If we've reached the maximum diff depth, enumerate leaves.
      if (prefix.length >= MAX_DIFF_DEPTH) {
        const [localLeaves, remoteLeaves] = await Promise.all([
          this.getLocalLeaves(did, prefix, delegateDid, protocol, permissionGrantId),
          this.getRemoteLeaves(did, dwnUrl, prefix, delegateDid, protocol, permissionGrantId),
        ]);

        const localSet = new Set(localLeaves);
        const remoteSet = new Set(remoteLeaves);

        for (const cid of localLeaves) {
          if (!remoteSet.has(cid)) {
            onlyLocal.push(cid);
          }
        }
        for (const cid of remoteLeaves) {
          if (!localSet.has(cid)) {
            onlyRemote.push(cid);
          }
        }
        return;
      }

      // Recurse into left (0) and right (1) children in parallel.
      await Promise.all([
        walk(prefix + '0'),
        walk(prefix + '1'),
      ]);
    };

    await walk('');
    return { onlyLocal, onlyRemote };
  }

  private async getLocalSubtreeHash(
    did: string, prefix: string, delegateDid?: string, protocol?: string, permissionGrantId?: string
  ): Promise<string> {
    const response = await this.agent.dwn.processRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.MessagesSync,
      granteeDid    : delegateDid,
      messageParams : {
        action: 'subtree',
        prefix,
        protocol,
        permissionGrantId
      }
    });

    const reply = response.reply as MessagesSyncReply;
    return reply.hash ?? '';
  }

  private async getRemoteSubtreeHash(
    did: string, dwnUrl: string, prefix: string, delegateDid?: string, protocol?: string, permissionGrantId?: string
  ): Promise<string> {
    const syncMessage = await this.agent.dwn.processRequest({
      store         : false,
      author        : did,
      target        : did,
      messageType   : DwnInterface.MessagesSync,
      granteeDid    : delegateDid,
      messageParams : {
        action: 'subtree',
        prefix,
        protocol,
        permissionGrantId
      }
    });

    const reply = await this.agent.rpc.sendDwnRequest({
      dwnUrl,
      targetDid : did,
      message   : syncMessage.message,
    }) as MessagesSyncReply;

    return reply.hash ?? '';
  }

  private async getLocalLeaves(
    did: string, prefix: string, delegateDid?: string, protocol?: string, permissionGrantId?: string
  ): Promise<string[]> {
    const response = await this.agent.dwn.processRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.MessagesSync,
      granteeDid    : delegateDid,
      messageParams : {
        action: 'leaves',
        prefix,
        protocol,
        permissionGrantId
      }
    });

    const reply = response.reply as MessagesSyncReply;
    return reply.entries ?? [];
  }

  private async getRemoteLeaves(
    did: string, dwnUrl: string, prefix: string, delegateDid?: string, protocol?: string, permissionGrantId?: string
  ): Promise<string[]> {
    const syncMessage = await this.agent.dwn.processRequest({
      store         : false,
      author        : did,
      target        : did,
      messageType   : DwnInterface.MessagesSync,
      granteeDid    : delegateDid,
      messageParams : {
        action: 'leaves',
        prefix,
        protocol,
        permissionGrantId
      }
    });

    const reply = await this.agent.rpc.sendDwnRequest({
      dwnUrl,
      targetDid : did,
      message   : syncMessage.message,
    }) as MessagesSyncReply;

    return reply.entries ?? [];
  }

  // ---------------------------------------------------------------------------
  // Pull — fetch messages from remote, process locally in dependency order
  // ---------------------------------------------------------------------------

  /**
   * Fetches missing messages from the remote DWN and processes them on the local DWN
   * in dependency order (topological sort).
   */
  private async pullMessages({ did, dwnUrl, delegateDid, protocol, messageCids }: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
    messageCids: string[];
  }): Promise<void> {
    // Step 1: Fetch all missing messages from the remote in parallel.
    const fetched = await this.fetchRemoteMessages({ did, dwnUrl, delegateDid, protocol, messageCids });

    // Step 2: Build dependency graph and topological sort.
    const sorted = SyncEngineLevel.topologicalSort(fetched);

    // Step 3: Process messages in dependency order with multi-pass retry.
    // Retry up to MAX_RETRY_PASSES times for messages that fail due to
    // dependency ordering issues (e.g., a dependency was already local
    // but not yet committed when the dependent was first processed).
    const MAX_RETRY_PASSES = 3;
    let pending = sorted;

    for (let pass = 0; pass <= MAX_RETRY_PASSES && pending.length > 0; pass++) {
      const retryQueue: { message: GenericMessage; dataStream?: ReadableStream<Uint8Array> }[] = [];

      for (const entry of pending) {
        const pullReply = await this.agent.dwn.node.processMessage(did, entry.message, { dataStream: entry.dataStream });
        if (!SyncEngineLevel.syncMessageReplyIsSuccessful(pullReply)) {
          retryQueue.push(entry);
        }
      }

      pending = retryQueue;
    }
  }

  /**
   * Fetches messages from a remote DWN by their CIDs using MessagesRead.
   */
  private async fetchRemoteMessages({ did, dwnUrl, delegateDid, protocol, messageCids }: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
    messageCids: string[];
  }): Promise<{ message: GenericMessage; dataStream?: ReadableStream<Uint8Array> }[]> {
    const results: { message: GenericMessage; dataStream?: ReadableStream<Uint8Array> }[] = [];

    let permissionGrantId: string | undefined;
    if (delegateDid) {
      try {
        const messagesReadGrant = await this._permissionsApi.getPermissionForRequest({
          connectedDid : did,
          messageType  : DwnInterface.MessagesRead,
          delegateDid,
          protocol,
          cached       : true
        });
        permissionGrantId = messagesReadGrant.grant.id;
      } catch (error: any) {
        console.error('SyncEngineLevel: pull - Error fetching MessagesRead permission grant for delegate DID', error);
        return results;
      }
    }

    // Fetch messages in parallel with bounded concurrency.
    const CONCURRENCY = 10;
    let cursor = 0;

    while (cursor < messageCids.length) {
      const batch = messageCids.slice(cursor, cursor + CONCURRENCY);
      cursor += CONCURRENCY;

      type FetchResult = { message: GenericMessage; dataStream?: ReadableStream<Uint8Array> } | undefined;
      const batchResults = await Promise.all(batch.map(async (messageCid): Promise<FetchResult> => {
        const messagesRead = await this.agent.processDwnRequest({
          store         : false,
          author        : did,
          target        : did,
          messageType   : DwnInterface.MessagesRead,
          granteeDid    : delegateDid,
          messageParams : { messageCid, permissionGrantId }
        });

        let reply: MessagesReadReply;
        try {
          reply = await this.agent.rpc.sendDwnRequest({
            dwnUrl,
            targetDid : did,
            message   : messagesRead.message,
          }) as MessagesReadReply;
        } catch {
          return undefined;
        }

        if (reply.status.code !== 200 || !reply.entry?.message) {
          return undefined;
        }

        const replyEntry = reply.entry;
        let dataStream: ReadableStream<Uint8Array> | undefined;
        if (isRecordsWrite(replyEntry) && replyEntry.data) {
          dataStream = replyEntry.data;
        }

        return { message: replyEntry.message, dataStream };
      }));

      for (const result of batchResults) {
        if (result) {
          results.push(result);
        }
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Push — read local messages, send to remote
  // ---------------------------------------------------------------------------

  /**
   * Reads missing messages from the local DWN and pushes them to the remote DWN.
   * Messages are fetched first, then sorted in dependency order (topological sort)
   * so that initial writes come before updates, and ProtocolsConfigures come before
   * records that reference those protocols.
   */
  private async pushMessages({ did, dwnUrl, delegateDid, protocol, messageCids }: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
    messageCids: string[];
  }): Promise<void> {
    // Step 1: Fetch all local messages.
    const fetched: { message: GenericMessage; data?: Blob }[] = [];
    for (const messageCid of messageCids) {
      const dwnMessage = await this.getLocalMessage({ author: did, messageCid, delegateDid, protocol });
      if (dwnMessage) {
        fetched.push(dwnMessage);
      }
    }

    // Step 2: Sort in dependency order using the same topological sort as pull.
    // Adapt the fetched entries to the format expected by topologicalSort.
    const forSort = fetched.map((entry): { message: GenericMessage; dataStream?: ReadableStream<Uint8Array> } => ({
      message: entry.message,
    }));
    const sorted = SyncEngineLevel.topologicalSort(forSort);

    // Build a map from message to its Blob data so we can send it.
    const dataByMessage = new Map<GenericMessage, Blob | undefined>();
    for (const entry of fetched) {
      dataByMessage.set(entry.message, entry.data);
    }

    // Step 3: Push messages in dependency order.
    for (const entry of sorted) {
      const data = dataByMessage.get(entry.message);
      try {
        const reply = await this.agent.rpc.sendDwnRequest({
          dwnUrl,
          targetDid : did,
          data,
          message   : entry.message
        });

        if (!SyncEngineLevel.syncMessageReplyIsSuccessful(reply)) {
          const cid = await SyncEngineLevel.getMessageCid(entry.message);
          console.error(`SyncEngineLevel: push failed for ${cid}: ${reply.status.code} ${reply.status.detail}`);
        }
      } catch {
        // Remote unreachable — stop pushing to this endpoint.
        throw new Error(`SyncEngineLevel: Remote DWN at ${dwnUrl} is unreachable.`);
      }
    }
  }

  /**
   * Helper to get the CID of a message for logging purposes.
   */
  private static async getMessageCid(message: GenericMessage): Promise<string> {
    try {
      return await Message.getCid(message);
    } catch {
      return 'unknown';
    }
  }

  /**
   * Reads a message from the local DWN by its CID using MessagesRead.
   */
  private async getLocalMessage({ author, delegateDid, protocol, messageCid }: {
    author: string;
    delegateDid?: string;
    protocol?: string;
    messageCid: string;
  }): Promise<{ message: GenericMessage; data?: Blob } | undefined> {
    let permissionGrantId: string | undefined;
    if (delegateDid) {
      try {
        const messagesReadGrant = await this._permissionsApi.getPermissionForRequest({
          connectedDid : author,
          messageType  : DwnInterface.MessagesRead,
          delegateDid,
          protocol,
          cached       : true
        });
        permissionGrantId = messagesReadGrant.grant.id;
      } catch (error: any) {
        console.error('SyncEngineLevel: push - Error fetching MessagesRead permission grant for delegate DID', error);
        return;
      }
    }

    const { reply } = await this.agent.dwn.processRequest({
      author,
      target        : author,
      messageType   : DwnInterface.MessagesRead,
      granteeDid    : delegateDid,
      messageParams : { messageCid, permissionGrantId }
    });

    if (reply.status.code !== 200 || !reply.entry) {
      return undefined;
    }
    const messageEntry = reply.entry!;

    const dwnMessageWithBlob: { message: GenericMessage; data?: Blob } = { message: messageEntry.message };

    if (isRecordsWrite(messageEntry) && messageEntry.data) {
      const dataBytes = await DataStream.toBytes(messageEntry.data);
      dwnMessageWithBlob.data = new Blob([dataBytes], { type: messageEntry.message.descriptor.dataFormat });
    }

    return dwnMessageWithBlob;
  }

  // ---------------------------------------------------------------------------
  // Dependency-aware topological sort for pulled messages
  // ---------------------------------------------------------------------------

  /**
   * Builds a dependency graph from the fetched messages and returns them in
   * topological order so that dependencies are processed before dependents.
   *
   * Dependencies:
   * - ProtocolsConfigure must come before any RecordsWrite using that protocol
   * - Parent record must come before child record (via parentId)
   * - Initial write must come before update writes (same recordId, not initial)
   * - Permission grant must come before records using that permissionGrantId
   */
  static topologicalSort(
    messages: { message: GenericMessage; dataStream?: ReadableStream<Uint8Array> }[]
  ): { message: GenericMessage; dataStream?: ReadableStream<Uint8Array> }[] {
    if (messages.length <= 1) {
      return messages;
    }

    // Index messages by various keys for dependency resolution.
    const byIndex = new Map<number, { message: GenericMessage; dataStream?: ReadableStream<Uint8Array> }>();
    const protocolConfigureIndex = new Map<string, number>(); // protocol URL -> index
    const initialWriteIndex = new Map<string, number>(); // recordId -> index of initial write
    const grantIndex = new Map<string, number>(); // grant recordId -> index

    for (let i = 0; i < messages.length; i++) {
      const entry = messages[i];
      byIndex.set(i, entry);
      const desc = entry.message.descriptor;

      if (desc.interface === DwnInterfaceName.Protocols && desc.method === DwnMethodName.Configure) {
        const protocolUrl = (desc as any).definition?.protocol;
        if (protocolUrl) {
          protocolConfigureIndex.set(protocolUrl, i);
        }
      }

      if (desc.interface === DwnInterfaceName.Records && desc.method === DwnMethodName.Write) {
        const recordId = (entry.message as any).recordId;
        const isInitial = SyncEngineLevel.isInitialWrite(entry.message);
        if (isInitial && recordId) {
          initialWriteIndex.set(recordId, i);
        }

        // Index permission grants by recordId so dependents can reference them.
        if (
          (desc as any).protocol === PermissionsProtocol.uri &&
          (desc as any).protocolPath === PermissionsProtocol.grantPath &&
          recordId
        ) {
          grantIndex.set(recordId, i);
        }
      }
    }

    // Build adjacency list (edges: dependency -> dependent).
    const edges = new Map<number, Set<number>>();
    const inDegree = new Array(messages.length).fill(0) as number[];

    const addEdge = (from: number, to: number): void => {
      if (from === to) {
        return;
      }
      if (!edges.has(from)) {
        edges.set(from, new Set());
      }
      const edgeSet = edges.get(from)!;
      if (!edgeSet.has(to)) {
        edgeSet.add(to);
        inDegree[to]++;
      }
    };

    for (let i = 0; i < messages.length; i++) {
      const desc = messages[i].message.descriptor;
      const msg = messages[i].message as any;

      // Protocol dependency: RecordsWrite depends on ProtocolsConfigure for its protocol.
      if (desc.interface === DwnInterfaceName.Records) {
        const protocol = (desc as any).protocol;
        if (protocol && protocolConfigureIndex.has(protocol)) {
          addEdge(protocolConfigureIndex.get(protocol)!, i);
        }
      }

      // Parent dependency: child record depends on parent record.
      if (desc.interface === DwnInterfaceName.Records && (desc as any).parentId) {
        const parentId = (desc as any).parentId;
        if (initialWriteIndex.has(parentId)) {
          addEdge(initialWriteIndex.get(parentId)!, i);
        }
      }

      // Initial write dependency: update depends on initial write.
      if (desc.interface === DwnInterfaceName.Records && desc.method === DwnMethodName.Write) {
        const recordId = msg.recordId;
        if (recordId && !SyncEngineLevel.isInitialWrite(messages[i].message) && initialWriteIndex.has(recordId)) {
          addEdge(initialWriteIndex.get(recordId)!, i);
        }
      }

      // Delete depends on initial write.
      if (desc.interface === DwnInterfaceName.Records && desc.method === DwnMethodName.Delete) {
        const recordId = msg.descriptor?.recordId;
        if (recordId && initialWriteIndex.has(recordId)) {
          addEdge(initialWriteIndex.get(recordId)!, i);
        }
      }

      // Permission grant dependency: message depends on the grant it references.
      const permissionGrantId = (desc as any).permissionGrantId;
      if (permissionGrantId && grantIndex.has(permissionGrantId)) {
        addEdge(grantIndex.get(permissionGrantId)!, i);
      }
    }

    // Kahn's algorithm for topological sort.
    const queue: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (inDegree[i] === 0) {
        queue.push(i);
      }
    }

    const sorted: { message: GenericMessage; dataStream?: ReadableStream<Uint8Array> }[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      sorted.push(byIndex.get(node)!);

      const neighbors = edges.get(node);
      if (neighbors) {
        for (const neighbor of neighbors) {
          inDegree[neighbor]--;
          if (inDegree[neighbor] === 0) {
            queue.push(neighbor);
          }
        }
      }
    }

    // If there are nodes not in sorted (cycle), append them at the end.
    if (sorted.length < messages.length) {
      const sortedSet = new Set(sorted);
      for (let i = 0; i < messages.length; i++) {
        const entry = byIndex.get(i)!;
        if (!sortedSet.has(entry)) {
          sorted.push(entry);
        }
      }
    }

    return sorted;
  }

  /**
   * Checks whether a message is an initial RecordsWrite (not an update).
   * An initial write has recordId === message CID context or has no `dateModified` != `dateCreated`.
   */
  private static isInitialWrite(message: GenericMessage): boolean {
    const desc = message.descriptor as any;
    if (desc.interface !== DwnInterfaceName.Records || desc.method !== DwnMethodName.Write) {
      return false;
    }
    // A RecordsWrite is initial if dateCreated === messageTimestamp (first write for this recordId).
    return desc.dateCreated === desc.messageTimestamp;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * 202: message was successfully written to the remote DWN
   * 204: an initial write message was written without any data
   * 409: message was already present on the remote DWN
   * RecordsDelete + 404: the initial write was not found or already deleted
   */
  private static syncMessageReplyIsSuccessful(reply: UnionMessageReply): boolean {
    return reply.status.code === 202 ||
      reply.status.code === 204 ||
      reply.status.code === 409 ||
      (
        reply.entry?.message.descriptor.interface === DwnInterfaceName.Records &&
        reply.entry?.message.descriptor.method === DwnMethodName.Delete &&
        reply.status.code === 404
      );
  }

  /**
   * Returns the list of sync targets: (did, dwnUrl, delegateDid?, protocol?) tuples.
   */
  private async getSyncTargets(): Promise<{
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
  }[]> {
    const targets: { did: string; dwnUrl: string; delegateDid?: string; protocol?: string }[] = [];

    for await (const [did, options] of this._db.sublevel('registeredIdentities').iterator()) {
      const { protocols, delegateDid } = await new Promise<SyncIdentityOptions>((resolve): void => {
        try {
          const parsed = JSON.parse(options) as SyncIdentityOptions;
          resolve({ protocols: parsed.protocols, delegateDid: parsed.delegateDid });
        } catch {
          resolve({ protocols: [] });
        }
      });

      const dwnEndpointUrls = await getDwnServiceEndpointUrls(did, this.agent.did);
      if (dwnEndpointUrls.length === 0) {
        continue;
      }

      for (const dwnUrl of dwnEndpointUrls) {
        if (protocols.length === 0) {
          // Sync all protocols (global tree).
          targets.push({ did, delegateDid, dwnUrl });
        } else {
          for (const protocol of protocols) {
            targets.push({ did, delegateDid, dwnUrl, protocol });
          }
        }
      }
    }

    return targets;
  }

  /**
   * Gets the permission grant ID for MessagesSync if a delegateDid is provided.
   * Returns undefined if no delegate is in use (owner access).
   */
  private async getSyncPermissionGrantId(did: string, delegateDid?: string, protocol?: string): Promise<string | undefined> {
    if (!delegateDid) {
      return undefined;
    }

    try {
      const messagesSyncGrant = await this._permissionsApi.getPermissionForRequest({
        connectedDid : did,
        messageType  : DwnInterface.MessagesSync,
        delegateDid,
        protocol,
        cached       : true
      });
      return messagesSyncGrant.grant.id;
    } catch (error: any) {
      console.error('SyncEngineLevel: Error fetching MessagesSync permission grant for delegate DID', error);
      return undefined;
    }
  }
}
