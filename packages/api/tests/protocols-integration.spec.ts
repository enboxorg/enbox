/**
 * Integration tests for protocol-shaped API fixtures.
 *
 * These tests configure each protocol on a real DWN, write records, read them
 * back, and verify end-to-end correctness — including singleton enforcement,
 * and nested record creation.
 *
 * The fixtures intentionally live in this test file instead of importing
 * `@enbox/protocols`. `@enbox/protocols` depends on `@enbox/api`; importing it
 * from this package's tests would create an api -> protocols -> api workspace
 * cycle.
 *
 * The test harness lives in `@enbox/api` because it provides the
 * `PlatformAgentTestHarness` and `DwnApi` infrastructure needed for
 * integration testing.
 */

import type { BearerDid } from '@enbox/dids';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { EnboxUserAgent } from '@enbox/agent';
import { PlatformAgentTestHarness } from '@enbox/agent/test';

import { defineProtocol } from '../src/define-protocol.js';
import { DwnApi } from '../src/dwn-api.js';
import { recordCodecs } from '../src/record-codec.js';
import { testDwnUrl } from './utils/test-config.js';
import { TypedEnbox } from '../src/typed-enbox.js';

// ---------------------------------------------------------------------------
// Local protocol fixtures
// ---------------------------------------------------------------------------

const ProfileDefinition = {
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
} as const satisfies ProtocolDefinition;

const ProfileProtocol = defineProtocol(ProfileDefinition, {
  avatar  : recordCodecs.blob(),
  hero    : recordCodecs.blob(),
  link    : recordCodecs.json<{ url: string; title: string; icon?: string; sortOrder?: number }>(),
  profile : recordCodecs.json<{
    displayName: string;
    bio?: string;
    tagline?: string;
    location?: string;
    website?: string;
    pronouns?: string;
  }>(),
});

const ConnectDefinition = {
  protocol  : 'https://identity.foundation/protocols/connect',
  published : true,
  types     : {
    wallet: {
      schema      : 'https://identity.foundation/schemas/connect/wallet',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    wallet: {
      $recordLimit : { max: 1 },
      $actions     : [
        { who: 'anyone', can: ['read'] },
      ],
    },
  },
} as const satisfies ProtocolDefinition;

const ConnectProtocol = defineProtocol(ConnectDefinition, {
  wallet: recordCodecs.json<{ webWallets: string[] }>(),
});

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const testDwnUrls: string[] = [testDwnUrl];

describe('protocol API integration fixtures', () => {
  let aliceDid: BearerDid;
  let dwnAlice: DwnApi;
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/protocols-integration',
    });

    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    const alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
    aliceDid = alice.did;

    dwnAlice = new DwnApi({ agent: testHarness.agent, connectedDid: aliceDid.uri });
  });

  beforeEach(async () => {
    sinon.restore();
    await testHarness.syncStore.clear();
    await testHarness.dwnDataStore.clear();
    await testHarness.dwnMessageStore.clear();
    await testHarness.dwnResumableTaskStore.clear();
    await testHarness.agent.permissions.clear();
    testHarness.dwnStores.clear();
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  // -------------------------------------------------------------------------
  // Profile Protocol — uses singletons
  // -------------------------------------------------------------------------

  describe('ProfileProtocol', () => {
    it('should configure the protocol', async () => {
      const typed = new TypedEnbox(dwnAlice, ProfileProtocol);
      const { status } = await typed.configure();
      expect(status.code).toBe(202);
    });

    it('should create and query a singleton profile', async () => {
      const typed = new TypedEnbox(dwnAlice, ProfileProtocol);
      await typed.configure();

      const profile = await typed.records.create('profile', {
        data: { displayName: 'Alice', bio: 'Building the future' },
      });

      const data = await profile.value();
      expect(data.displayName).toBe('Alice');

      const { records } = await typed.records.query('profile');
      const fetched = records[0];
      const fetchedData = await fetched.value();
      expect(fetchedData.displayName).toBe('Alice');
    });

    it('should update a loaded singleton profile explicitly', async () => {
      const typed = new TypedEnbox(dwnAlice, ProfileProtocol);
      await typed.configure();

      const record = await typed.records.create('profile', { data: { displayName: 'Alice v1' } });
      const updated = await record.update({
        data: { displayName: 'Alice v2', bio: 'Updated bio' },
      });
      expect(updated).toBe(record);

      const { records } = await typed.records.query('profile');
      const fetched = records[0];
      const data = await fetched.value();
      expect(data.displayName).toBe('Alice v2');
      expect(data.bio).toBe('Updated bio');
    });

    it('should create nested links under profile', async () => {
      const typed = new TypedEnbox(dwnAlice, ProfileProtocol);
      await typed.configure();

      const profileRecord = await typed.records.create('profile', {
        data: { displayName: 'Alice' },
      });

      const link = await typed.records.create('profile/link', {
        data            : { url: 'https://twitter.com/alice', title: 'Twitter' },
        parentContextId : profileRecord.contextId,
      });

      expect(link.protocolPath).toBe('profile/link');

      const linkData = await link.value();
      expect(linkData.url).toBe('https://twitter.com/alice');
    });
  });

  // -------------------------------------------------------------------------
  // Connect Protocol — standalone, singleton wallet
  // -------------------------------------------------------------------------

  describe('ConnectProtocol', () => {
    it('should configure, create, and query the wallet singleton', async () => {
      const typed = new TypedEnbox(dwnAlice, ConnectProtocol);
      await typed.configure();

      await typed.records.create('wallet', {
        data: { webWallets: ['https://wallet.example.com'] },
      });

      const { records } = await typed.records.query('wallet');
      const fetched = records[0];
      const data = await fetched.value();
      expect(data.webWallets).toEqual(['https://wallet.example.com']);
    });

    it('should update a loaded wallet singleton explicitly', async () => {
      const typed = new TypedEnbox(dwnAlice, ConnectProtocol);
      await typed.configure();

      const record = await typed.records.create('wallet', {
        data: { webWallets: ['https://v1.wallet.com'] },
      });

      await record.update({
        data: { webWallets: ['https://v2.wallet.com', 'https://alt.wallet.com'] },
      });

      const { records } = await typed.records.query('wallet');
      const fetched = records[0];
      const data = await fetched.value();
      expect(data.webWallets).toEqual(['https://v2.wallet.com', 'https://alt.wallet.com']);
    });
  });

});
