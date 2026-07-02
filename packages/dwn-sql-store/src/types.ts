import type { Generated } from 'kysely';
import type { KeyValues } from '@enbox/dwn-sdk-js';

export type { KeyValues };

type MessageStoreTable = {
  id: Generated<number>;
  tenant: string;
  messageCid: string;
  encodedMessageBytes: Uint8Array;
  encodedData: string | null;
  seq: string | null;
  fingerprintScopes: string | null;
  // "indexes" start
  interface: string | null;
  method: string | null;
  schema: string | null;
  dataCid: string | null;
  dataSize: number | null;
  dateCreated: string | null;
  messageTimestamp: string | null;
  dataFormat: string | null;
  isLatestBaseState: boolean | null;
  published: boolean | null;
  author: string | null;
  recordId: string | null;
  entryId: string | null;
  datePublished: string | null;
  protocol: string | null;
  attester: string | null;
  protocolPath: string | null;
  recipient: string | null;
  contextId: string | null;
  parentId: string | null;
  permissionGrantId: string | null;
  prune: boolean | null;
  squash: boolean | null;
  controlClass: string | null;
  roleAudienceHash: string | null;
  recipientHash: string | null;
  // "indexes" end
};

type MessageStoreRecordsTagsTable = {
  id: Generated<number>;
  tag: string;
  messageInsertId: number;
  valueString: string | null;
  valueNumber: number | null;
};

// ─── DataStore tables (legacy + content-addressed) ────────────────────────

/**
 * @deprecated Legacy monolithic data table. Replaced by `dataRefs` + `dataBlocks`
 * in migration 002. Retained for type compatibility during migration.
 */
type DataStoreTable = {
  id: Generated<number>;
  tenant: string;
  recordId: string;
  dataCid: string;
  data: Uint8Array;
};

/**
 * Reference table linking (tenant, recordId) to a content-addressed dataCid.
 * Multiple tenant/record pairs can reference the same dataCid for dedup.
 */
type DataRefsTable = {
  tenant: string;
  recordId: string;
  dataCid: string;
  dataSize: number;
};

/**
 * Content storage table holding individual DAG-PB blocks (~256KB each)
 * keyed by (rootDataCid, blockCid). Shared across all refs to the same dataCid.
 */
type DataBlocksTable = {
  rootDataCid: string;
  blockCid: string;
  data: Uint8Array;
};

type ResumableTaskTable = {
  id: string;
  task: string;
  timeout: number;
  retryCount: number;
};

type ReplicationCounterTable = {
  tenant: string;
  seq: string;
};

type ReplicationFingerprintTable = {
  tenant: string;
  scope: string;
  fingerprint: string;
};

type ReplicationMetaTable = {
  key: string;
  value: string;
};

export type DwnDatabaseType = {
  messageStoreMessages: MessageStoreTable;
  messageStoreRecordsTags: MessageStoreRecordsTagsTable;
  dataStore: DataStoreTable;
  dataRefs: DataRefsTable;
  dataBlocks: DataBlocksTable;
  resumableTasks: ResumableTaskTable;
  replicationCounters: ReplicationCounterTable;
  replicationFingerprints: ReplicationFingerprintTable;
  replicationMeta: ReplicationMetaTable;
};
