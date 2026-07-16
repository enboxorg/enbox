import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { LinkStatus, ReplicationLinkState, SyncAuthorization, SyncDirection, SyncScope } from './types/sync.js';

/** Parameters that identify and initialize a durable replication link. */
export type SyncReplicationLinkCreateParams = {
  tenantDid : string;
  remoteEndpoint : string;
  scope : SyncScope;
  authorizationEpoch : string;
  authorization : SyncAuthorization;
  delegateDid? : string;
};

/**
 * Backend-neutral persistence contract for durable replication-link state.
 *
 * Checkpoints are persisted per direction so concurrent pull and push work
 * cannot replace one another's progress. Backing-store lifecycle is owned by
 * the enclosing sync storage backend.
 */
export interface SyncReplicationLinkStore {
  /** Remove every durable replication link. */
  clear(): Promise<void>;

  /** Delete one durable replication link. */
  deleteLink(
    tenantDid: string,
    remoteEndpoint: string,
    projectionId: string,
    authorizationEpoch: string,
  ): Promise<void>;

  /** Get every durable replication link. */
  getAllLinks(): Promise<ReplicationLinkState[]>;

  /** Get or initialize one durable replication link. */
  getOrCreateLink(params: SyncReplicationLinkCreateParams): Promise<ReplicationLinkState>;

  /** Get every durable replication link for one tenant. */
  getLinksForTenant(tenantDid: string): Promise<ReplicationLinkState[]>;

  /** Persist the engine-computed checkpoint for one direction. */
  persistCheckpoint(link: ReplicationLinkState, direction: SyncDirection): Promise<void>;

  /** Reset both directional checkpoints and persist the reset atomically. */
  resetCheckpoints(link: ReplicationLinkState): Promise<void>;

  /** Reset one directional checkpoint and persist the reset. */
  resetCheckpoint(link: ReplicationLinkState, direction: SyncDirection, token?: ProgressToken): Promise<void>;

  /** Transition a link to a new status and persist its current connectivity. */
  setStatus(link: ReplicationLinkState, status: LinkStatus): Promise<void>;
}
