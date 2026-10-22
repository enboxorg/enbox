import type { Record, RecordModel } from '@enbox/api';

declare const handle: Record;

const handleModel: RecordModel = handle;
const snapshot: RecordModel = handle.toJSON();
const authorization: Record['authorization'] = snapshot.authorization;
const created: string = snapshot.dateCreated;
const cid: string | undefined = snapshot.dataCid;
const deleted: RecordModel = {
  author        : 'did:example:owner',
  authorization : handle.authorization,
  dateCreated   : '2026-01-01T00:00:00.000000Z',
  dataCid       : undefined,
  dataFormat    : undefined,
  dataSize      : undefined,
  protocol      : undefined,
  protocolPath  : undefined,
  contextId     : undefined,
};

// @ts-expect-error deleted records do not guarantee payload metadata
const requiredCid: string = snapshot.dataCid;
// @ts-expect-error creation metadata remains required
const missingCreation: RecordModel = { author: 'did:example:owner', authorization: handle.authorization };
// @ts-expect-error authorization remains required for write and delete records
const missingAuthorization: RecordModel = { author: 'did:example:owner', dateCreated: created };

void handleModel;
void authorization;
void created;
void cid;
void deleted;
void requiredCid;
void missingCreation;
void missingAuthorization;
