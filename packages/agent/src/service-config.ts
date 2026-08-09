import type { GenericMessage, ProtocolDefinition } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from './types/agent.js';
import type { SyncEvent } from './types/sync.js';

import { Convert } from '@enbox/common';
import { DwnInterfaceName, DwnMethodName, Time } from '@enbox/dwn-sdk-js';

import { DwnInterface } from './types/dwn.js';

/** Protocol URI for the endpoint-change wake record. */
export const SERVICE_CONFIG_PROTOCOL_URI = 'https://identity.foundation/protocols/service-config';

/** Schema URI for the endpoint-change wake record. */
export const SERVICE_CONFIG_SCHEMA_URI = 'https://identity.foundation/schemas/service-config';

/** Protocol path for the endpoint-change wake record. */
export const SERVICE_CONFIG_PROTOCOL_PATH = 'serviceConfig';

const SERVICE_CONFIG_SEND_TIMEOUT_MS = 10_000;

/** A prompt to freshly resolve the owner's DID document. */
export type ServiceConfigNotice = {
  updatedAt: string;
};

/** Public, owner-written protocol for endpoint-change wake records. */
export const ServiceConfigProtocolDefinition = {
  protocol  : SERVICE_CONFIG_PROTOCOL_URI,
  published : true,
  types     : {
    serviceConfig: {
      schema      : SERVICE_CONFIG_SCHEMA_URI,
      dataFormats : ['application/json'],
    },
  },
  structure: {
    serviceConfig: {
      $actions: [{ who: 'anyone', can: ['read'] }],
    },
  },
} as const satisfies ProtocolDefinition;

/** Whether a sync event is an owner-authored service-config wake for one tenant. */
export function isServiceConfigNoticeDelivery(event: SyncEvent, tenantDid: string): boolean {
  return event.type === 'delivery:applied'
    && event.tenantDid === tenantDid
    && event.descriptor.interface === DwnInterfaceName.Records
    && event.descriptor.method === DwnMethodName.Write
    && event.descriptor.protocol === SERVICE_CONFIG_PROTOCOL_URI
    && event.descriptor.protocolPath === SERVICE_CONFIG_PROTOCOL_PATH
    && event.descriptor.author === tenantDid;
}

async function sendNotice(params: {
  agent: EnboxPlatformAgent;
  data: Blob;
  endpoint: string;
  ownerDid: string;
  protocolMessage: GenericMessage;
  recordMessage: GenericMessage;
}): Promise<void> {
  const { agent, data, endpoint, ownerDid, protocolMessage, recordMessage } = params;
  const signal = AbortSignal.timeout(SERVICE_CONFIG_SEND_TIMEOUT_MS);
  const protocolReply = await agent.rpc.sendDwnRequest({
    dwnUrl    : endpoint,
    targetDid : ownerDid,
    message   : protocolMessage,
    signal,
  });
  if (protocolReply.status.code !== 202 && protocolReply.status.code !== 409) {
    throw new Error(`Service-config protocol rejected: ${protocolReply.status.code} - ${protocolReply.status.detail}`);
  }

  const recordReply = await agent.rpc.sendDwnRequest({
    data,
    dwnUrl    : endpoint,
    targetDid : ownerDid,
    message   : recordMessage,
    signal,
  });
  if (recordReply.status.code !== 202) {
    throw new Error(`Service-config notice rejected: ${recordReply.status.code} - ${recordReply.status.detail}`);
  }
}

/**
 * Write an append-only endpoint-change wake and best-effort deliver it to the
 * former and current DWNs. The notice is not configuration; readers must
 * freshly resolve the DID document.
 *
 * @internal
 */
export async function publishServiceConfigNotice(params: {
  agent: EnboxPlatformAgent;
  currentEndpoints: string[];
  formerEndpoints: string[];
  ownerDid: string;
}): Promise<ServiceConfigNotice> {
  const { agent, currentEndpoints, formerEndpoints, ownerDid } = params;
  const notice: ServiceConfigNotice = { updatedAt: Time.getCurrentTimestamp() };

  const { message: protocolMessage, reply: protocolReply } = await agent.dwn.processRequest({
    author        : ownerDid,
    target        : ownerDid,
    messageType   : DwnInterface.ProtocolsConfigure,
    messageParams : { definition: ServiceConfigProtocolDefinition },
  });
  if ((protocolReply.status.code !== 202 && protocolReply.status.code !== 409) || protocolMessage === undefined) {
    throw new Error(
      `Service-config protocol could not be configured: ${protocolReply.status.code} - ${protocolReply.status.detail}`
    );
  }

  const dataBytes = Convert.object(notice).toUint8Array();
  const data = new Blob([dataBytes as BlobPart], { type: 'application/json' });
  const { message: recordMessage, reply: recordReply } = await agent.dwn.processRequest({
    author        : ownerDid,
    target        : ownerDid,
    messageType   : DwnInterface.RecordsWrite,
    messageParams : {
      protocol     : SERVICE_CONFIG_PROTOCOL_URI,
      protocolPath : SERVICE_CONFIG_PROTOCOL_PATH,
      schema       : SERVICE_CONFIG_SCHEMA_URI,
      dataFormat   : 'application/json',
    },
    dataStream: data,
  });
  if (recordReply.status.code !== 202 || recordMessage === undefined) {
    throw new Error(`Service-config notice could not be written: ${recordReply.status.code} - ${recordReply.status.detail}`);
  }

  const endpoints = [...new Set([...formerEndpoints, ...currentEndpoints])];
  await Promise.allSettled(endpoints.map(async (endpoint): Promise<void> => sendNotice({
    agent,
    data,
    endpoint,
    ownerDid,
    protocolMessage,
    recordMessage,
  })));

  return notice;
}
