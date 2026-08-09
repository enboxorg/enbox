/**
 * Service-configuration announcements for prompt DWN endpoint reconciliation.
 *
 * The record published by this module is only a change notification. A consumer
 * must freshly resolve the owner's DID document before changing where it sends
 * DWN traffic; the announcement payload is never an alternate source of truth.
 *
 * @module
 */

import type { GenericMessage, ProtocolDefinition } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from './types/agent.js';

import { Time } from '@enbox/dwn-sdk-js';
import { Convert, logger } from '@enbox/common';
import { resolveDwnServiceEndpointUrls, validateDwnServiceEndpointUrls } from '@enbox/dids';

import { DwnInterface } from './types/dwn.js';

/** Protocol URI for DWN service-configuration announcements. */
export const SERVICE_CONFIG_PROTOCOL_URI = 'https://identity.foundation/protocols/service-config';

/** Schema URI for the service-configuration announcement payload. */
export const SERVICE_CONFIG_SCHEMA_URI = 'https://identity.foundation/schemas/service-config';

/** Protocol path of the single service-configuration record. */
export const SERVICE_CONFIG_PROTOCOL_PATH = 'serviceConfig';

const SERVICE_CONFIG_SEND_TIMEOUT_MS = 10_000;

/** Public hint carried by a service-configuration announcement. */
export type ServiceConfig = {
  /** Endpoints advertised by the DID document when the announcement was written. */
  dwnEndpoints: string[];

  /** ISO-8601 time at which the announcement was written. */
  updatedAt: string;
};

/**
 * Public, owner-written protocol used to announce that a DID document should
 * be re-resolved. Announcements are append-only initial writes so a newly added
 * DWN can accept the latest prompt without possessing an earlier record's history.
 */
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
      $actions: [
        { who: 'anyone', can: ['read'] },
      ],
    },
  },
} as const satisfies ProtocolDefinition;

type ServiceConfigProtocolMessage = {
  message: GenericMessage;
};

/** Configure the announcement protocol locally and return its signed message. */
async function ensureServiceConfigProtocol(
  agent: EnboxPlatformAgent,
  ownerDid: string,
): Promise<ServiceConfigProtocolMessage> {
  const { message, reply: { status } } = await agent.dwn.processRequest({
    author        : ownerDid,
    target        : ownerDid,
    messageType   : DwnInterface.ProtocolsConfigure,
    messageParams : { definition: ServiceConfigProtocolDefinition },
  });

  if ((status.code !== 202 && status.code !== 409) || message === undefined) {
    throw new Error(`Failed to configure service-config protocol: ${status.code} - ${status.detail}`);
  }

  return { message };
}

/**
 * Best-effort direct delivery. Configure the protocol before writing the
 * record so a newly-added DWN can accept the announcement immediately.
 */
async function fanOutServiceConfigRecord(params: {
  agent: EnboxPlatformAgent;
  ownerDid: string;
  protocolMessage: GenericMessage;
  recordMessage: GenericMessage;
  dataBytes: Uint8Array;
  endpoints: string[];
}): Promise<void> {
  const {
    agent, ownerDid, protocolMessage, recordMessage, dataBytes, endpoints,
  } = params;

  await Promise.allSettled(endpoints.map(async (dwnUrl) => {
    try {
      const protocolReply = await agent.rpc.sendDwnRequest({
        dwnUrl,
        targetDid : ownerDid,
        message   : protocolMessage,
        signal    : AbortSignal.timeout(SERVICE_CONFIG_SEND_TIMEOUT_MS),
      });
      if (protocolReply.status.code !== 202 && protocolReply.status.code !== 409) {
        throw new Error(`${protocolReply.status.code} - ${protocolReply.status.detail}`);
      }

      const recordReply = await agent.rpc.sendDwnRequest({
        dwnUrl,
        targetDid : ownerDid,
        message   : recordMessage,
        data      : new Blob([dataBytes as BlobPart], { type: 'application/json' }),
        signal    : AbortSignal.timeout(SERVICE_CONFIG_SEND_TIMEOUT_MS),
      });
      if (recordReply.status.code !== 202) {
        throw new Error(`${recordReply.status.code} - ${recordReply.status.detail}`);
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error(`Service-config announcement send to ${dwnUrl} failed: ${detail}`);
    }
  }));
}

/**
 * Publish a prompt indicating that consumers should freshly resolve a DID.
 *
 * The payload is always derived from the DID document through the agent's DID
 * resolver. `deliveryEndpoints` affects only best-effort transport and is useful
 * when an endpoint was just removed: both the former and current DWNs can receive
 * the signal, while neither is trusted as the authoritative endpoint set.
 */
export async function publishServiceConfig(params: {
  agent: EnboxPlatformAgent;
  ownerDid: string;
  deliveryEndpoints?: string[];
}): Promise<ServiceConfig> {
  const { agent, ownerDid, deliveryEndpoints = [] } = params;
  const dwnEndpoints = await resolveDwnServiceEndpointUrls(ownerDid, agent.did);
  const normalizedDeliveryEndpoints = deliveryEndpoints.length === 0
    ? []
    : validateDwnServiceEndpointUrls({ didUri: ownerDid, endpoints: deliveryEndpoints });
  const fanOutEndpoints = [...new Set([...normalizedDeliveryEndpoints, ...dwnEndpoints])];
  const config: ServiceConfig = {
    dwnEndpoints,
    updatedAt: Time.getCurrentTimestamp(),
  };

  const { message: protocolMessage } = await ensureServiceConfigProtocol(agent, ownerDid);
  const messageParams = {
    protocol     : SERVICE_CONFIG_PROTOCOL_URI,
    protocolPath : SERVICE_CONFIG_PROTOCOL_PATH,
    schema       : SERVICE_CONFIG_SCHEMA_URI,
    dataFormat   : 'application/json',
  };

  const dataBytes = Convert.object(config).toUint8Array();
  const { message: recordMessage, reply: { status } } = await agent.dwn.processRequest({
    author      : ownerDid,
    target      : ownerDid,
    messageType : DwnInterface.RecordsWrite,
    messageParams,
    dataStream  : new Blob([dataBytes as BlobPart], { type: 'application/json' }),
  });

  if (status.code !== 202 || recordMessage === undefined) {
    throw new Error(`Failed to write service-config record: ${status.code} - ${status.detail}`);
  }

  await fanOutServiceConfigRecord({
    agent,
    ownerDid,
    protocolMessage,
    recordMessage,
    dataBytes,
    endpoints: fanOutEndpoints,
  });

  return config;
}
