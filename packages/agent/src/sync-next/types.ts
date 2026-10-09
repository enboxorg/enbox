import type { MessagesQueryReplyEntry, ProgressToken } from '@enbox/dwn-sdk-js';

import type { SyncAuthorization, SyncScope } from '../types/sync.js';

/** Exact identity shared by one link record and its pending work. */
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
  /** Changes whenever the same exact link key is retired and recreated. */
  lifetimeId: string;
  pullCheckpoint?: ProgressToken;
  pushCheckpoint?: ProgressToken;
  updatedAt: string;
};

export type SyncNextSourceReceipt = {
  messageCid: string;
  source: ProgressToken;
};

/** Exact-source inbound input retained after pull progress advances. */
export type SyncNextQuarantineEntry = SyncNextLinkIdentity & SyncNextSourceReceipt & {
  entry: MessagesQueryReplyEntry;
  entrySize: number;
  lastAttemptAt: string;
};

export type SyncNextQuarantineInput = SyncNextSourceReceipt & {
  entry: MessagesQueryReplyEntry;
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

/** Pending outbound obligation; message and data remain in the local DWN. */
export type SyncNextDeliveryObligation = SyncNextLinkIdentity & SyncNextSourceReceipt & {
  lastAttemptAt: string;
  outcome: SyncNextDeliveryOutcome;
  /** Write lineage used only after a newer current RecordsWrite is handled by this link. */
  writeRecordId?: string;
  /** Source feed state at intake; a current write must not be replayed without its body. */
  wasLatestBaseState: boolean;
};

export type SyncNextDeliveryInput = SyncNextSourceReceipt & {
  outcome: SyncNextDeliveryOutcome;
  writeRecordId?: string;
  wasLatestBaseState: boolean;
};

/** A current RecordsWrite receipt handled by the remote endpoint. */
export type SyncNextHandledWrite = {
  recordId: string;
  receipt: SyncNextSourceReceipt;
};

export type SyncNextPullPageCommit = {
  checkpoint: ProgressToken;
  /** Exact receipts from the page, captured before classifying its entries. */
  pageReceipts: SyncNextSourceReceipt[];
  quarantine: SyncNextQuarantineInput[];
  settled: SyncNextSourceReceipt[];
};

export type SyncNextPushPageCommit = {
  delivery: SyncNextDeliveryInput[];
  checkpoint: ProgressToken;
  handledWrites: SyncNextHandledWrite[];
  /** Exact receipts from the page, captured before classifying its entries. */
  pageReceipts: SyncNextSourceReceipt[];
  settled: SyncNextSourceReceipt[];
};
