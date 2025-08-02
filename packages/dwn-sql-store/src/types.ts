import type { Generated } from 'kysely';

export type KeyValues = { [key:string]: string | number | boolean | string[] | number[] };

type EventLogTable = {
  watermark: Generated<number>;
  tenant: string;
  messageCid: string;

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
  latest: string | null;
  protocol: string | null;
  permissionsRequestId: string | null;
  attester: string | null;
  protocolPath: string | null;
  recipient: string | null;
  contextId: string | null;
  parentId: string | null;
  permissionGrantId: string | null;
  prune: boolean | null;
  // "indexes" end
}

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
  permissionsRequestId: string | null;
  attester: string | null;
  protocolPath: string | null;
  recipient: string | null;
  contextId: string | null;
  parentId: string | null;
  permissionGrantId: string | null;
  prune: boolean | null;
  // "indexes" end
}

type MessageStoreRecordsTagsTable = {
  id: Generated<number>;
  tag: string;
  messageInsertId: number;
  valueString: string | null;
  valueNumber: number | null;
};

type EventLogRecordsTagsTable = {
  id: Generated<number>;
  tag: string;
  eventWatermark: number;
  valueString: string | null;
  valueNumber: number | null;
};

type DataStoreTable = {
  id: Generated<number>;
  tenant: string;
  recordId: string;
  dataCid: string;
  data: Uint8Array;
}

type ResumableTaskTable = {
  id: string;
  task: string;
  timeout: number;
  retryCount: number;
}

export type DwnDatabaseType = {
  eventLogMessages: EventLogTable;
  eventLogRecordsTags: EventLogRecordsTagsTable;
  messageStoreMessages: MessageStoreTable;
  messageStoreRecordsTags: MessageStoreRecordsTagsTable;
  dataStore: DataStoreTable;
  resumableTasks: ResumableTaskTable;
}