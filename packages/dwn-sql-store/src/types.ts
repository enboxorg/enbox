import type { Generated } from 'kysely';
import type { KeyValues } from '@enbox/dwn-sdk-js';

export type { KeyValues };

type MessageStoreTable = {
  id: Generated<number>;
  tenant: string;
  messageCid: string;
  encodedMessageBytes: Uint8Array;
  encodedData: string | null;
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
  // "indexes" end
};

type MessageStoreRecordsTagsTable = {
  id: Generated<number>;
  tag: string;
  messageInsertId: number;
  valueString: string | null;
  valueNumber: number | null;
};

// ─── StateIndex SMT tables ────────────────────────────────────────────────

type StateIndexNodeTable = {
  tenant: string;
  scope: string;
  nodeHash: string;
  nodeType: string;
  leftHash: string | null;
  rightHash: string | null;
  leafKeyHash: string | null;
  leafValueCid: string | null;
};

type StateIndexRootTable = {
  tenant: string;
  scope: string;
  rootHash: string;
};

type StateIndexMetaTable = {
  tenant: string;
  messageCid: string;
  protocol: string;
};

type DataStoreTable = {
  id: Generated<number>;
  tenant: string;
  recordId: string;
  dataCid: string;
  data: Uint8Array;
};

type ResumableTaskTable = {
  id: string;
  task: string;
  timeout: number;
  retryCount: number;
};

export type DwnDatabaseType = {
  messageStoreMessages: MessageStoreTable;
  messageStoreRecordsTags: MessageStoreRecordsTagsTable;
  dataStore: DataStoreTable;
  resumableTasks: ResumableTaskTable;
  stateIndexNodes: StateIndexNodeTable;
  stateIndexRoots: StateIndexRootTable;
  stateIndexMeta: StateIndexMetaTable;
};