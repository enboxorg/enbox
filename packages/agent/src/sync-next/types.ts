import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { SyncAuthorization, SyncScope } from '../types/sync.js';

/** Exact identity shared by one link record and its sparse outcomes. */
export type SyncNextLinkIdentity = {
  authorizationEpoch: string;
  projectionId: string;
  remoteEndpoint: string;
  tenantDid: string;
};

export type SyncNextLinkCreate = SyncNextLinkIdentity & {
  authorization: SyncAuthorization;
  scope: SyncScope;
};

/** Durable progress and authority for one exact next-engine replication link. */
export type SyncNextLink = SyncNextLinkCreate & {
  pullHandledThrough?: ProgressToken;
  pushHandledThrough?: ProgressToken;
  updatedAt: string;
};

export type SyncNextSourceReceipt = {
  messageCid: string;
  source: ProgressToken;
};

/** Exact-source inbound input retained after pull progress advances. */
export type SyncNextQuarantineEntry = SyncNextLinkIdentity & SyncNextSourceReceipt & {
  encryptedPayload: string;
  lastAttemptAt: string;
};

export type SyncNextQuarantineInput = SyncNextSourceReceipt & {
  encryptedPayload: string;
};

/** Why one exact remote endpoint still owes a local feed entry. */
export type SyncNextDeliveryReason =
  | 'authorization-unresolved'
  | 'dependency'
  | 'quota'
  | 'remote-incomplete'
  | 'remote-rejected'
  | 'transport';

/** Retry state for one endpoint-specific outbound obligation. */
export type SyncNextDeliveryOutcome = {
  blockScope?: 'endpoint' | 'link';
  reason: SyncNextDeliveryReason;
  retryAt?: number;
};

/** Sparse outbound obligation; message and data remain in the local DWN. */
export type SyncNextDeliveryObligation = SyncNextLinkIdentity & SyncNextSourceReceipt & {
  lastAttemptAt: string;
  outcome: SyncNextDeliveryOutcome;
};

export type SyncNextDeliveryInput = SyncNextSourceReceipt & {
  outcome: SyncNextDeliveryOutcome;
};

export type SyncNextPullPageCommit = {
  handledThrough: ProgressToken;
  quarantine: SyncNextQuarantineInput[];
  settled: SyncNextSourceReceipt[];
};

export type SyncNextPushPageCommit = {
  delivery: SyncNextDeliveryInput[];
  handledThrough: ProgressToken;
  settled: SyncNextSourceReceipt[];
};
