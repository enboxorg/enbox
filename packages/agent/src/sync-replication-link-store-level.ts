import type { AbstractLevel } from 'abstract-level';
import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { DirectionCheckpoint, LinkStatus, ReplicationLinkState, SyncDirection } from './types/sync.js';
import type { SyncReplicationLinkCreateParams, SyncReplicationLinkStore } from './sync-replication-link-store.js';

import { SyncCheckpoint } from './sync-checkpoint.js';
import { canonicalizeSyncScope, computeProjectionId } from './types/sync.js';
import { runSerializedByKey, runWithCrossContextLock } from './sync-cross-context-lock.js';

type LevelKey = string | Buffer | Uint8Array;

/** Separator used in compound LevelDB keys. */
const KEY_SEP = '^';

/** Level-backed persistence for durable replication links. */
export class SyncReplicationLinkStoreLevel implements SyncReplicationLinkStore {
  private readonly _links: AbstractLevel<LevelKey, string, string>;
  private readonly _lockScope: string;
  private readonly _pendingLinkOperations = new Map<string, Promise<void>>();

  constructor(db: AbstractLevel<LevelKey>, lockScope = 'default') {
    this._links = db.sublevel('replicationLinks');
    this._lockScope = lockScope;
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
        return SyncReplicationLinkStoreLevel.normalizeResumedLink(existing);
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

  public async persistCheckpoints(link: ReplicationLinkState): Promise<void> {
    const pull = SyncReplicationLinkStoreLevel.cloneCheckpoint(link.pull);
    const push = SyncReplicationLinkStoreLevel.cloneCheckpoint(link.push);
    await this.updateLink(link, (persistedLink): void => {
      SyncReplicationLinkStoreLevel.mergeCheckpoint(persistedLink.pull, pull);
      SyncReplicationLinkStoreLevel.mergeCheckpoint(persistedLink.push, push);
    });
  }

  public async resetCheckpoints(link: ReplicationLinkState): Promise<void> {
    SyncCheckpoint.reset(link.pull);
    SyncCheckpoint.reset(link.push);
    const pull = SyncReplicationLinkStoreLevel.cloneCheckpoint(link.pull);
    const push = SyncReplicationLinkStoreLevel.cloneCheckpoint(link.push);
    await this.updateLink(link, (persistedLink): void => {
      SyncCheckpoint.reset(persistedLink.pull, pull.contiguousAppliedToken);
      SyncCheckpoint.reset(persistedLink.push, push.contiguousAppliedToken);
    });
  }

  public async resetCheckpoint(link: ReplicationLinkState, direction: SyncDirection, token?: ProgressToken): Promise<void> {
    SyncCheckpoint.reset(link[direction], token);
    const checkpoint = SyncReplicationLinkStoreLevel.cloneCheckpoint(link[direction]);
    await this.updateLink(link, (persistedLink): void => {
      SyncCheckpoint.reset(persistedLink[direction], checkpoint.contiguousAppliedToken);
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

  /**
   * Runtime state does not survive sessions; durable decisions do. A prior
   * session's connectivity must not make a freshly loaded link appear online
   * before transport setup succeeds, and a persisted 'repairing' means a
   * repair was in flight when that session ended — nothing re-kicks repair on
   * load (subscription setup refuses 'repairing' links as a concurrent-
   * transition guard), so a fresh initialization subsumes the interrupted
   * repair. 'paused' is a durable decision and stays.
   */
  private static normalizeResumedLink(existing: ReplicationLinkState): ReplicationLinkState {
    existing.connectivity = 'unknown';
    if (existing.status === 'repairing') {
      existing.status = 'initializing';
    }
    return existing;
  }

  private static cloneCheckpoint(checkpoint: DirectionCheckpoint): DirectionCheckpoint {
    return structuredClone(checkpoint);
  }

  /**
   * Merge an in-memory checkpoint into the persisted one without regressing
   * within a token domain. One-shot work and another browser context can still
   * hold independent in-memory copies of one durable link, so a routine persist
   * from a stale copy must never move `contiguousAppliedToken` backwards. A
   * token from a different stream or epoch replaces the checkpoint wholesale —
   * that domain change is a deliberate feed reset. Clearing a checkpoint goes
   * through {@link resetCheckpoint}, which overwrites explicitly.
   */
  private static mergeCheckpoint(persisted: DirectionCheckpoint, incoming: DirectionCheckpoint): void {
    if (incoming.contiguousAppliedToken === undefined) {
      return;
    }

    if (!SyncCheckpoint.validateTokenDomain(persisted, incoming.contiguousAppliedToken)) {
      persisted.contiguousAppliedToken = incoming.contiguousAppliedToken;
      return;
    }

    SyncCheckpoint.commitContiguousToken(persisted, incoming.contiguousAppliedToken);
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
   * Merge a domain mutation into the latest stored link. A mutation whose
   * stored record is gone is dropped silently: a checkpoint persist racing a
   * deliberate superseded-link prune must not resurrect the deleted link.
   */
  private async updateLink(link: ReplicationLinkState, mutate: (persistedLink: ReplicationLinkState) => void): Promise<void> {
    const key = SyncReplicationLinkStoreLevel.buildKeyForLink(link);
    const lastActivityAt = new Date().toISOString();
    link.lastActivityAt = lastActivityAt;

    await this.runForLink(key, async (): Promise<void> => {
      const persistedLink = await this.getLink(key);
      if (persistedLink === undefined) {
        return;
      }
      mutate(persistedLink);
      persistedLink.lastActivityAt = lastActivityAt;
      await this._links.put(key, JSON.stringify(persistedLink));
    });
  }

  /** Serialize read/merge/write operations for one complete link identity. */
  private async runForLink<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return runSerializedByKey(
      this._pendingLinkOperations,
      key,
      (): Promise<T> => runWithCrossContextLock(
        `enbox:sync-link:${this._lockScope}:${key}`,
        operation,
      ),
    );
  }

  private async waitForPendingLinkOperations(): Promise<void> {
    while (this._pendingLinkOperations.size > 0) {
      await Promise.all(this._pendingLinkOperations.values());
    }
  }
}
