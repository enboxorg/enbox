/**
 * Integration tests for `@enbox/protocols` definitions.
 *
 * These tests configure each protocol on a real DWN, write records, read them
 * back, and verify end-to-end correctness — including singleton upsert
 * semantics, nested record creation, and tag enforcement.
 *
 * Protocols that compose with the Social Graph via `uses` require the Social
 * Graph protocol to be installed first. Friend/collaborator-only actions
 * (cross-tenant writes) are not tested here; this suite exercises owner-tenant
 * operations.
 *
 * The test harness lives in `@enbox/api` because it provides the
 * `PlatformAgentTestHarness` and `DwnApi` infrastructure needed for
 * integration testing.
 */

import type { BearerDid } from '@enbox/dids';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import {
  ConnectProtocol,
  ListsProtocol,
  ProfileProtocol,
  SocialGraphProtocol,
  StatusProtocol,
} from '@enbox/protocols';
import { PlatformAgentTestHarness, Web5UserAgent } from '@enbox/agent';

import { DwnApi } from '../src/dwn-api.js';
import { repository } from '../src/repository.js';
import { testDwnUrl } from './utils/test-config.js';
import { TypedEnbox } from '../src/typed-enbox.js';
import { TypedRecord } from '../src/typed-record.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const testDwnUrls: string[] = [testDwnUrl];

describe('@enbox/protocols integration', () => {
  let aliceDid: BearerDid;
  let dwnAlice: DwnApi;
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : Web5UserAgent,
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
    await testHarness.dwnStateIndex.clear();
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

  /**
   * Helper to install the Social Graph protocol as a prerequisite for
   * protocols that compose with it via `uses`.
   */
  async function installSocialGraph(): Promise<void> {
    const socialTyped = new TypedEnbox(dwnAlice, SocialGraphProtocol);
    const { status } = await socialTyped.configure();
    expect(status.code).toBeOneOf([200, 202]);
  }

  // -------------------------------------------------------------------------
  // Social Graph Protocol
  // -------------------------------------------------------------------------

  describe('SocialGraphProtocol', () => {
    it('should configure the protocol', async () => {
      const typed = new TypedEnbox(dwnAlice, SocialGraphProtocol);
      const { status } = await typed.configure();
      expect(status.code).toBe(202);
    });

    it('should create a friend record with required recipient and tags', async () => {
      const typed = new TypedEnbox(dwnAlice, SocialGraphProtocol);
      await typed.configure();

      // Friend has $role: true, so requires a recipient.
      const { status, record } = await typed.records.create('friend', {
        data      : { did: 'did:example:bob', alias: 'Bob' },
        tags      : { did: 'did:example:bob' },
        recipient : 'did:example:bob',
      });

      expect(status.code).toBe(202);
      expect(record).toBeInstanceOf(TypedRecord);
      expect(record.protocolPath).toBe('friend');

      const data = await record.data.json();
      expect(data.did).toBe('did:example:bob');
      expect(data.alias).toBe('Bob');
    });

    it('should create a block record with tags', async () => {
      const typed = new TypedEnbox(dwnAlice, SocialGraphProtocol);
      await typed.configure();

      const { status, record } = await typed.records.create('block', {
        data : { did: 'did:example:troll', reason: 'spam' },
        tags : { did: 'did:example:troll' },
      });

      expect(status.code).toBe(202);
      expect(record.protocolPath).toBe('block');

      const data = await record.data.json();
      expect(data.did).toBe('did:example:troll');
      expect(data.reason).toBe('spam');
    });

    it('should create a group with nested members', async () => {
      const typed = new TypedEnbox(dwnAlice, SocialGraphProtocol);
      await typed.configure();

      const { record: groupRecord } = await typed.records.create('group', {
        data: { name: 'Dev Team', description: 'Engineering' },
      });
      expect(groupRecord).toBeDefined();

      const { status, record: memberRecord } = await typed.records.create('group/member', {
        data            : { did: 'did:example:carol', alias: 'Carol' },
        parentContextId : groupRecord.contextId,
        tags            : { did: 'did:example:carol' },
      });

      expect(status.code).toBe(202);
      expect(memberRecord.protocolPath).toBe('group/member');

      const memberData = await memberRecord.data.json();
      expect(memberData.did).toBe('did:example:carol');
    });

    it('should query friend records', async () => {
      const typed = new TypedEnbox(dwnAlice, SocialGraphProtocol);
      await typed.configure();

      await typed.records.create('friend', {
        data      : { did: 'did:example:alice' },
        tags      : { did: 'did:example:alice' },
        recipient : 'did:example:alice',
      });
      await typed.records.create('friend', {
        data      : { did: 'did:example:bob' },
        tags      : { did: 'did:example:bob' },
        recipient : 'did:example:bob',
      });

      const { records } = await typed.records.query('friend');
      expect(records.length).toBe(2);
      expect(records[0]).toBeInstanceOf(TypedRecord);
    });
  });

  // -------------------------------------------------------------------------
  // Profile Protocol — requires Social Graph, uses singletons
  // -------------------------------------------------------------------------

  describe('ProfileProtocol', () => {
    it('should configure after Social Graph is installed', async () => {
      await installSocialGraph();

      const typed = new TypedEnbox(dwnAlice, ProfileProtocol);
      const { status } = await typed.configure();
      expect(status.code).toBe(202);
    });

    it('should set and get a singleton profile via repository', async () => {
      await installSocialGraph();

      const typed = new TypedEnbox(dwnAlice, ProfileProtocol);
      const repo = repository(typed);
      await repo.configure();

      const result = await repo.profile.set({
        data: { displayName: 'Alice', bio: 'Building the future' },
      });

      expect(result.status.code).toBe(202);
      expect(result.record).toBeInstanceOf(TypedRecord);

      const data = await result.record.data.json();
      expect(data.displayName).toBe('Alice');

      // Get the singleton back
      const fetched = await repo.profile.get();
      expect(fetched).toBeInstanceOf(TypedRecord);
      const fetchedData = await fetched.data.json();
      expect(fetchedData.displayName).toBe('Alice');
    });

    it('should upsert a singleton profile on second set()', async () => {
      await installSocialGraph();

      const typed = new TypedEnbox(dwnAlice, ProfileProtocol);
      const repo = repository(typed);
      await repo.configure();

      // First set
      await repo.profile.set({ data: { displayName: 'Alice v1' } });

      // Second set — should upsert
      const result = await repo.profile.set({
        data: { displayName: 'Alice v2', bio: 'Updated bio' },
      });

      expect(result.status.code).toBe(202);

      const fetched = await repo.profile.get();
      expect(fetched).toBeInstanceOf(TypedRecord);
      const data = await fetched.data.json();
      expect(data.displayName).toBe('Alice v2');
      expect(data.bio).toBe('Updated bio');
    });

    it('should create nested links under profile', async () => {
      await installSocialGraph();

      const typed = new TypedEnbox(dwnAlice, ProfileProtocol);
      const repo = repository(typed);
      await repo.configure();

      const { record: profileRecord } = await repo.profile.set({
        data: { displayName: 'Alice' },
      });

      const linkResult = await repo.profile.link.create(profileRecord.contextId, {
        data: { url: 'https://twitter.com/alice', title: 'Twitter' },
      });

      expect(linkResult.status.code).toBe(202);
      expect(linkResult.record.protocolPath).toBe('profile/link');

      const linkData = await linkResult.record.data.json();
      expect(linkData.url).toBe('https://twitter.com/alice');
    });
  });

  // -------------------------------------------------------------------------
  // Connect Protocol — standalone, singleton wallet
  // -------------------------------------------------------------------------

  describe('ConnectProtocol', () => {
    it('should configure and set wallet singleton', async () => {
      const typed = new TypedEnbox(dwnAlice, ConnectProtocol);
      const repo = repository(typed);
      await repo.configure();

      const result = await repo.wallet.set({
        data: { webWallets: ['https://wallet.example.com'] },
      });

      expect(result.status.code).toBe(202);

      const fetched = await repo.wallet.get();
      expect(fetched).toBeInstanceOf(TypedRecord);
      const data = await fetched.data.json();
      expect(data.webWallets).toEqual(['https://wallet.example.com']);
    });

    it('should upsert wallet on second set()', async () => {
      const typed = new TypedEnbox(dwnAlice, ConnectProtocol);
      const repo = repository(typed);
      await repo.configure();

      await repo.wallet.set({
        data: { webWallets: ['https://v1.wallet.com'] },
      });

      await repo.wallet.set({
        data: { webWallets: ['https://v2.wallet.com', 'https://alt.wallet.com'] },
      });

      const fetched = await repo.wallet.get();
      expect(fetched).toBeInstanceOf(TypedRecord);
      const data = await fetched.data.json();
      expect(data.webWallets).toEqual(['https://v2.wallet.com', 'https://alt.wallet.com']);
    });
  });

  // -------------------------------------------------------------------------
  // Status Protocol — requires Social Graph, nested reactions
  // -------------------------------------------------------------------------

  describe('StatusProtocol', () => {
    it('should configure and create a status record', async () => {
      await installSocialGraph();

      const typed = new TypedEnbox(dwnAlice, StatusProtocol);
      await typed.configure();

      const { status, record } = await typed.records.create('status', {
        data: { text: 'Hello world!', emoji: '🌍' },
      });

      expect(status.code).toBe(202);
      expect(record).toBeInstanceOf(TypedRecord);
      expect(record.protocolPath).toBe('status');

      const data = await record.data.json();
      expect(data.text).toBe('Hello world!');
    });

    it('should query status records', async () => {
      await installSocialGraph();

      const typed = new TypedEnbox(dwnAlice, StatusProtocol);
      await typed.configure();

      await typed.records.create('status', { data: { text: 'Status 1' } });
      await typed.records.create('status', { data: { text: 'Status 2' } });

      const { records } = await typed.records.query('status');
      expect(records.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Lists Protocol — requires Social Graph, deep nesting
  // -------------------------------------------------------------------------

  describe('ListsProtocol', () => {
    it('should configure after Social Graph is installed', async () => {
      await installSocialGraph();

      const typed = new TypedEnbox(dwnAlice, ListsProtocol);
      const { status } = await typed.configure();
      expect(status.code).toBe(202);
    });

    it('should create folders with 3-level nesting', async () => {
      await installSocialGraph();

      const typed = new TypedEnbox(dwnAlice, ListsProtocol);
      await typed.configure();

      const { record: folder1 } = await typed.records.create('folder', {
        data: { name: 'Projects' },
      });
      expect(folder1).toBeDefined();

      const { record: folder2 } = await typed.records.create('folder/folder', {
        data            : { name: 'Work' },
        parentContextId : folder1.contextId,
      });
      expect(folder2).toBeDefined();
      expect(folder2.protocolPath).toBe('folder/folder');

      const { status, record: folder3 } = await typed.records.create('folder/folder/folder', {
        data            : { name: 'Q1' },
        parentContextId : folder2.contextId,
      });
      expect(status.code).toBe(202);
      expect(folder3.protocolPath).toBe('folder/folder/folder');
    });

    it('should query nested folders under a parent', async () => {
      await installSocialGraph();

      const typed = new TypedEnbox(dwnAlice, ListsProtocol);
      await typed.configure();

      const { record: folder1 } = await typed.records.create('folder', {
        data: { name: 'Root Folder' },
      });

      await typed.records.create('folder/folder', {
        data            : { name: 'Sub A' },
        parentContextId : folder1.contextId,
      });
      await typed.records.create('folder/folder', {
        data            : { name: 'Sub B' },
        parentContextId : folder1.contextId,
      });

      const { records } = await typed.records.query('folder/folder', {
        filter: { contextId: folder1.contextId },
      });
      expect(records.length).toBe(2);
    });
  });
});
