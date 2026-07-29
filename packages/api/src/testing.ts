/**
 * Node-only integration-test support for the public Enbox API.
 *
 * @packageDocumentation
 */

import type { ApplicationManifest } from './application-manifest.js';

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { DidJwk } from '@enbox/dids';
import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { AgentSession, EnboxUserAgent } from '@enbox/agent';

import { Enbox } from './enbox.js';

/** Options accepted by {@link createEnboxTestContext}. */
export type CreateEnboxTestContextOptions = {
  /** Typed application protocols installed before the context is returned. */
  application: ApplicationManifest;
};

/** One isolated owner session backed by a real in-process DWN. */
export type EnboxTestContext = {
  /** Public API bound to the isolated owner identity. */
  enbox: Enbox;

  /** Session whose signal is aborted when the context closes. */
  session: AgentSession;

  /** Release subscriptions, sync work, storage, and the temporary directory. */
  close(): Promise<void>;
};

/**
 * Create an isolated local Enbox context for Node integration tests.
 *
 * Protocols are installed through the same readiness path used by
 * applications. Hosted publication is disabled so the context needs no
 * network services.
 */
export async function createEnboxTestContext(
  { application }: CreateEnboxTestContextOptions,
): Promise<EnboxTestContext> {
  const testDataLocation = await mkdtemp(join(tmpdir(), 'enbox-api-'));
  const lifetime = new AbortController();
  let enbox: Enbox | undefined;
  let harness: PlatformAgentTestHarness | undefined;
  let closePromise: Promise<void> | undefined;

  const close = (): Promise<void> => {
    closePromise ??= (async (): Promise<void> => {
      lifetime.abort(new Error('Enbox test context closed.'));
      try {
        await enbox?.disconnect();
      } finally {
        try {
          await harness?.closeStorage();
        } finally {
          await rm(testDataLocation, { force: true, recursive: true });
        }
      }
    })();
    return closePromise;
  };

  try {
    harness = await PlatformAgentTestHarness.setup({
      agentClass  : EnboxUserAgent,
      agentStores : 'memory',
      testDataLocation,
    });
    harness.agent.agentDid = await DidJwk.create();

    const identity = await harness.agent.identity.create({
      didMethod  : 'dht',
      didOptions : {
        publish             : false,
        verificationMethods : [
          {
            algorithm : 'X25519',
            id        : 'enc',
            purposes  : ['keyAgreement'],
          },
        ],
      },
      metadata: { name: 'Enbox Test' },
    });
    const session = new AgentSession({
      agent    : harness.agent,
      did      : identity.did.uri,
      identity : { didUri: identity.did.uri, name: identity.metadata.name },
      signal   : lifetime.signal,
    });
    enbox = Enbox.fromSession(session);

    await enbox.protocols.ensureReady({ application, publish: false });

    return { close, enbox, session };
  } catch (error: unknown) {
    await close().catch((): void => {});
    throw error;
  }
}
