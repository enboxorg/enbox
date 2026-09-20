import type { AbstractBatchOperation, AbstractLevel, AbstractSublevel } from 'abstract-level';
import type { DependencyRef, MessagesQueryReplyEntry, ProgressToken } from '@enbox/dwn-sdk-js';

import type { ReplicationLinkState, SyncAuthorization } from './types/sync.js';

import { buildLinkKey, LINK_KEY_SEPARATOR } from './sync-link-key.js';

type LevelKey = string | Buffer | Uint8Array;
type SyncLevelDatabase = AbstractLevel<LevelKey>;

export type SyncPendingPullOutcome = {
  kind: 'Deferred';
  detail?: string;
  missing?: DependencyRef[];
  reason?: 'data' | 'dependency' | 'resolver-unavailable' | 'storage' | 'tenant-inactive';
};

/** Durable materialization work retained after the remote feed cursor advances. */
export type SyncPendingPullState = {
  attempts: number;
  authorizationKind: SyncAuthorization['kind'];
  authorizationEpoch: string;
  entry: MessagesQueryReplyEntry;
  firstPendingAt: string;
  lastAttemptAt: string;
  messageCid: string;
  outcome: SyncPendingPullOutcome;
  projectionId: string;
  remoteEndpoint: string;
  source: ProgressToken;
  tenantDid: string;
  version: 2;
};

export type SyncPendingPullInput = {
  entry: MessagesQueryReplyEntry;
  outcome: SyncPendingPullOutcome;
  source: ProgressToken;
};

export type SyncPendingPullCandidate = Omit<SyncPendingPullInput, 'source'>;

export type SyncPendingPullBatchOperation = AbstractBatchOperation<SyncLevelDatabase, string, string>;

/** Level-backed owner of durable pull entries that still need local materialization. */
export class SyncPendingPullStoreLevel {
  private readonly _pendingPulls: AbstractSublevel<SyncLevelDatabase, LevelKey, string, string>;

  public constructor(private readonly _db: SyncLevelDatabase) {
    this._pendingPulls = _db.sublevel('pendingPullsV2');
  }

  public async clear(): Promise<void> {
    await this._pendingPulls.clear();
  }

  public deleteOperation(link: ReplicationLinkState, messageCid: string): SyncPendingPullBatchOperation {
    return {
      type     : 'del',
      key      : SyncPendingPullStoreLevel.buildKey(link, messageCid),
      sublevel : this._pendingPulls,
    };
  }

  public deleteStateOperation(state: SyncPendingPullState): SyncPendingPullBatchOperation {
    return {
      type     : 'del',
      key      : SyncPendingPullStoreLevel.buildStateKey(state),
      sublevel : this._pendingPulls,
    };
  }

  /** Delete only owned/delegated work; role rows belong to a followed acceptance. */
  public async deleteOwnedForTenant(tenantDid: string): Promise<void> {
    const operations: SyncPendingPullBatchOperation[] = [];
    for await (const [key, value] of this._pendingPulls.iterator(SyncPendingPullStoreLevel.tenantRange(tenantDid))) {
      const state = JSON.parse(value) as SyncPendingPullState;
      if (state.authorizationKind !== 'role') {
        operations.push({ type: 'del', key, sublevel: this._pendingPulls });
      }
    }
    if (operations.length > 0) {
      await this._db.batch(operations);
    }
  }

  public async deleteForLink(link: ReplicationLinkState): Promise<void> {
    await this._pendingPulls.clear(SyncPendingPullStoreLevel.linkRange(link));
  }

  public async get(link: ReplicationLinkState, messageCid: string): Promise<SyncPendingPullState | undefined> {
    try {
      const value = await this._pendingPulls.get(SyncPendingPullStoreLevel.buildKey(link, messageCid));
      return JSON.parse(value) as SyncPendingPullState;
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'LEVEL_NOT_FOUND') {
        return undefined;
      }
      throw error;
    }
  }

  public async getForLink(link: ReplicationLinkState): Promise<SyncPendingPullState[]> {
    const entries: SyncPendingPullState[] = [];
    for await (const [, value] of this._pendingPulls.iterator(SyncPendingPullStoreLevel.linkRange(link))) {
      const state = JSON.parse(value) as SyncPendingPullState;
      if (SyncPendingPullStoreLevel.belongsToLink(state, link)) {
        entries.push(state);
      }
    }
    entries.sort((a, b): number => {
      if (a.source.streamId !== b.source.streamId || a.source.epoch !== b.source.epoch) {
        return a.firstPendingAt.localeCompare(b.firstPendingAt);
      }
      const aPosition = BigInt(a.source.position);
      const bPosition = BigInt(b.source.position);
      return aPosition < bPosition ? -1 : aPosition > bPosition ? 1 : 0;
    });
    return entries;
  }

  public async getForLogicalTarget(
    identity: Pick<ReplicationLinkState, 'projectionId' | 'tenantDid'>,
    messageCids: ReadonlySet<string>,
  ): Promise<SyncPendingPullState[]> {
    const entries: SyncPendingPullState[] = [];
    for await (const [, value] of this._pendingPulls.iterator(SyncPendingPullStoreLevel.tenantRange(identity.tenantDid))) {
      const state = JSON.parse(value) as SyncPendingPullState;
      if (
        state.authorizationKind !== 'role' &&
        state.projectionId === identity.projectionId &&
        messageCids.has(state.messageCid)
      ) {
        entries.push(state);
      }
    }
    return entries;
  }

  public async nextState(link: ReplicationLinkState, input: SyncPendingPullInput): Promise<SyncPendingPullState> {
    const now = new Date().toISOString();
    const previous = await this.get(link, input.entry.messageCid);
    return {
      attempts           : (previous?.attempts ?? 0) + 1,
      authorizationKind  : link.authorization.kind,
      authorizationEpoch : link.authorizationEpoch,
      entry              : input.entry,
      firstPendingAt     : previous?.firstPendingAt ?? now,
      lastAttemptAt      : now,
      messageCid         : input.entry.messageCid,
      outcome            : input.outcome,
      projectionId       : link.projectionId,
      remoteEndpoint     : link.remoteEndpoint,
      source             : input.source,
      tenantDid          : link.tenantDid,
      version            : 2,
    };
  }

  public putOperation(state: SyncPendingPullState): SyncPendingPullBatchOperation {
    return {
      type     : 'put',
      key      : SyncPendingPullStoreLevel.buildStateKey(state),
      value    : JSON.stringify(state),
      sublevel : this._pendingPulls,
    };
  }

  public async put(state: SyncPendingPullState): Promise<void> {
    await this._db.batch([this.putOperation(state)]);
  }

  private static belongsToLink(state: SyncPendingPullState, link: ReplicationLinkState): boolean {
    return state.version === 2 &&
      state.tenantDid === link.tenantDid &&
      state.remoteEndpoint === link.remoteEndpoint &&
      state.projectionId === link.projectionId &&
      state.authorizationEpoch === link.authorizationEpoch;
  }

  private static buildKey(link: ReplicationLinkState, messageCid: string): string {
    return `${buildLinkKey(
      link.tenantDid,
      link.remoteEndpoint,
      link.projectionId,
      link.authorizationEpoch,
    )}${LINK_KEY_SEPARATOR}${messageCid}`;
  }

  private static buildStateKey(state: SyncPendingPullState): string {
    return `${buildLinkKey(
      state.tenantDid,
      state.remoteEndpoint,
      state.projectionId,
      state.authorizationEpoch,
    )}${LINK_KEY_SEPARATOR}${state.messageCid}`;
  }

  private static linkRange(link: ReplicationLinkState): { gte: string; lte: string } {
    const prefix = `${buildLinkKey(
      link.tenantDid,
      link.remoteEndpoint,
      link.projectionId,
      link.authorizationEpoch,
    )}${LINK_KEY_SEPARATOR}`;
    return { gte: prefix, lte: `${prefix}\xff` };
  }

  private static tenantRange(tenantDid: string): { gte: string; lte: string } {
    const prefix = `${tenantDid}${LINK_KEY_SEPARATOR}`;
    return { gte: prefix, lte: `${prefix}\xff` };
  }
}
