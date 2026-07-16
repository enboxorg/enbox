/**
 * Service configuration announcement.
 *
 * A standardized, near-real-time trigger that lets a connected app learn that
 * an identity's DWN service endpoints changed — without a disconnect/reconnect
 * cycle. The DID document remains the single source of truth for the endpoint
 * set; the announcement record is only a "poke" that tells observers to
 * re-resolve the DID document now instead of waiting out their resolver-cache
 * TTL.
 *
 * The mechanism rides entirely on facilities that already exist between a
 * wallet and a connected app:
 *
 * - The wallet (owner) writes/updates a single {@link ServiceConfig} record
 *   under the {@link ServiceConfigProtocolDefinition} on its own DWN whenever
 *   its endpoints change (see {@link publishServiceConfig}).
 * - The protocol is `published: true` with an `anyone can read` action, so any
 *   connected app can observe the record — connect never issues
 *   `Records.Subscribe` grants, so observers subscribe as the delegate and read
 *   the public record.
 * - A connected app that requested this protocol receives the standard
 *   `Messages.Read` grant, so the record replicates into its local DWN via sync
 *   and a local subscription fires. The app then forces a fresh DID resolution
 *   (`agent.identity.refreshDwnEndpoints`).
 *
 * @module
 */

import type { ProtocolDefinition, RecordsQueryReplyEntry } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from './types/agent.js';

import { Time } from '@enbox/dwn-sdk-js';
import { Convert, logger } from '@enbox/common';

import { DwnInterface } from './types/dwn.js';

/** Protocol URI for the DWN service-configuration announcement. */
export const SERVICE_CONFIG_PROTOCOL_URI = 'https://identity.foundation/protocols/service-config';

/** Schema URI for the {@link ServiceConfig} record. */
export const SERVICE_CONFIG_SCHEMA_URI = 'https://identity.foundation/schemas/service-config';

/** Protocol path of the single service-config record. */
export const SERVICE_CONFIG_PROTOCOL_PATH = 'serviceConfig';

/** Per-endpoint abort budget for best-effort announcement fan-out. */
const SERVICE_CONFIG_SEND_TIMEOUT_MS = 10_000;

/**
 * Payload of a service-config announcement record.
 *
 * Endpoint URLs are already public (they live in the DID document), so the
 * record is written in plaintext. Observers should treat `dwnEndpoints` as a
 * hint and re-resolve the DID document for the authoritative set.
 */
export type ServiceConfig = {
  /** The DWN service endpoint URLs advertised by the DID document at publish time. */
  dwnEndpoints: string[];

  /** ISO-8601 timestamp of when this configuration was published. */
  updatedAt: string;
};

/**
 * The DWN protocol carrying service-configuration announcements.
 *
 * `published: true` with an `anyone can read` action so any connected app can
 * observe the record; the owner is the only writer (no write action is granted
 * to anyone else), which keeps the announcement authenticated without adding a
 * new trust surface — the DID document, not this record, is authoritative.
 */
export const ServiceConfigProtocolDefinition: ProtocolDefinition = {
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
      $recordLimit : { max: 1, strategy: 'reject' },
      $actions     : [
        { who: 'anyone', can: ['read'] },
      ],
    },
  },
};

/**
 * Installs the service-config protocol on the owner's DWN if it is not already
 * configured. Idempotent: a `ProtocolsConfigure` for an unchanged definition is
 * accepted, so this is safe to call on every publish.
 */
async function ensureServiceConfigProtocol(agent: EnboxPlatformAgent, ownerDid: string): Promise<void> {
  const { reply: { status } } = await agent.dwn.processRequest({
    author        : ownerDid,
    target        : ownerDid,
    messageType   : DwnInterface.ProtocolsConfigure,
    messageParams : { definition: ServiceConfigProtocolDefinition },
  });

  // 202 (configured) and 409 (already configured / no change) are both success.
  if (status.code !== 202 && status.code !== 409) {
    throw new Error(`Failed to configure service-config protocol: ${status.code} - ${status.detail}`);
  }
}

/** Reads the single existing service-config record, if any. */
async function getExistingServiceConfigRecord(
  agent: EnboxPlatformAgent,
  ownerDid: string,
): Promise<RecordsQueryReplyEntry | undefined> {
  const { reply: { entries } } = await agent.dwn.processRequest({
    author        : ownerDid,
    target        : ownerDid,
    messageType   : DwnInterface.RecordsQuery,
    messageParams : {
      filter: {
        protocol     : SERVICE_CONFIG_PROTOCOL_URI,
        protocolPath : SERVICE_CONFIG_PROTOCOL_PATH,
      },
    },
  });

  return entries?.[0];
}

/**
 * Best-effort delivery of the announcement record to every remote DWN endpoint
 * of the owner, so connected apps replicate it promptly via sync. Failures are
 * tolerated — sync reconciles any endpoint the direct send missed.
 */
async function fanOutServiceConfigRecord(
  agent: EnboxPlatformAgent,
  ownerDid: string,
  message: unknown,
  dataBytes: Uint8Array,
): Promise<void> {
  let endpoints: string[] = [];
  try {
    endpoints = await agent.dwn.getRemoteDwnEndpointUrls(ownerDid);
  } catch {
    // No resolvable remote endpoints — the local write plus sync is the only
    // delivery path. Nothing to fan out to.
    return;
  }

  await Promise.allSettled(endpoints.map(async (dwnUrl) => {
    try {
      await agent.rpc.sendDwnRequest({
        dwnUrl,
        targetDid : ownerDid,
        message,
        data      : new Blob([dataBytes as BlobPart], { type: 'application/json' }),
        signal    : AbortSignal.timeout(SERVICE_CONFIG_SEND_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error(`Service-config announcement send to ${dwnUrl} failed: ${detail}`);
    }
  }));
}

/**
 * Publishes (creates or updates) the owner identity's service-config
 * announcement record from its current DWN endpoint set, then best-effort fans
 * it out to the owner's remote DWN endpoints.
 *
 * The caller is expected to have already updated (and, for did:dht,
 * re-published) the DID document. This announcement is the prompt signal that
 * lets connected apps observe the change without waiting for their resolver
 * cache to expire.
 *
 * @param agent    - The agent that manages `ownerDid`.
 * @param ownerDid - The identity whose service configuration changed.
 * @returns The published {@link ServiceConfig}.
 */
export async function publishServiceConfig(
  agent: EnboxPlatformAgent,
  ownerDid: string,
): Promise<ServiceConfig> {
  const dwnEndpoints = await agent.dwn.getRemoteDwnEndpointUrls(ownerDid).catch((): string[] => []);
  const config: ServiceConfig = {
    dwnEndpoints,
    updatedAt: Time.getCurrentTimestamp(),
  };

  await ensureServiceConfigProtocol(agent, ownerDid);

  const existing = await getExistingServiceConfigRecord(agent, ownerDid);

  const messageParams: {
    protocol: string;
    protocolPath: string;
    schema: string;
    dataFormat: string;
    recordId?: string;
    dateCreated?: string;
  } = {
    protocol     : SERVICE_CONFIG_PROTOCOL_URI,
    protocolPath : SERVICE_CONFIG_PROTOCOL_PATH,
    schema       : SERVICE_CONFIG_SCHEMA_URI,
    dataFormat   : 'application/json',
  };

  // `$recordLimit: { max: 1 }` rejects a second create — update the existing
  // record in place (same recordId, preserving the immutable dateCreated). A
  // `RecordsQuery` entry carries the RecordsWrite fields at the top level.
  if (existing !== undefined) {
    messageParams.recordId = existing.recordId;
    messageParams.dateCreated = existing.descriptor.dateCreated;
  }

  const dataBytes = Convert.object(config).toUint8Array();
  const { message, reply: { status } } = await agent.dwn.processRequest({
    author      : ownerDid,
    target      : ownerDid,
    messageType : DwnInterface.RecordsWrite,
    messageParams,
    dataStream  : new Blob([dataBytes as BlobPart], { type: 'application/json' }),
  });

  if (status.code !== 202) {
    throw new Error(`Failed to write service-config record: ${status.code} - ${status.detail}`);
  }

  await fanOutServiceConfigRecord(agent, ownerDid, message, dataBytes);

  return config;
}
