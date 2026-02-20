import type { AbstractLevel } from 'abstract-level';
import type { GenericMessage, MessagesSyncReply } from '@enbox/dwn-sdk-js';

import ms from 'ms';

import { Level } from 'level';
import { hashToHex, initDefaultHashes } from '@enbox/dwn-sdk-js';

import type { PermissionsApi } from './types/permissions.js';
import type { SyncEngine, SyncIdentityOptions } from './types/sync.js';
import type { Web5Agent, Web5PlatformAgent } from './types/agent.js';

import { AgentPermissionsApi } from './permissions-api.js';
import { DwnInterface } from './types/dwn.js';
import { topologicalSort } from './sync-topological-sort.js';
import { pullMessages, pushMessages } from './sync-messages.js';

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

  /**
   * Hex-encoded default hashes for empty subtrees at each depth, keyed by depth.
   * Lazily initialized on first use. Used by `walkTreeDiff` to detect empty subtrees
   * and short-circuit the recursive walk instead of descending all the way to MAX_DIFF_DEPTH.
   */
  private _defaultHashHex?: Map<number, string>;

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
  // Default Hash Cache
  // ---------------------------------------------------------------------------

  /**
   * Returns the hex-encoded default (empty-subtree) hash for a given depth.
   * Lazily initializes the cache on first call.
   */
  private async getDefaultHashHex(depth: number): Promise<string> {
    if (this._defaultHashHex === undefined) {
      const defaults = await initDefaultHashes();
      const map = new Map<number, string>();
      // Pre-compute hex strings for depths 0 through MAX_DIFF_DEPTH (inclusive).
      for (let d = 0; d <= MAX_DIFF_DEPTH; d++) {
        map.set(d, hashToHex(defaults[d]));
      }
      this._defaultHashHex = map;
    }
    return this._defaultHashHex.get(depth) ?? '';
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

      // Short-circuit: if one side is the default (empty-subtree) hash, all entries
      // on the other side are unique.  Enumerate leaves directly instead of recursing
      // further into the tree — this avoids an exponential walk when one DWN has
      // entries that the other lacks entirely in this subtree.
      const emptyHash = await this.getDefaultHashHex(prefix.length);
      if (remoteHash === emptyHash && localHash !== emptyHash) {
        const localLeaves = await this.getLocalLeaves(did, prefix, delegateDid, protocol, permissionGrantId);
        onlyLocal.push(...localLeaves);
        return;
      }
      if (localHash === emptyHash && remoteHash !== emptyHash) {
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

  // ---------------------------------------------------------------------------
  // Pull / Push — delegates to standalone functions in sync-messages.ts
  // ---------------------------------------------------------------------------

  /**
   * Fetches missing messages from the remote DWN and processes them locally
   * in dependency order (topological sort).
   */
  private async pullMessages({ did, dwnUrl, delegateDid, protocol, messageCids }: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
    messageCids: string[];
  }): Promise<void> {
    return pullMessages({
      did, dwnUrl, delegateDid, protocol, messageCids,
      agent          : this.agent,
      permissionsApi : this._permissionsApi,
    });
  }

  /**
   * Reads missing messages from the local DWN and pushes them to the remote DWN
   * in dependency order (topological sort).
   */
  private async pushMessages({ did, dwnUrl, delegateDid, protocol, messageCids }: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
    messageCids: string[];
  }): Promise<void> {
    return pushMessages({
      did, dwnUrl, delegateDid, protocol, messageCids,
      agent          : this.agent,
      permissionsApi : this._permissionsApi,
    });
  }

  // ---------------------------------------------------------------------------
  // Dependency-aware topological sort — delegates to sync-topological-sort.ts
  // ---------------------------------------------------------------------------

  /**
   * Delegate to the standalone `topologicalSort` function.
   * Tests call `SyncEngineLevel.topologicalSort(...)` so this static method must remain.
   */
  static topologicalSort<T extends { message: GenericMessage }>(
    messages: T[]
  ): T[] {
    return topologicalSort(messages);
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

      const dwnEndpointUrls = await this.agent.dwn.getDwnEndpointUrlsForTarget(did);
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
