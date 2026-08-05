import type {
  DwnDataEncodedRecordsWriteMessage,
  DwnResponseStatus,
  EnboxAgent,
  SendDwnRequest,
} from '@enbox/agent';

import { Convert } from '@enbox/common';
import { DwnInterface } from '@enbox/agent';

/**
 * @internal Shared transport for the permission record wrappers: sends the
 * record's raw message to a remote DWN, defaulting the target to the
 * connected DID.
 */
export async function sendPermissionRecordMessage(input: {
  agent: EnboxAgent;
  connectedDid: string;
  message: DwnDataEncodedRecordsWriteMessage;
  target?: string;
}): Promise<DwnResponseStatus> {
  const { encodedData, ...rawMessage } = input.message;
  const dataStream = new Blob([ Convert.base64Url(encodedData).toUint8Array() as BlobPart ]);

  const sendRequestOptions: SendDwnRequest<DwnInterface.RecordsWrite> = {
    messageType : DwnInterface.RecordsWrite,
    author      : input.connectedDid,
    target      : input.target ?? input.connectedDid,
    dataStream,
    rawMessage,
  };

  // Send the current/latest state to the target.
  const { reply } = await input.agent.sendDwnRequest(sendRequestOptions);
  return reply;
}

/**
 * @internal Shared transport for the permission record wrappers: processes
 * the record's raw message against the connected DID's local DWN and returns
 * the reply status along with the stored message for handle refresh.
 */
export async function storePermissionRecordMessage(input: {
  agent: EnboxAgent;
  connectedDid: string;
  message: DwnDataEncodedRecordsWriteMessage;
  signAsOwner?: boolean;
  store?: boolean;
}): Promise<{ message: DwnDataEncodedRecordsWriteMessage; status: DwnResponseStatus }> {
  const { encodedData, ...rawMessage } = input.message;
  const dataStream = new Blob([ Convert.base64Url(encodedData).toUint8Array() as BlobPart ]);

  const { reply, message } = await input.agent.processDwnRequest({
    author      : input.connectedDid,
    target      : input.connectedDid,
    messageType : DwnInterface.RecordsWrite,
    signAsOwner : input.signAsOwner,
    store       : input.store,
    rawMessage,
    dataStream,
  });

  return {
    message : { ...message, encodedData } as DwnDataEncodedRecordsWriteMessage,
    status  : { status: reply.status },
  };
}
