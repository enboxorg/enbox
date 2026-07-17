import type { AbstractLevel } from 'abstract-level';
import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { DirectionCheckpoint, LinkStatus, ReplicationLinkState, SyncDirection } from './types/sync.js';
import type { SyncReplicationLinkCreateParams, SyncReplicationLinkStore } from './sync-replication-link-store.js';

import { SyncCheckpoint } from './sync-checkpoint.js';
import { canonicalizeSyncScope, computeProjectionId } from './types/sync.js';

type LevelKey = string | Buffer | Uint8Array;

/** Separator used in compound LevelDB keys. */
const KEY_SEP = '^';

/** Level-backed persistence for durable replication links. */
export class SyncReplicationLinkStoreLevel implements SyncReplicationLinkStore {
  private readonly _links: AbstractLevel<LevelKey, string, string>;
  private readonly _pendingLinkOperations = new Map<string, Promise<void>>();

  constructor(db: AbstractLevel<LevelKey>) {
    this._links = db.sublevel('replicationLinks');
  }

  public async clear(): Promise<void> {
    await this.waitForPendingLinkOperations();
    await this._links.clear();
  }

  public async deleteLink(
    tenantDid: string,
    remoteEndpoint: string,
    projectionId: string,
    authorizationEpoch: string,
  ): Promise<void> {
    const key = SyncReplicationLinkStoreLevel.buildKey(tenantDid, remoteEndpoint, projectionId, authorizationEpoch);
    await this.runForLink(key, async (): Promise<void> => {
      await this._links.del(key);
    });
  }

  public async getAllLinks(): Promise<ReplicationLinkState[]> {
    const links: ReplicationLinkState[] = [];
    for await (const [, value] of this._links.iterator()) {
      links.push(JSON.parse(value) as ReplicationLinkState);
    }
    return links;
  }

  public async getOrCreateLink(params: SyncReplicationLinkCreateParams): Promise<ReplicationLinkState> {
    const scope = canonicalizeSyncScope(params.scope);
    const projectionId = await computeProjectionId(params.tenantDid, scope);
    const key = SyncReplicationLinkStoreLevel.buildKey(
      params.tenantDid,
      params.remoteEndpoint,
      projectionId,
      params.authorizationEpoch,
    );

    return this.runForLink(key, async (): Promise<ReplicationLinkState> => {
      const existing = await this.getLink(key);
      if (existing !== undefined) {
        // Connectivity is runtime state. A prior session's value must not make
        // a newly loaded link appear online before transport setup succeeds.
        existing.connectivity = 'unknown';
        return existing;
      }

      const link: ReplicationLinkState = {
        tenantDid          : params.tenantDid,
        remoteEndpoint     : params.remoteEndpoint,
        projectionId,
        authorizationEpoch : params.authorizationEpoch,
        scope,
        authorization      : params.authorization,
        status             : 'initializing',
        connectivity       : 'unknown',
        pull               : {},
        push               : {},
        delegateDid        : params.delegateDid,
      };

      await this._links.put(key, JSON.stringify(link));
      return link;
    });
  }

  public async getLinksForTenant(tenantDid: string): Promise<ReplicationLinkState[]> {
    const prefix = `${tenantDid}${KEY_SEP}`;
    const links: ReplicationLinkState[] = [];
    for await (const [key, value] of this._links.iterator()) {
      if (key.startsWith(prefix)) {
        links.push(JSON.parse(value) as ReplicationLinkState);
      }
    }
    return links;
  }

  public async persistCheckpoint(link: ReplicationLinkState, direction: SyncDirection): Promise<void> {
    const checkpoint = SyncReplicationLinkStoreLevel.cloneCheckpoint(link[direction]);
    await this.updateLink(link, (persistedLink): void => {
      SyncReplicationLinkStoreLevel.mergeCheckpoint(persistedLink[direction], checkpoint);
    });
  }

  public async resetCheckpoints(link: ReplicationLinkState): Promise<void> {
    SyncCheckpoint.reset(link.pull);
    SyncCheckpoint.reset(link.push);
    const pull = SyncReplicationLinkStoreLevel.cloneCheckpoint(link.pull);
    const push = SyncReplicationLinkStoreLevel.cloneCheckpoint(link.push);
    await this.updateLink(link, (persistedLink): void => {
      persistedLink.pull = pull;
      persistedLink.push = push;
    });
  }

  public async resetCheckpoint(link: ReplicationLinkState, direction: SyncDirection, token?: ProgressToken): Promise<void> {
    SyncCheckpoint.reset(link[direction], token);
    const checkpoint = SyncReplicationLinkStoreLevel.cloneCheckpoint(link[direction]);
    await this.updateLink(link, (persistedLink): void => {
      persistedLink[direction] = checkpoint;
    });
  }

  public async setStatus(link: ReplicationLinkState, status: LinkStatus): Promise<void> {
    link.status = status;
    const connectivity = link.connectivity;
    await this.updateLink(link, (persistedLink): void => {
      persistedLink.status = status;
      persistedLink.connectivity = connectivity;
    });
  }

  /** Replace a complete link for the public ReplicationLedger compatibility API. */
  protected async replaceLink(link: ReplicationLinkState): Promise<void> {
    const key = SyncReplicationLinkStoreLevel.buildKeyForLink(link);
    const lastActivityAt = new Date().toISOString();
    link.lastActivityAt = lastActivityAt;
    const snapshot = SyncReplicationLinkStoreLevel.cloneLink(link);
    await this.runForLink(key, async (): Promise<void> => {
      await this._links.put(key, JSON.stringify(snapshot));
    });
  }

  private static buildKey(
    tenantDid: string,
    remoteEndpoint: string,
    projectionId: string,
    authorizationEpoch: string,
  ): string {
    return `${tenantDid}${KEY_SEP}${remoteEndpoint}${KEY_SEP}${projectionId}${KEY_SEP}${authorizationEpoch}`;
  }

  // Compound keys use raw '^' separators. DID URIs, URLs, base64url
  // projection IDs, and base64url authorization epochs cannot contain '^'.
  private static buildKeyForLink(link: ReplicationLinkState): string {
    return SyncReplicationLinkStoreLevel.buildKey(
      link.tenantDid,
      link.remoteEndpoint,
      link.projectionId,
      link.authorizationEpoch,
    );
  }

  private static cloneCheckpoint(checkpoint: DirectionCheckpoint): DirectionCheckpoint {
    return structuredClone(checkpoint);
  }

  /**
   * Merge an in-memory checkpoint into the persisted one without regressing
   * within a token domain. Concurrent writers hold independent in-memory
   * copies of one durable link (the live controller's instance and the feed
   * reconciler's freshly loaded instance), so a routine persist from a stale
   * copy must never move `contiguousAppliedToken` backwards. A token from a
   * different stream or epoch replaces the checkpoint wholesale — that domain
   * change is a deliberate feed reset. Clearing a checkpoint goes through
   * {@link resetCheckpoint}, which overwrites explicitly.
   */
  private static mergeCheckpoint(persisted: DirectionCheckpoint, incoming: DirectionCheckpoint): void {
    if (incoming.contiguousAppliedToken === undefined) {
      SyncReplicationLinkStoreLevel.mergeReceivedToken(persisted, incoming.receivedToken);
      return;
    }

    if (!SyncCheckpoint.validateTokenDomain(persisted, incoming.contiguousAppliedToken)) {
      persisted.contiguousAppliedToken = incoming.contiguousAppliedToken;
      persisted.receivedToken = incoming.receivedToken;
      return;
    }

    SyncCheckpoint.commitContiguousToken(persisted, incoming.contiguousAppliedToken);
    SyncReplicationLinkStoreLevel.mergeReceivedToken(persisted, incoming.receivedToken);
  }

  /**
   * Merge a received token only within the persisted checkpoint's established
   * domain. `setReceivedToken` compares positions alone, so a stale old-epoch
   * token with a numerically larger position would otherwise override a
   * newer domain's value and leave a mixed-domain checkpoint.
   */
  private static mergeReceivedToken(persisted: DirectionCheckpoint, token: ProgressToken | undefined): void {
    if (token === undefined || !SyncCheckpoint.validateTokenDomain(persisted, token)) {
      return;
    }
    SyncCheckpoint.setReceivedToken(persisted, token);
  }

  private static cloneLink(link: ReplicationLinkState): ReplicationLinkState {
    return structuredClone(link);
  }

  private async getLink(key: string): Promise<ReplicationLinkState | undefined> {
    try {
      return JSON.parse(await this._links.get(key)) as ReplicationLinkState;
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'LEVEL_NOT_FOUND') {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Merge a domain mutation into the latest stored link. The complete active
   * link is retained only as a missing-record fallback, matching the legacy
   * saveLink behavior without using it to replace unrelated persisted fields.
   */
  private async updateLink(link: ReplicationLinkState, mutate: (persistedLink: ReplicationLinkState) => void): Promise<void> {
    const key = SyncReplicationLinkStoreLevel.buildKeyForLink(link);
    const fallback = SyncReplicationLinkStoreLevel.cloneLink(link);
    const lastActivityAt = new Date().toISOString();
    link.lastActivityAt = lastActivityAt;

    await this.runForLink(key, async (): Promise<void> => {
      const persistedLink = await this.getLink(key) ?? fallback;
      mutate(persistedLink);
      persistedLink.lastActivityAt = lastActivityAt;
      await this._links.put(key, JSON.stringify(persistedLink));
    });
  }

  /** Serialize read/merge/write operations for one complete link identity. */
  private async runForLink<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this._pendingLinkOperations.get(key);
    const operationPromise = (async (): Promise<T> => {
      if (previous !== undefined) {
        await previous;
      }
      return operation();
    })();
    const completion = operationPromise.then(
      (): void => undefined,
      (): void => undefined,
    );
    this._pendingLinkOperations.set(key, completion);

    try {
      return await operationPromise;
    } finally {
      if (this._pendingLinkOperations.get(key) === completion) {
        this._pendingLinkOperations.delete(key);
      }
    }
  }

  private async waitForPendingLinkOperations(): Promise<void> {
    while (this._pendingLinkOperations.size > 0) {
      await Promise.all(this._pendingLinkOperations.values());
    }
  }
}
