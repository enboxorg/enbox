/**
 * Node-only integration-test support for the public Enbox API.
 *
 * @packageDocumentation
 */

import type { ApplicationManifest } from './application-manifest.js';
import type { ConnectHandler } from '@enbox/auth';

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { AgentSession, EnboxUserAgent, executeConnectApproval } from '@enbox/agent';
import { AuthManager, MemoryStorage } from '@enbox/auth';

import { Enbox } from './enbox.js';
import { getApplicationProtocolRequests } from './application-manifest.js';

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

/** Options accepted by {@link createHostedDelegatedEnboxTestContext}. */
export type CreateHostedDelegatedEnboxTestContextOptions = {
  /** Typed application protocols installed and granted by the owner wallet. */
  application: ApplicationManifest;

  /**
   * Hosted DWN endpoints advertised by the temporary owner identity.
   *
   * The helper deliberately does not start or emulate a server. Tests must
   * provide at least one reachable endpoint so remote routing, response
   * verification, grants, encryption, and decryption use production paths.
   */
  dwnEndpoints: readonly string[];
};

/** One isolated delegated session backed by a real hosted DWN. */
export type HostedDelegatedEnboxTestContext = {
  /** Public API bound to the owner DID and authorized by the delegate. */
  enbox: Enbox;

  /** The wallet identity whose hosted DWN owns the test corpus. */
  ownerDid: string;

  /** The imported delegate DID that signs the dapp's requests. */
  delegateDid: string;

  /** Delegated session whose signal is aborted when the context closes. */
  session: AgentSession;

  /** Stop sync, close both agents, and remove local temporary data. */
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
        enbox?.close();
        await harness?.agent.sync.stopSync();
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
    await harness.createAgentDid({ publish: false });
    const identity = await harness.createIdentity({ name: 'Enbox Test', publish: false });
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

/**
 * Create a wallet-owned, delegate-operated Enbox context using hosted DWNs.
 *
 * This helper drives the same approval and delegated-connect paths used by a
 * real application. It is intentionally Node-only and requires externally
 * managed DWN endpoints; it does not replace hosted transport with an
 * in-process shortcut.
 */
export async function createHostedDelegatedEnboxTestContext(
  { application, dwnEndpoints }: CreateHostedDelegatedEnboxTestContextOptions,
): Promise<HostedDelegatedEnboxTestContext> {
  if (dwnEndpoints.length === 0) {
    throw new TypeError('createHostedDelegatedEnboxTestContext requires at least one DWN endpoint.');
  }
  if (dwnEndpoints.some((endpoint) => typeof endpoint !== 'string' || endpoint.length === 0)) {
    throw new TypeError('createHostedDelegatedEnboxTestContext requires non-empty DWN endpoint strings.');
  }

  const testDataLocation = await mkdtemp(join(tmpdir(), 'enbox-api-hosted-'));
  const walletDataLocation = join(testDataLocation, 'wallet');
  const dappDataLocation = join(testDataLocation, 'dapp');
  let auth: AuthManager | undefined;
  let enbox: Enbox | undefined;
  let walletAgent: EnboxUserAgent | undefined;
  let walletHarness: PlatformAgentTestHarness | undefined;
  let closePromise: Promise<void> | undefined;

  const close = (): Promise<void> => {
    closePromise ??= (async (): Promise<void> => {
      enbox?.close();
      try {
        await auth?.shutdown();
      } finally {
        try {
          await walletAgent?.shutdown();
        } finally {
          await rm(testDataLocation, { force: true, recursive: true });
        }
      }
    })();
    return closePromise;
  };

  try {
    walletHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : walletDataLocation,
    });
    if (!(walletHarness.agent instanceof EnboxUserAgent)) {
      throw new TypeError('Hosted delegated test context requires an EnboxUserAgent wallet.');
    }
    const activeWalletAgent = walletHarness.agent;
    walletAgent = activeWalletAgent;
    await walletHarness.createAgentDid();
    const owner = await walletHarness.createIdentity({
      name        : 'Enbox Hosted Test Owner',
      testDwnUrls : [...dwnEndpoints],
    });
    const ownerDid = owner.did.uri;

    const connectHandler: ConnectHandler = {
      requestAccess: async ({
        delegatePortableDid, expectedProviderDid, permissionRequests,
      }) => {
        const approval = await executeConnectApproval({
          agent       : activeWalletAgent,
          providerDid : ownerDid,
          request     : {
            appName     : 'Enbox Hosted Test',
            delegateDid : delegatePortableDid?.uri,
            expectedProviderDid,
            permissionRequests,
          },
          transport: 'relay',
        });
        const portableDid = approval.delegatePortableDid ?? delegatePortableDid;
        if (portableDid === undefined) {
          throw new Error('Hosted delegated approval returned no delegate key material.');
        }
        return {
          connectedDid        : ownerDid,
          delegateGrants      : approval.delegateGrants,
          delegatePortableDid : portableDid,
          sessionRevocations  : approval.sessionRevocations,
        };
      },
    };

    auth = await AuthManager.create({
      connectHandler,
      dataPath         : dappDataLocation,
      localDwnStrategy : 'off',
      password         : 'enbox-hosted-test-only',
      storage          : new MemoryStorage(),
      sync             : 'live',
    });
    const session = await auth.connect({
      protocols: getApplicationProtocolRequests(application),
    });
    if (session.delegateDid === undefined) {
      throw new Error('Hosted delegated connect returned an owner session instead of a delegate session.');
    }

    enbox = Enbox.fromSession(session);

    return {
      close,
      delegateDid: session.delegateDid,
      enbox,
      ownerDid,
      session,
    };
  } catch (error: unknown) {
    await close().catch((): void => {});
    throw error;
  }
}
