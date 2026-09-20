import type { DidDocument, DidResolutionResult } from '@enbox/dids';
import type { LabCheck, LabProofReport } from '../proof-result.js';

import { createHash } from 'node:crypto';
import { createProofReport } from '../proof-result.js';
import { DidDht } from '@enbox/dids';
import { startPkarrPublicationServer } from '../pkarr-publication-server.js';

export type DidPersistenceProofOptions = {
  adapterPort?: number;
  advertisedDwnEndpoint: string;
  journalLocation: string;
  now?: () => Date;
  recreateUpstream(): Promise<string>;
  requestTimeoutMs?: number;
  upstreamBaseUrl: string;
};

function resolvedDocument(result: DidResolutionResult): DidDocument | undefined {
  return result.didResolutionMetadata.error === undefined && result.didDocument !== null
    ? result.didDocument
    : undefined;
}

function documentsEqual(left: DidDocument | undefined, right: DidDocument): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

async function readSignedPacket(adapterEndpoint: string, didUri: string, requestTimeoutMs: number): Promise<Uint8Array> {
  const identifier = didUri.split(':').at(-1);
  if (identifier === undefined || identifier.length === 0) {
    throw new Error(`Unable to derive the Pkarr identifier from '${didUri}'.`);
  }
  const response = await fetch(new URL(identifier, adapterEndpoint), {
    redirect : 'error',
    signal   : AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Unable to read the signed Pkarr packet: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function packetHash(packet: Uint8Array): string {
  return createHash('sha256').update(packet).digest('hex');
}

/**
 * Publishes through the durable adapter, recreates the upstream private testnet, and proves replay
 * without invoking the publisher again. Network-only cache bypass remains a separate explicit gate.
 */
export async function runDidPersistenceProof(options: DidPersistenceProofOptions): Promise<LabProofReport> {
  const now = options.now ?? ((): Date => new Date());
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const startedAt = now();
  const checks: LabCheck[] = [];
  const firstAdapter = await startPkarrPublicationServer({
    journalLocation : options.journalLocation,
    port            : options.adapterPort,
    requestTimeoutMs,
    upstreamBaseUrl : options.upstreamBaseUrl,
  });

  let didUri = '';
  let expectedDocument: DidDocument | undefined;
  let originalPacketHash = '';
  try {
    const did = await DidDht.create({
      options: {
        publish  : false,
        services : [{
          id              : 'dwn',
          serviceEndpoint : options.advertisedDwnEndpoint,
          type            : 'DecentralizedWebNode',
        }],
      },
    });
    didUri = did.uri;
    const publication = await DidDht.publish({
      allowPrivateGatewayUri : true,
      did,
      gatewayUri             : firstAdapter.endpoint,
    });
    const beforeRestart = await DidDht.resolve(didUri, {
      allowPrivateGatewayUri : true,
      gatewayUri             : firstAdapter.endpoint,
    });
    originalPacketHash = packetHash(await readSignedPacket(firstAdapter.endpoint, didUri, requestTimeoutMs));
    expectedDocument = resolvedDocument(beforeRestart);

    checks.push({
      details: {
        didUri,
        versionId: publication.didDocumentMetadata.versionId ?? '',
      },
      id      : 'A07-acknowledged-publication',
      status  : publication.didDocumentMetadata.published === true ? 'pass' : 'fail',
      summary : publication.didDocumentMetadata.published === true
        ? 'The upstream-accepted publication was durably acknowledged by the adapter'
        : 'The DID publication was not acknowledged',
    });
    checks.push({
      details : { resolutionError: String(beforeRestart.didResolutionMetadata.error ?? '') },
      id      : 'A06-private-resolution-before-restart',
      status  : expectedDocument?.id === didUri ? 'pass' : 'fail',
      summary : expectedDocument?.id === didUri
        ? 'The published DID resolved through the private upstream before recreation'
        : 'The published DID did not resolve to its expected document before recreation',
    });
  } finally {
    await firstAdapter.stop();
  }

  const recreatedUpstream = await options.recreateUpstream();
  const secondAdapter = await startPkarrPublicationServer({
    journalLocation : options.journalLocation,
    port            : options.adapterPort,
    requestTimeoutMs,
    upstreamBaseUrl : recreatedUpstream,
  });
  try {
    const afterRestart = await DidDht.resolve(didUri, {
      allowPrivateGatewayUri : true,
      gatewayUri             : secondAdapter.endpoint,
    });
    const restoredPacketHash = packetHash(await readSignedPacket(secondAdapter.endpoint, didUri, requestTimeoutMs));
    const restored = secondAdapter.restoreResults.length === 1 &&
      secondAdapter.restoreResults[0].status === 'restored' &&
      originalPacketHash.length > 0 && originalPacketHash === restoredPacketHash;
    checks.push({
      details: {
        originalPacketHash,
        restoredPacketHash,
        restoreResults: JSON.stringify(secondAdapter.restoreResults),
      },
      id      : 'A07-signed-packet-restoration',
      status  : restored ? 'pass' : 'fail',
      summary : restored
        ? 'The recreated upstream accepted the exact journaled signed packet without publisher participation'
        : 'The signed publication was not restored after upstream recreation',
    });
    checks.push({
      details : { resolutionError: String(afterRestart.didResolutionMetadata.error ?? '') },
      id      : 'A08-resolution-after-restoration',
      status  : expectedDocument !== undefined && documentsEqual(resolvedDocument(afterRestart), expectedDocument) ? 'pass' : 'fail',
      summary : expectedDocument !== undefined && documentsEqual(resolvedDocument(afterRestart), expectedDocument)
        ? 'The DID resolved to the expected document after restoration'
        : 'The restored DID did not resolve to the expected document',
    });
    checks.push({
      id      : 'A09-network-only-cache-bypass',
      status  : 'unsupported',
      summary : 'The pinned upstream still needs a cache-bypassing network-only lookup proof',
    });
  } finally {
    await secondAdapter.stop();
  }

  return createProofReport({
    checks,
    finishedAt : now(),
    proof      : 'p0-did-persistence',
    startedAt,
  });
}
