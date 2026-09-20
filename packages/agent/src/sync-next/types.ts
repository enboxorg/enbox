import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { SyncAuthorization, SyncDirection, SyncScope } from '../types/sync.js';

/** Durable schema version for the isolated next-engine ledger. */
export const SYNC_NEXT_LEDGER_VERSION = 1 as const;

/** Exact identity shared by one link record and its sparse outcomes. */
export type SyncNextLinkIdentity = {
  authorizationEpoch: string;
  projectionId: string;
  remoteEndpoint: string;
  tenantDid: string;
};

/** Parameters required to create one exact next-engine link. */
export type SyncNextLinkCreate = {
  authorization: SyncAuthorization;
  authorizationEpoch: string;
  delegateDid?: string;
  logicalTargetId: string;
  projectionId: string;
  remoteEndpoint: string;
  scope: SyncScope;
  tenantDid: string;
};

/** Durable progress and authority for one exact next-engine replication link. */
export type SyncNextLink = SyncNextLinkIdentity & {
  authorization: SyncAuthorization;
  createdAt: string;
  delegateDid?: string;
  logicalTargetId: string;
  pullHandledThrough?: ProgressToken;
  pushHandledThrough?: ProgressToken;
  scope: SyncScope;
  status: 'active' | 'authorization-paused';
  updatedAt: string;
  version: typeof SYNC_NEXT_LEDGER_VERSION;
};

/** Exact source receipt represented by one sparse outcome. */
export type SyncNextSourceReceipt = {
  messageCid: string;
  source: ProgressToken;
};

/** Why received input is not materialized in the local DWN yet. */
export type SyncNextQuarantineReason =
  | 'authorization-unresolved'
  | 'data'
  | 'dependency'
  | 'resolver-unavailable'
  | 'storage';

/** Retry state retained with encrypted received input. */
export type SyncNextQuarantineOutcome = {
  detail?: string;
  missingReferences?: string[];
  reason: SyncNextQuarantineReason;
};

/** Exact-source inbound input retained after pull progress advances. */
export type SyncNextQuarantineEntry = SyncNextLinkIdentity & SyncNextSourceReceipt & {
  attempts: number;
  encryptedPayload: string;
  firstPendingAt: string;
  lastAttemptAt: string;
  logicalTargetId: string;
  outcome: SyncNextQuarantineOutcome;
  version: typeof SYNC_NEXT_LEDGER_VERSION;
};

/** Input staged for one atomic quarantine write. */
export type SyncNextQuarantineInput = SyncNextSourceReceipt & {
  encryptedPayload: string;
  outcome: SyncNextQuarantineOutcome;
};

/** Why one exact remote endpoint still owes a local feed entry. */
export type SyncNextDeliveryReason =
  | 'ambiguous'
  | 'authorization-unresolved'
  | 'dependency'
  | 'quota'
  | 'remote-incomplete'
  | 'transport';

/** Retry state for one endpoint-specific outbound obligation. */
export type SyncNextDeliveryOutcome = {
  detail?: string;
  reason: SyncNextDeliveryReason;
  retryAfter?: string;
};

/** Sparse outbound obligation; message and data remain in the local DWN. */
export type SyncNextDeliveryObligation = SyncNextLinkIdentity & SyncNextSourceReceipt & {
  attempts: number;
  firstPendingAt: string;
  lastAttemptAt: string;
  logicalTargetId: string;
  outcome: SyncNextDeliveryOutcome;
  version: typeof SYNC_NEXT_LEDGER_VERSION;
};

/** Input staged for one atomic delivery-obligation write. */
export type SyncNextDeliveryInput = SyncNextSourceReceipt & {
  outcome: SyncNextDeliveryOutcome;
};

/** Precise non-retryable or explicitly abandoned outcome for one source entry. */
export type SyncNextTerminalOutcome = SyncNextLinkIdentity & SyncNextSourceReceipt & {
  code: string;
  detail?: string;
  direction: SyncDirection;
  failedAt: string;
  logicalTargetId: string;
  version: typeof SYNC_NEXT_LEDGER_VERSION;
};

/** Input staged for one atomic terminal-outcome write. */
export type SyncNextTerminalInput = SyncNextSourceReceipt & {
  code: string;
  detail?: string;
};

/** Exact sparse receipt that can be removed after a verified success. */
export type SyncNextSettledSource = SyncNextSourceReceipt;

/** Atomic pull-page ledger mutation. */
export type SyncNextPullPageCommit = {
  handledThrough: ProgressToken;
  quarantine: SyncNextQuarantineInput[];
  settled: SyncNextSettledSource[];
  terminal: SyncNextTerminalInput[];
};

/** Atomic push-page ledger mutation. */
export type SyncNextPushPageCommit = {
  delivery: SyncNextDeliveryInput[];
  handledThrough: ProgressToken;
  settled: SyncNextSettledSource[];
  terminal: SyncNextTerminalInput[];
};
