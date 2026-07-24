import type { DwnInterface, ProcessDwnRequest } from '@enbox/agent';

import type { RecordDataAccess } from './record-types.js';

/** Captures the authorization and routing context used for stored record data access. */
export function captureRecordDataAccess<T extends DwnInterface>(
  request: ProcessDwnRequest<T>,
  remote: boolean,
): RecordDataAccess {
  const messageParams = request.messageParams as { delegatedGrant?: RecordDataAccess['delegatedGrant'] } | undefined;
  return {
    author : request.author,
    remote,
    target : request.target,
    ...(request.granteeDid === undefined ? {} : { granteeDid: request.granteeDid }),
    ...(messageParams?.delegatedGrant === undefined ? {} : { delegatedGrant: messageParams.delegatedGrant }),
  };
}
