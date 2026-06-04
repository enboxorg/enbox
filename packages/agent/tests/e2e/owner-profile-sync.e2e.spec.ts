/**
 * E2E: same-owner profile sync convergence.
 *
 * Models two wallet instances that both possess the same identity keys. The
 * second wallet writes a composed profile, avatar, and hero to its local DWN
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
import type { PlatformAgentTestHarness } from '../../src/test-harness.js';

import { PlatformAgentTestHarness as AgentTestHarness } from '../../src/test-harness.js';
import { DwnInterface } from '../../src/types/dwn.js';
import { TestAgent } from '../utils/test-agent.js';
import { testDwnUrl } from '../utils/test-config.js';

const testDwnUrls = [testDwnUrl];

const socialGraphProtocol: ProtocolDefinition = {
  protocol  : 'https://identity.foundation/protocols/social-graph',
  published : true,
  types     : {
    friend: {
      schema      : 'https://identity.foundation/schemas/social-graph/friend',
      dataFormats : ['application/json'],
    },
    block: {
      schema      : 'https://identity.foundation/schemas/social-graph/block',
      dataFormats : ['application/json'],
    },
    group: {
      schema      : 'https://identity.foundation/schemas/social-graph/group',
      dataFormats : ['application/json'],
    },
    member: {
      schema      : 'https://identity.foundation/schemas/social-graph/member',
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
      $tags: {
        $requiredTags       : ['did'],
        $allowUndefinedTags : false,
        did                 : { type: 'string' },
      },
    },
    block: {
      $actions: [
        { who: 'anyone', can: ['create'] },
      ],
      $tags: {
        $requiredTags       : ['did'],
        $allowUndefinedTags : false,
        did                 : { type: 'string' },
      },
    },
    group: {
      $actions: [
        { who: 'anyone', can: ['read'] },
      ],
      member: {
        $actions: [
          { who: 'anyone', can: ['read'] },
        ],
        $tags: {
          $requiredTags       : ['did'],
          $allowUndefinedTags : false,
          did                 : { type: 'string' },
        },
      },
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
    link: {
      schema      : 'https://identity.foundation/schemas/profile/link',
      dataFormats : ['application/json'],
    },
    privateNote: {
      schema      : 'https://identity.foundation/schemas/profile/private-note',
      dataFormats : ['application/json'],
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
      link: {
        $actions: [
          { who: 'anyone', can: ['read'] },
        ],
      },
    },
    privateNote: {
      $actions: [
        { role: 'social:friend', can: ['read'] },
      ],
    },
  },
};

const profileSyncProtocols: [string, ...string[]] = [socialGraphProtocol.protocol, profileProtocol.protocol];

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
  expect(result.reply.entries?.length).toBe(1);
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

describe('E2E: same-owner profile sync convergence', () => {
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

    for (const definition of [socialGraphProtocol, profileProtocol]) {
      await installProtocolLocalAndRemote(walletA, identity.did.uri, definition);
    }

    const portableIdentity = await identity.export();
    await walletB.agent.identity.import({
      portableIdentity: structuredClone(portableIdentity),
    });

    for (const definition of [socialGraphProtocol, profileProtocol]) {
      await installProtocolLocalAndRemote(walletB, identity.did.uri, definition);
    }

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

    await expectProtocolInstalled(walletA, did, socialGraphProtocol.protocol);
    await expectProtocolInstalled(walletA, did, profileProtocol.protocol);

    const pulledProfile = await expectRecord(walletA, did, {
      protocol : profileProtocol.protocol,
      recordId : profileRecord.recordId,
    });
    expect(pulledProfile.contextId).toBe(profileRecord.contextId);

    const pulledAvatar = await expectRecord(walletA, did, {
      protocol     : profileProtocol.protocol,
      protocolPath : 'profile/avatar',
      recordId     : avatarRecord.recordId,
    });
    expect(pulledAvatar.contextId).toBe(avatarRecord.contextId);
    expect(pulledAvatar.descriptor.parentId).toBe(profileRecord.recordId);

    const pulledHero = await expectRecord(walletA, did, {
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
