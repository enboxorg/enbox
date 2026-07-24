/**
 * E2E: same-owner profile sync convergence.
 *
 * Models two wallet instances that both possess the same identity keys. The
 * second wallet writes a profile, avatar, and hero to its local DWN
 * and sends the same messages to the remote DWN. The first wallet then pulls
 * the scoped protocols and must converge to the full profile subtree.
 *
 * Requires: DWN server running on localhost:3000 (or TEST_DWN_URL),
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
import { TestAgent } from '../utils/test-agent.js';
import { testDwnUrl } from '../utils/test-config.js';
import { EnboxUserAgent as UserAgent } from '../../src/enbox-user-agent.js';
import { IdentityProtocolDefinition, JwkProtocolDefinition } from '../../src/store-data-protocols.js';

const testDwnUrls = [testDwnUrl];

const profileProtocol: ProtocolDefinition = {
  protocol  : 'https://identity.foundation/protocols/profile',
  published : true,
  types     : {
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
    link: {
      schema      : 'https://identity.foundation/schemas/profile/link',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    profile: {
      $recordLimit : { max: 1 },
      $size        : { max: 10000 },
      $actions     : [
        { who: 'anyone', can: ['read'] },
      ],
      avatar: {
        $recordLimit : { max: 1 },
        $size        : { max: 12582912 },
        $actions     : [
          { who: 'anyone', can: ['read'] },
        ],
      },
      hero: {
        $recordLimit : { max: 1 },
        $size        : { max: 25165824 },
        $actions     : [
          { who: 'anyone', can: ['read'] },
        ],
      },
      link: {
        $actions: [
          { who: 'anyone', can: ['read'] },
        ],
      },
    },
  },
};

const profileSyncProtocols: [string, ...string[]] = [profileProtocol.protocol];
const agentDidSyncProtocols: [string, ...string[]] = [IdentityProtocolDefinition.protocol, JwkProtocolDefinition.protocol];

async function setupHarness(testDataLocation: string): Promise<PlatformAgentTestHarness> {
  const harness = await AgentTestHarness.setup({
    agentClass       : TestAgent,
    agentStores      : 'memory',
    testDataLocation : testDataLocation,
  });
  await harness.clearStorage();
  await harness.createAgentDid();
  return harness;
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
  const phrase = await agent.initialize({
    password,
    recoveryPhrase,
    dwnEndpoints: testDwnUrls,
  });
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

async function expectProtocolInstalled(
  harness: PlatformAgentTestHarness,
  did: string,
  protocol: string
): Promise<void> {
  const result = await harness.agent.dwn.processRequest({
    author        : did,
    target        : did,
    messageType   : DwnInterface.ProtocolsQuery,
    messageParams : { filter: { protocol } },
  });
  expect(result.reply.status.code).toBe(200);
  expect(result.reply.entries?.length ?? 0).toBeGreaterThan(0);
}

async function expectRecord(
  harness: PlatformAgentTestHarness,
  did: string,
  filter: RecordsFilter
): Promise<RecordsWriteMessage> {
  const result = await harness.agent.dwn.processRequest({
    author        : did,
    target        : did,
    messageType   : DwnInterface.RecordsQuery,
    messageParams : { filter },
  });
  expect(result.reply.status.code).toBe(200);
  expect(result.reply.entries).toHaveLength(1);
  return result.reply.entries![0];
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

async function expectIdentityDiscovered(
  harness: PlatformAgentTestHarness,
  did: string,
  expectedName: string
): Promise<BearerIdentity> {
  const identities = await harness.agent.identity.list();
  const identity = identities.find(candidate => candidate.did.uri === did);
  expect(identity).toBeDefined();
  expect(identity!.metadata.name).toBe(expectedName);
  return identity!;
}

describe('E2E: same-owner profile sync convergence', () => {
  beforeAll(async () => {
    await requireDwnServer();
  });

  let walletA: PlatformAgentTestHarness;
  let walletB: PlatformAgentTestHarness;
  let identity: BearerIdentity;

  beforeAll(async () => {
    walletA = await setupHarness('__TESTDATA__/e2e-owner-profile-wallet-a');
    walletB = await setupHarness('__TESTDATA__/e2e-owner-profile-wallet-b');

    identity = await walletA.createIdentity({
      name: 'Track A Owner Profile',
      testDwnUrls,
    });

    await installProtocolLocalAndRemote(walletA, identity.did.uri, profileProtocol);

    const portableIdentity = await identity.export();
    await walletB.agent.identity.import({
      portableIdentity: structuredClone(portableIdentity),
    });

    await installProtocolLocalAndRemote(walletB, identity.did.uri, profileProtocol);

    await walletA.agent.sync.registerIdentity({
      did     : identity.did.uri,
      options : { protocols: profileSyncProtocols },
    });
    await walletB.agent.sync.registerIdentity({
      did     : identity.did.uri,
      options : { protocols: profileSyncProtocols },
    });
  }, 60_000);

  afterAll(async () => {
    await walletA?.agent.sync.stopSync();
    await walletB?.agent.sync.stopSync();
    await walletA?.clearStorage();
    await walletB?.clearStorage();
    await walletA?.closeStorage();
    await walletB?.closeStorage();
  });

  it('pulls profile root and binary child records written by another same-owner wallet', async () => {
    const did = identity.did.uri;
    const profileData = {
      displayName : 'Second Wallet Identity',
      tagline     : 'Synced from a restored wallet',
      bio         : 'Profile root created on wallet B and pulled by wallet A.',
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

    await walletA.agent.sync.sync('pull');

    await expectProtocolInstalled(walletA, did, profileProtocol.protocol);

    const pulledProfile = await expectRecord(walletA, did, {
      protocol : profileProtocol.protocol,
      recordId : profileRecord.recordId,
    });
    expect(pulledProfile.contextId).toBe(profileRecord.contextId);

    const pulledAvatar = await expectRecord(walletA, did, {
      contextId    : profileRecord.contextId,
      protocol     : profileProtocol.protocol,
      protocolPath : 'profile/avatar',
      recordId     : avatarRecord.recordId,
    });
    expect(pulledAvatar.contextId).toBe(avatarRecord.contextId);
    expect(pulledAvatar.descriptor.parentId).toBe(profileRecord.recordId);

    const pulledHero = await expectRecord(walletA, did, {
      contextId    : profileRecord.contextId,
      protocol     : profileProtocol.protocol,
      protocolPath : 'profile/hero',
      recordId     : heroRecord.recordId,
    });
    expect(pulledHero.contextId).toBe(heroRecord.contextId);
    expect(pulledHero.descriptor.parentId).toBe(profileRecord.recordId);

    const pulledProfileBytes = await readRecordBytes(walletA, did, profileRecord.recordId);
    const pulledProfileData = JSON.parse(Convert.uint8Array(pulledProfileBytes).toString()) as typeof profileData;
    expect(pulledProfileData).toEqual(profileData);
    expect(await readRecordBytes(walletA, did, avatarRecord.recordId)).toEqual(avatarBytes);
    expect(await readRecordBytes(walletA, did, heroRecord.recordId)).toEqual(heroBytes);
  }, 60_000);
});

describe('E2E: same-owner identity discovery and profile sync convergence', () => {
  const password = 'track-a-identity-discovery-password';
  const discoveredIdentityName = 'Track A Discovered Identity';

  let walletA: PlatformAgentTestHarness;
  let walletB: PlatformAgentTestHarness;
  let discoveredIdentity: BearerIdentity;

  beforeAll(async () => {
    walletA = await setupWalletHarness('__TESTDATA__/e2e-owner-identity-discovery-wallet-a');
    const recoveryPhrase = await initializeWalletFromPhrase(walletA, password);
    expect(recoveryPhrase).toBeDefined();

    walletB = await setupWalletHarness('__TESTDATA__/e2e-owner-identity-discovery-wallet-b');
    await initializeWalletFromPhrase(walletB, password, recoveryPhrase);
    expect(walletB.agent.agentDid.uri).toBe(walletA.agent.agentDid.uri);

    for (const wallet of [walletA, walletB]) {
      await wallet.agent.sync.registerIdentity({
        did     : wallet.agent.agentDid.uri,
        options : { protocols: agentDidSyncProtocols },
      });
    }
  }, 60_000);

  afterAll(async () => {
    await walletA?.agent.sync.stopSync();
    await walletB?.agent.sync.stopSync();
    await walletA?.clearStorage();
    await walletB?.clearStorage();
    await walletA?.closeStorage();
    await walletB?.closeStorage();
  });

  it('discovers a new identity from the agent identity index and then pulls its profile subtree', async () => {
    discoveredIdentity = await walletB.createIdentity({
      name: discoveredIdentityName,
      testDwnUrls,
    });

    expect((await walletA.agent.identity.list()).map(identity => identity.did.uri))
      .not.toContain(discoveredIdentity.did.uri);

    await walletB.agent.sync.sync('push');

    const pulledIdentities = await walletA.agent.sync.sync('pull')
      .then(() => walletA.agent.identity.list());
    expect(pulledIdentities.map(identity => identity.did.uri)).toContain(discoveredIdentity.did.uri);

    const walletADiscoveredIdentity = await expectIdentityDiscovered(
      walletA,
      discoveredIdentity.did.uri,
      discoveredIdentityName,
    );
    expect(walletADiscoveredIdentity.metadata.tenant).toBe(walletA.agent.agentDid.uri);

    const did = discoveredIdentity.did.uri;
    await installProtocolLocalAndRemote(walletB, did, profileProtocol);

    const profileData = {
      displayName : 'Discovered Wallet Identity',
      tagline     : 'Created on wallet B, discovered by wallet A',
      bio         : 'Identity metadata and profile data converged across same-owner wallets.',
    };
    const profileBytes = Convert.string(JSON.stringify(profileData)).toUint8Array();
    const avatarBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 10, 11, 12]);
    const heroBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 14, 15, 16]);

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

    await walletA.agent.sync.registerIdentity({
      did     : did,
      options : { protocols: profileSyncProtocols },
    });
    await walletB.agent.sync.registerIdentity({
      did     : did,
      options : { protocols: profileSyncProtocols },
    });

    await walletA.agent.sync.sync('pull');

    await expectProtocolInstalled(walletA, did, profileProtocol.protocol);

    const pulledProfile = await expectRecord(walletA, did, {
      protocol : profileProtocol.protocol,
      recordId : profileRecord.recordId,
    });
    expect(pulledProfile.contextId).toBe(profileRecord.contextId);

    const pulledAvatar = await expectRecord(walletA, did, {
      contextId    : profileRecord.contextId,
      protocol     : profileProtocol.protocol,
      protocolPath : 'profile/avatar',
      recordId     : avatarRecord.recordId,
    });
    expect(pulledAvatar.descriptor.parentId).toBe(profileRecord.recordId);

    const pulledHero = await expectRecord(walletA, did, {
      contextId    : profileRecord.contextId,
      protocol     : profileProtocol.protocol,
      protocolPath : 'profile/hero',
      recordId     : heroRecord.recordId,
    });
    expect(pulledHero.descriptor.parentId).toBe(profileRecord.recordId);

    const pulledProfileBytes = await readRecordBytes(walletA, did, profileRecord.recordId);
    const pulledProfileData = JSON.parse(Convert.uint8Array(pulledProfileBytes).toString()) as typeof profileData;
    expect(pulledProfileData).toEqual(profileData);
    expect(await readRecordBytes(walletA, did, avatarRecord.recordId)).toEqual(avatarBytes);
    expect(await readRecordBytes(walletA, did, heroRecord.recordId)).toEqual(heroBytes);
  }, 90_000);
});
