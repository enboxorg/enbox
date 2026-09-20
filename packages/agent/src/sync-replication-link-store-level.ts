import type { ProgressToken } from '@enbox/dwn-sdk-js';
import type { AbstractBatchOperation, AbstractLevel, AbstractSublevel } from 'abstract-level';

import type {
  DeadLetterEntry,
  DirectionCheckpoint,
  LinkStatus,
  ReplicationLinkState,
  SyncAuthorization,
  SyncDirection,
  SyncScope,
} from './types/sync.js';

import type { SyncPendingPullInput, SyncPendingPullState } from './sync-pending-pull-store-level.js';

import { runSerializedByKey, runWithCrossContextLock } from '@enbox/common';

import { buildLinkKey } from './sync-link-key.js';
import { isRetryableSyncRecovery } from './sync-runtime-errors.js';
import { SyncCheckpoint } from './sync-checkpoint.js';
import { SyncDeadLetterStoreLevel } from './sync-dead-letter-store-level.js';
import { SyncPendingPullStoreLevel } from './sync-pending-pull-store-level.js';
import { canonicalizeSyncScope, computeProjectionId } from './types/sync.js';

type LevelKey = string | Buffer | Uint8Array;
type SyncLinkBatchOperation = AbstractBatchOperation<AbstractLevel<LevelKey>, string, string>;

/** Separator used in compound LevelDB keys. */
const KEY_SEP = '^';

/** Parameters that identify and initialize a durable replication link. */
export type SyncReplicationLinkCreateParams = {
  tenantDid : string;
  remoteEndpoint : string;
  scope : SyncScope;
  authorizationEpoch : string;
  authorization : SyncAuthorization;
  delegateDid? : string;
};

/** Durable state changes committed after one remote feed page has been examined. */
export type SyncPullPageCommit = {
  checkpoint: ProgressToken;
  deadLetters: DeadLetterEntry[];
  pending: SyncPendingPullInput[];
  settledMessageCids: string[];
};

/** Level-backed persistence for durable replication links. */
export class SyncReplicationLinkStoreLevel {
  private readonly _db: AbstractLevel<LevelKey>;
  private readonly _deadLetterStore: SyncDeadLetterStoreLevel;
  private readonly _links: AbstractSublevel<AbstractLevel<LevelKey>, LevelKey, string, string>;
  private readonly _lockNamespace: string;
  private readonly _pendingPullStore: SyncPendingPullStoreLevel;
  private readonly _pendingLinkOperations = new Map<string, Promise<void>>();

  constructor(db: AbstractLevel<LevelKey>, lockNamespace = 'default') {
    this._db = db;
    this._deadLetterStore = new SyncDeadLetterStoreLevel(db);
    this._links = db.sublevel('replicationLinks');
    this._lockNamespace = lockNamespace;
    this._pendingPullStore = new SyncPendingPullStoreLevel(db);
  }

  public async clear(): Promise<void> {
    await this.waitForPendingLinkOperations();
    await Promise.all([this._links.clear(), this._pendingPullStore.clear()]);
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
    const keys: string[] = [];
    for await (const [key] of this._links.iterator()) {
      keys.push(key);
    }
    return this.loadEnumeratedLinks(keys);
  }

  /** Load and resume an existing link without creating a missing durable record. */
  public getExistingLink(params: SyncReplicationLinkCreateParams): Promise<ReplicationLinkState | undefined> {
    return this.loadLink(params, false);
  }

  public getOrCreateLink(params: SyncReplicationLinkCreateParams): Promise<ReplicationLinkState> {
    return this.loadLink(params, true);
  }

  private loadLink(
    params: SyncReplicationLinkCreateParams,
    createIfMissing: true,
  ): Promise<ReplicationLinkState>;
  private loadLink(
    params: SyncReplicationLinkCreateParams,
    createIfMissing: false,
  ): Promise<ReplicationLinkState | undefined>;
  private async loadLink(
    params: SyncReplicationLinkCreateParams,
    createIfMissing: boolean,
  ): Promise<ReplicationLinkState | undefined> {
    const scope = canonicalizeSyncScope(params.scope);
    const projectionId = await computeProjectionId(params.tenantDid, scope);
    const key = SyncReplicationLinkStoreLevel.buildKey(
      params.tenantDid,
      params.remoteEndpoint,
      projectionId,
      params.authorizationEpoch,
    );

    return this.runForLink(key, async (): Promise<ReplicationLinkState | undefined> => {
      const existing = await this.getLink(key);
      if (existing !== undefined) {
        let changed = false;
        changed ||= SyncReplicationLinkStoreLevel.migratePullCheckpoint(existing);
        const persistedConnectivity = existing.connectivity;
        const persistedStatus = existing.status;
        if (params.authorization.kind === 'role' && existing.delegateDid !== params.delegateDid) {
          existing.delegateDid = params.delegateDid;
          changed = true;
        }
        const persistNormalizedDecision = SyncReplicationLinkStoreLevel.normalizeResumedLink(existing);
        changed ||= persistNormalizedDecision;
        if (changed) {
          const durable = persistNormalizedDecision
            ? existing
            : { ...existing, connectivity: persistedConnectivity, status: persistedStatus };
          await this._links.put(key, JSON.stringify(durable));
        }
        return existing;
      }
      if (!createIfMissing) {
        return undefined;
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
        pull               : { version: 2 },
        push               : {},
        delegateDid        : params.delegateDid,
      };

      await this._links.put(key, JSON.stringify(link));
      return link;
    });
  }

  public async getLinksForTenant(tenantDid: string): Promise<ReplicationLinkState[]> {
    const prefix = `${tenantDid}${KEY_SEP}`;
    const keys: string[] = [];
    for await (const [key] of this._links.iterator()) {
      if (key.startsWith(prefix)) {
        keys.push(key);
      }
    }
    return this.loadEnumeratedLinks(keys);
  }

  /** Atomically retain unresolved roots and advance the pull handled-through token. */
  public async commitPullPage(link: ReplicationLinkState, commit: SyncPullPageCommit): Promise<boolean> {
    const key = SyncReplicationLinkStoreLevel.buildKeyForLink(link);
    return this.runForLink(key, async (): Promise<boolean> => {
      const persistedLink = await this.getLink(key);
      if (persistedLink === undefined) {
        return false;
      }

      const pendingStates = await Promise.all(commit.pending.map(
        (input): Promise<SyncPendingPullState> => this._pendingPullStore.nextState(link, input),
      ));
      const pendingCids = new Set(pendingStates.map(({ messageCid }) => messageCid));
      const operations: SyncLinkBatchOperation[] = [];
      for (const state of pendingStates) {
        operations.push(this._pendingPullStore.putOperation(state));
      }
      for (const deadLetter of commit.deadLetters) {
        operations.push(this._deadLetterStore.putOperation(deadLetter));
        operations.push(this._deadLetterStore.deleteLegacyOperation(
          link.tenantDid,
          deadLetter.messageCid,
          link.remoteEndpoint,
        ));
        operations.push(this._pendingPullStore.deleteOperation(link, deadLetter.messageCid));
      }
      for (const messageCid of new Set(commit.settledMessageCids)) {
        if (!pendingCids.has(messageCid)) {
          operations.push(this._pendingPullStore.deleteOperation(link, messageCid));
        }
        operations.push(this._deadLetterStore.deletePreciseOperation({
          authorizationEpoch : link.authorizationEpoch,
          direction          : 'pull',
          messageCid,
          projectionId       : link.projectionId,
          remoteEndpoint     : link.remoteEndpoint,
          tenantDid          : link.tenantDid,
        }));
        operations.push(this._deadLetterStore.deleteLegacyOperation(link.tenantDid, messageCid, link.remoteEndpoint));
      }

      const durableLink = structuredClone(persistedLink);
      durableLink.pull.version = 2;
      SyncCheckpoint.commitContiguousToken(durableLink.pull, commit.checkpoint);
      const lastActivityAt = new Date().toISOString();
      durableLink.lastActivityAt = lastActivityAt;
      operations.push({
        type     : 'put',
        key,
        value    : JSON.stringify(durableLink),
        sublevel : this._links,
      });

      await this._db.batch(operations);
      link.pull.version = 2;
      SyncCheckpoint.commitContiguousToken(link.pull, commit.checkpoint);
      link.lastActivityAt = lastActivityAt;
      return true;
    });
  }

  public getPendingPullsForLink(link: ReplicationLinkState): Promise<SyncPendingPullState[]> {
    return this._pendingPullStore.getForLink(link);
  }

  /** Record another retry attempt without changing the remote feed checkpoint. */
  public async updatePendingPull(
    link: ReplicationLinkState,
    input: SyncPendingPullInput,
  ): Promise<boolean> {
    const key = SyncReplicationLinkStoreLevel.buildKeyForLink(link);
    return this.runForLink(key, async (): Promise<boolean> => {
      const persistedLink = await this.getLink(key);
      if (persistedLink === undefined) {
        return false;
      }
      const state = await this._pendingPullStore.nextState(link, input);
      await this._db.batch([this._pendingPullStore.putOperation(state)]);
      return true;
    });
  }

  public async settlePendingPull(
    link: ReplicationLinkState,
    messageCid: string,
    deadLetter?: DeadLetterEntry,
  ): Promise<boolean> {
    const key = SyncReplicationLinkStoreLevel.buildKeyForLink(link);
    return this.runForLink(key, async (): Promise<boolean> => {
      if (await this.getLink(key) === undefined) {
        return false;
      }
      const operations: SyncLinkBatchOperation[] = [this._pendingPullStore.deleteOperation(link, messageCid)];
      operations.push(this._deadLetterStore.deleteLegacyOperation(link.tenantDid, messageCid, link.remoteEndpoint));
      if (deadLetter === undefined) {
        operations.push(this._deadLetterStore.deletePreciseOperation({
          authorizationEpoch : link.authorizationEpoch,
          direction          : 'pull',
          messageCid,
          projectionId       : link.projectionId,
          remoteEndpoint     : link.remoteEndpoint,
          tenantDid          : link.tenantDid,
        }));
      } else {
        operations.push(this._deadLetterStore.putOperation(deadLetter));
      }
      await this._db.batch(operations);
      return true;
    });
  }

  /** Clear the same locally materialized CID from every owned/delegated endpoint link. */
  public async settlePendingPullsForLogicalTarget(
    link: ReplicationLinkState,
    messageCids: readonly string[],
  ): Promise<void> {
    const states = await this._pendingPullStore.getForLogicalTarget(link, new Set(messageCids));
    await Promise.all(states.map(async state => {
      const key = buildLinkKey(
        state.tenantDid,
        state.remoteEndpoint,
        state.projectionId,
        state.authorizationEpoch,
      );
      await this.runForLink(key, async (): Promise<void> => {
        const current = await this._pendingPullStore.get({
          ...link,
          tenantDid          : state.tenantDid,
          remoteEndpoint     : state.remoteEndpoint,
          projectionId       : state.projectionId,
          authorizationEpoch : state.authorizationEpoch,
        }, state.messageCid);
        if (current === undefined) {
          return;
        }
        await this._db.batch([
          this._pendingPullStore.deleteStateOperation(current),
          this._deadLetterStore.deleteLegacyOperation(state.tenantDid, state.messageCid, state.remoteEndpoint),
          this._deadLetterStore.deletePreciseOperation({
            authorizationEpoch : state.authorizationEpoch,
            direction          : 'pull',
            messageCid         : state.messageCid,
            projectionId       : state.projectionId,
            remoteEndpoint     : state.remoteEndpoint,
            tenantDid          : state.tenantDid,
          }),
        ]);
      });
    }));
  }

  public clearPendingPulls(): Promise<void> {
    return this._pendingPullStore.clear();
  }

  public deleteOwnedPendingPullsForTenant(tenantDid: string): Promise<void> {
    return this._pendingPullStore.deleteOwnedForTenant(tenantDid);
  }

  public deletePendingPullsForLink(link: ReplicationLinkState): Promise<void> {
    return this._pendingPullStore.deleteForLink(link);
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
    SyncReplicationLinkStoreLevel.assignStatus(link, status);
    const connectivity = link.connectivity;
    await this.updateLink(link, (persistedLink): void => {
      SyncReplicationLinkStoreLevel.assignStatus(persistedLink, status);
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
   * Runtime connectivity and retry state do not survive sessions. Migrate
   * legacy repairing rows and transient pauses back to ordinary initialization;
   * deliberate authorization pauses remain paused.
   *
   * @returns Whether the normalized legacy decision must be persisted.
   */
  private static normalizeResumedLink(existing: ReplicationLinkState): boolean {
    existing.connectivity = 'unknown';
    return SyncReplicationLinkStoreLevel.normalizeLegacyLink(existing);
  }

  /** Remove retired runtime state from a durable row read through enumeration. */
  private static normalizeLegacyLink(existing: ReplicationLinkState): boolean {
    const legacy = existing as Omit<ReplicationLinkState, 'status'> & {
      recovery?: { error: string; failedAt: string; nextRetryAt?: string };
      status: LinkStatus | 'repairing';
    };
    let changed = legacy.recovery !== undefined;
    if (legacy.status === 'repairing') {
      legacy.status = legacy.recovery !== undefined && !isRetryableSyncRecovery(legacy.recovery)
        ? 'paused'
        : 'initializing';
      changed = true;
    } else if (legacy.status === 'paused' && isRetryableSyncRecovery(legacy.recovery)) {
      existing.status = 'initializing';
      changed = true;
    }
    delete legacy.recovery;
    return changed;
  }

  private static migratePullCheckpoint(existing: ReplicationLinkState): boolean {
    if (existing.pull.version === 2) {
      return false;
    }
    SyncCheckpoint.reset(existing.pull);
    existing.pull.version = 2;
    return true;
  }

  private async loadEnumeratedLinks(keys: string[]): Promise<ReplicationLinkState[]> {
    const links = await Promise.all(keys.map((key): Promise<ReplicationLinkState | undefined> =>
      this.runForLink(key, async (): Promise<ReplicationLinkState | undefined> => {
        const link = await this.getLink(key);
        if (link !== undefined) {
          const checkpointChanged = SyncReplicationLinkStoreLevel.migratePullCheckpoint(link);
          const runtimeStateChanged = SyncReplicationLinkStoreLevel.normalizeLegacyLink(link);
          if (checkpointChanged || runtimeStateChanged) {
            await this._links.put(key, JSON.stringify(link));
          }
        }
        return link;
      })
    ));
    return links.filter((link): link is ReplicationLinkState => link !== undefined);
  }

  private static cloneCheckpoint(checkpoint: DirectionCheckpoint): DirectionCheckpoint {
    return structuredClone(checkpoint);
  }

  private static assignStatus(link: ReplicationLinkState, status: LinkStatus): void {
    link.status = status;
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
  private async updateLink(
    link: ReplicationLinkState,
    mutate: (persistedLink: ReplicationLinkState) => void,
    recordActivity = true,
  ): Promise<void> {
    const key = SyncReplicationLinkStoreLevel.buildKeyForLink(link);
    const lastActivityAt = recordActivity ? new Date().toISOString() : undefined;
    if (lastActivityAt !== undefined) {
      link.lastActivityAt = lastActivityAt;
    }

    await this.runForLink(key, async (): Promise<void> => {
      const persistedLink = await this.getLink(key);
      if (persistedLink === undefined) {
        return;
      }
      mutate(persistedLink);
      if (lastActivityAt !== undefined) {
        persistedLink.lastActivityAt = lastActivityAt;
      }
      await this._links.put(key, JSON.stringify(persistedLink));
    });
  }

  /** Serialize read/merge/write operations for one complete link identity. */
  private async runForLink<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return runSerializedByKey(
      this._pendingLinkOperations,
      key,
      (): Promise<T> => runWithCrossContextLock(
        `enbox:sync-link:${this._lockNamespace}:${key}`,
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
