/**
 * E2E: live-sync auto-pull of a newly-registered identity scope (no manual pull).
 *
 * Mirrors the wallet's reconciliation flow after it stopped driving a manual
 * `sync('pull')` (see enboxorg/web-wallet). With live sync running on both
 * wallets, a second same-owner wallet creates an identity and writes its profile
 * subtree. The first wallet discovers the identity over the agent-DID live sync,
 * registers the scoped protocols, and the SDK must converge the identity's
 * existing records on its own — purely from the hot-added link under live sync,
 * with no manual pull.
 *
 * Requires: DWN server on localhost:3000 (or TEST_DWN_URL),
 *           Pkarr relay on localhost:7527 (or DID_DHT_GATEWAY_URI).
 */
import type { ProtocolDefinition, RecordsFilter, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { Convert } from '@enbox/common';
import { DataStream } from '@enbox/dwn-sdk-js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import type { BearerIdentity } from '../../src/bearer-identity.js';
import type { EnboxUserAgent } from '../../src/enbox-user-agent.js';
import type { PlatformAgentTestHarness } from '../../src/test-harness.js';

import { PlatformAgentTestHarness as AgentTestHarness } from '../../src/test-harness.js';
import { DwnInterface } from '../../src/types/dwn.js';
import { requireDwnServer } from '../utils/require-dwn-server.js';
import { testDwnUrl } from '../utils/test-config.js';
import { EnboxUserAgent as UserAgent } from '../../src/enbox-user-agent.js';
import { IdentityProtocolDefinition, JwkProtocolDefinition } from '../../src/store-data-protocols.js';

const testDwnUrls = [testDwnUrl];

const socialGraphProtocol: ProtocolDefinition = {
  protocol  : 'https://identity.foundation/protocols/social-graph',
  published : true,
  types     : {
    friend: {
      schema      : 'https://identity.foundation/schemas/social-graph/friend',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    friend: {
      $role    : true,
      $actions : [
        { who: 'anyone', can: ['create'] },
        { who: 'author', of: 'friend', can: ['read'] },
      ],
    },
  },
};

const profileProtocol: ProtocolDefinition = {
  protocol  : 'https://identity.foundation/protocols/profile',
  published : true,
  uses      : {
    social: socialGraphProtocol.protocol,
  },
  types: {
    profile: {
      schema      : 'https://identity.foundation/schemas/profile/profile',
      dataFormats : ['application/json'],
    },
    avatar: {
      dataFormats: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    },
    hero: {
      dataFormats: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    },
  },
  structure: {
    profile: {
      $recordLimit : { max: 1, strategy: 'reject' },
      $size        : { max: 10000 },
      $actions     : [
        { who: 'anyone', can: ['read'] },
      ],
      avatar: {
        $recordLimit : { max: 1, strategy: 'reject' },
        $size        : { max: 12582912 },
        $actions     : [
          { who: 'anyone', can: ['read'] },
        ],
      },
      hero: {
        $recordLimit : { max: 1, strategy: 'reject' },
        $size        : { max: 25165824 },
        $actions     : [
          { who: 'anyone', can: ['read'] },
        ],
      },
    },
  },
};

const profileSyncProtocols: [string, ...string[]] = [socialGraphProtocol.protocol, profileProtocol.protocol];
const agentDidSyncProtocols: [string, ...string[]] = [IdentityProtocolDefinition.protocol, JwkProtocolDefinition.protocol];

async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs: number = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function setupWalletHarness(testDataLocation: string): Promise<PlatformAgentTestHarness> {
  const harness = await AgentTestHarness.setup({
    agentClass       : UserAgent,
    agentStores      : 'dwn',
    testDataLocation : testDataLocation,
  });
  await harness.clearStorage();
  return harness;
}

async function initializeWalletFromPhrase(
  harness: PlatformAgentTestHarness,
  password: string,
  recoveryPhrase?: string
): Promise<string | undefined> {
  const agent = harness.agent as EnboxUserAgent;
  const phrase = await agent.initialize({ password, recoveryPhrase, dwnEndpoints: testDwnUrls });
  await agent.start({ password });
  return phrase;
}

function isFreshDidResolutionFailure(status: { code: number; detail: string }): boolean {
  return status.code === 401 && status.detail.includes('GetPublicKeyNotFound');
}

function bytesToBlob(bytes: Uint8Array): Blob {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return new Blob([arrayBuffer]);
}

async function retryFreshDidResolution<T extends { reply: { status: { code: number; detail: string } } }>(
  operation: () => Promise<T>
): Promise<T> {
  const retryDelays = [500, 1_000, 2_000, 4_000];
  let result = await operation();

  for (const delayMs of retryDelays) {
    if (!isFreshDidResolutionFailure(result.reply.status)) {
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
    result = await operation();
  }

  return result;
}

async function installProtocolLocalAndRemote(
  harness: PlatformAgentTestHarness,
  did: string,
  definition: ProtocolDefinition
): Promise<void> {
  const localResult = await harness.agent.dwn.processRequest({
    author        : did,
    target        : did,
    messageType   : DwnInterface.ProtocolsConfigure,
    messageParams : { definition },
  });
  expect(localResult.reply.status.code).toBe(202);

  const remoteResult = await retryFreshDidResolution(() => harness.agent.dwn.sendRequest({
    author      : did,
    target      : did,
    messageType : DwnInterface.ProtocolsConfigure,
    rawMessage  : localResult.message!,
  }));
  expect(remoteResult.reply.status.code).toBe(202);
}

async function writeRecordLocalAndRemote(
  harness: PlatformAgentTestHarness,
  did: string,
  messageParams: {
    protocol: string;
    protocolPath: string;
    schema?: string;
    parentContextId?: string;
    dataFormat: string;
    published?: boolean;
  },
  dataBytes: Uint8Array
): Promise<RecordsWriteMessage> {
  const localResult = await harness.agent.dwn.processRequest({
    author        : did,
    target        : did,
    messageType   : DwnInterface.RecordsWrite,
    messageParams : messageParams,
    dataStream    : bytesToBlob(dataBytes),
  });
  expect(localResult.reply.status.code).toBe(202);

  const remoteResult = await retryFreshDidResolution(() => harness.agent.dwn.sendRequest({
    author      : did,
    target      : did,
    messageType : DwnInterface.RecordsWrite,
    rawMessage  : localResult.message!,
    dataStream  : bytesToBlob(dataBytes),
  }));
  expect(remoteResult.reply.status.code).toBe(202);

  return localResult.message!;
}

async function findRecord(
  harness: PlatformAgentTestHarness,
  did: string,
  filter: RecordsFilter
): Promise<RecordsWriteMessage | undefined> {
  const result = await harness.agent.dwn.processRequest({
    author        : did,
    target        : did,
    messageType   : DwnInterface.RecordsQuery,
    messageParams : { filter },
  });
  return result.reply.entries?.[0];
}

async function readRecordBytes(
  harness: PlatformAgentTestHarness,
  did: string,
  recordId: string
): Promise<Uint8Array> {
  const result = await harness.agent.dwn.processRequest({
    author        : did,
    target        : did,
    messageType   : DwnInterface.RecordsRead,
    messageParams : { filter: { recordId } },
  });
  expect(result.reply.status.code).toBe(200);
  expect(result.reply.entry?.data).toBeDefined();
  return DataStream.toBytes(result.reply.entry!.data!);
}

describe('E2E: live-sync auto-pull of a newly-registered identity scope', () => {
  beforeAll(async () => {
    await requireDwnServer();
  });

  const password = 'e2e-live-autopull-password';
  const discoveredIdentityName = 'Live Autopull Identity';

  let walletA: PlatformAgentTestHarness;
  let walletB: PlatformAgentTestHarness;
  let discoveredIdentity: BearerIdentity;

  beforeAll(async () => {
    walletA = await setupWalletHarness('__TESTDATA__/e2e-live-autopull-wallet-a');
    const recoveryPhrase = await initializeWalletFromPhrase(walletA, password);
    expect(recoveryPhrase).toBeDefined();

    walletB = await setupWalletHarness('__TESTDATA__/e2e-live-autopull-wallet-b');
    await initializeWalletFromPhrase(walletB, password, recoveryPhrase);
    expect(walletB.agent.agentDid.uri).toBe(walletA.agent.agentDid.uri);

    // Register the agent DID for recovery-scope sync and start live mode on both
    // wallets, exactly as the wallet does — no manual pulls anywhere.
    for (const wallet of [walletA, walletB]) {
      await wallet.agent.sync.registerIdentity({
        did     : wallet.agent.agentDid.uri,
        options : { protocols: agentDidSyncProtocols },
      });
      await wallet.agent.sync.startSync({ interval: '30s' });
    }
    expect(walletA.agent.sync.hasActiveSubscriptions).toBe(true);
    expect(walletB.agent.sync.hasActiveSubscriptions).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await walletA?.agent.sync.stopSync();
    await walletB?.agent.sync.stopSync();
    await walletA?.clearStorage();
    await walletB?.clearStorage();
    await walletA?.closeStorage();
    await walletB?.closeStorage();
  });

  it('auto-pulls a discovered identity profile subtree under live sync without a manual pull', async () => {
    // Wallet B creates a new identity and writes its profile subtree (local + remote).
    discoveredIdentity = await walletB.createIdentity({ name: discoveredIdentityName, testDwnUrls });
    const did = discoveredIdentity.did.uri;

    for (const definition of [socialGraphProtocol, profileProtocol]) {
      await installProtocolLocalAndRemote(walletB, did, definition);
    }

    const profileData = {
      displayName : 'Live Autopull Identity',
      tagline     : 'Converged via live sync, no manual pull',
    };
    const profileBytes = Convert.string(JSON.stringify(profileData)).toUint8Array();
    const avatarBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const heroBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6, 7, 8]);

    const profileRecord = await writeRecordLocalAndRemote(walletB, did, {
      protocol     : profileProtocol.protocol,
      protocolPath : 'profile',
      schema       : profileProtocol.types.profile.schema,
      dataFormat   : 'application/json',
      published    : true,
    }, profileBytes);

    const avatarRecord = await writeRecordLocalAndRemote(walletB, did, {
      protocol        : profileProtocol.protocol,
      protocolPath    : 'profile/avatar',
      parentContextId : profileRecord.contextId,
      dataFormat      : 'image/png',
      published       : true,
    }, avatarBytes);

    const heroRecord = await writeRecordLocalAndRemote(walletB, did, {
      protocol        : profileProtocol.protocol,
      protocolPath    : 'profile/hero',
      parentContextId : profileRecord.contextId,
      dataFormat      : 'image/png',
      published       : true,
    }, heroBytes);

    // Wallet A must discover the identity purely through the agent-DID live sync —
    // no manual pull.
    await waitFor(
      async () => (await walletA.agent.identity.list()).some(candidate => candidate.did.uri === did),
      45_000,
    );

    // Register the discovered scope, mirroring the wallet's reconcileIdentitySync.
    // Crucially, do NOT call sync('pull') — the SDK must hot-add the link and pull
    // the existing records on its own.
    await walletA.agent.sync.registerIdentity({
      did     : did,
      options : { protocols: profileSyncProtocols },
    });

    // The whole profile subtree must converge on wallet A via live auto-pull.
    await waitFor(async () => {
      const profile = await findRecord(walletA, did, { protocol: profileProtocol.protocol, recordId: profileRecord.recordId });
      const avatar = await findRecord(walletA, did, { protocol: profileProtocol.protocol, recordId: avatarRecord.recordId });
      const hero = await findRecord(walletA, did, { protocol: profileProtocol.protocol, recordId: heroRecord.recordId });
      return Boolean(profile && avatar && hero);
    }, 60_000);

    const pulledProfile = await findRecord(walletA, did, { protocol: profileProtocol.protocol, recordId: profileRecord.recordId });
    const pulledAvatar = await findRecord(walletA, did, { protocol: profileProtocol.protocol, recordId: avatarRecord.recordId });
    const pulledHero = await findRecord(walletA, did, { protocol: profileProtocol.protocol, recordId: heroRecord.recordId });

    expect(pulledProfile!.contextId).toBe(profileRecord.contextId);
    expect(pulledAvatar!.descriptor.parentId).toBe(profileRecord.recordId);
    expect(pulledHero!.descriptor.parentId).toBe(profileRecord.recordId);

    const pulledProfileBytes = await readRecordBytes(walletA, did, profileRecord.recordId);
    expect(JSON.parse(Convert.uint8Array(pulledProfileBytes).toString())).toEqual(profileData);
    expect(await readRecordBytes(walletA, did, avatarRecord.recordId)).toEqual(avatarBytes);
    expect(await readRecordBytes(walletA, did, heroRecord.recordId)).toEqual(heroBytes);

    // Convergence must be clean — no dead-lettered messages.
    const health = await walletA.agent.sync.getSyncHealth();
    expect(health.failedMessageCount).toBe(0);
  }, 120_000);
});
