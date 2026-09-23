import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { SyncAuthorization, SyncScope } from '../types/sync.js';

/** Exact identity shared by one link record and its sparse outcomes. */
export type SyncNextLinkIdentity = {
  authorizationEpoch: string;
  projectionId: string;
  remoteEndpoint: string;
  tenantDid: string;
};

/** Parameters required to create one exact next-engine link. */
export type SyncNextLinkCreate = SyncNextLinkIdentity & {
  authorization: SyncAuthorization;
  scope: SyncScope;
};

/** Durable progress and authority for one exact next-engine replication link. */
export type SyncNextLink = SyncNextLinkCreate & {
  pullHandledThrough?: ProgressToken;
  pushHandledThrough?: ProgressToken;
  status: 'active' | 'authorization-paused';
  updatedAt: string;
};

/** Exact source receipt represented by one sparse outcome. */
export type SyncNextSourceReceipt = {
  messageCid: string;
  source: ProgressToken;
};

/** Exact-source inbound input retained after pull progress advances. */
export type SyncNextQuarantineEntry = SyncNextLinkIdentity & SyncNextSourceReceipt & {
  attempts: number;
  encryptedPayload: string;
  lastAttemptAt: string;
};

/** Input staged for one atomic quarantine write. */
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
  retryAfter?: string;
};

/** Sparse outbound obligation; message and data remain in the local DWN. */
export type SyncNextDeliveryObligation = SyncNextLinkIdentity & SyncNextSourceReceipt & {
  attempts: number;
  lastAttemptAt: string;
  outcome: SyncNextDeliveryOutcome;
};

/** Input staged for one atomic delivery-obligation write. */
export type SyncNextDeliveryInput = SyncNextSourceReceipt & {
  outcome: SyncNextDeliveryOutcome;
};

/** Atomic pull-page ledger mutation. */
export type SyncNextPullPageCommit = {
  handledThrough: ProgressToken;
  quarantine: SyncNextQuarantineInput[];
  settled: SyncNextSourceReceipt[];
};

/** Atomic push-page ledger mutation. */
export type SyncNextPushPageCommit = {
  delivery: SyncNextDeliveryInput[];
  handledThrough: ProgressToken;
  settled: SyncNextSourceReceipt[];
};
