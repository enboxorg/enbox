/**
 * Integration tests for protocol-shaped API fixtures.
 *
 * These tests configure each protocol on a real DWN, write records, read them
 * back, and verify end-to-end correctness — including singleton enforcement,
 * nested record creation, and tag enforcement.
 *
 * The fixtures intentionally live in this test file instead of importing
 * `@enbox/protocols`. `@enbox/protocols` depends on `@enbox/api`; importing it
 * from this package's tests would create an api -> protocols -> api workspace
 * cycle.
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
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { EnboxUserAgent } from '@enbox/agent';
import { PlatformAgentTestHarness } from '@enbox/agent/test';

import { defineProtocol } from '../src/define-protocol.js';
import { DwnApi } from '../src/dwn-api.js';
import { Record } from '../src/record.js';
import { testDwnUrl } from './utils/test-config.js';
import { TypedEnbox } from '../src/typed-enbox.js';

// ---------------------------------------------------------------------------
// Local protocol fixtures
// ---------------------------------------------------------------------------

type SocialGraphSchemaMap = {
  friend: { did: string; alias?: string; note?: string };
  block: { did: string; reason?: string };
  group: { name: string; description?: string; icon?: string };
  member: { did: string; alias?: string };
};

const SocialGraphDefinition = {
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
} as const satisfies ProtocolDefinition;

const SocialGraphProtocol = defineProtocol(
  SocialGraphDefinition,
  {} as SocialGraphSchemaMap,
);

type ProfileSchemaMap = {
  profile: {
    displayName: string;
    bio?: string;
    tagline?: string;
    location?: string;
    website?: string;
    pronouns?: string;
  };
  avatar: Blob;
  hero: Blob;
  link: { url: string; title: string; icon?: string; sortOrder?: number };
  privateNote: { content: string };
};

const ProfileDefinition = {
  protocol  : 'https://identity.foundation/protocols/profile',
  published : true,
  uses      : {
    social: 'https://identity.foundation/protocols/social-graph',
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
    privateNote: {
      $actions: [
        { role: 'social:friend', can: ['read'] },
      ],
    },
  },
} as const satisfies ProtocolDefinition;

const ProfileProtocol = defineProtocol(
  ProfileDefinition,
  {} as ProfileSchemaMap,
);

type ConnectSchemaMap = {
  wallet: { webWallets: string[] };
};

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

const ConnectProtocol = defineProtocol(
  ConnectDefinition,
  {} as ConnectSchemaMap,
);

type StatusSchemaMap = {
  status: {
    text: string;
    emoji?: string;
    activity?: 'online' | 'away' | 'busy' | 'offline';
    expiresAt?: string;
  };
  reaction: { emoji: string };
};

const StatusDefinition = {
  protocol  : 'https://identity.foundation/protocols/status',
  published : true,
  uses      : {
    social: 'https://identity.foundation/protocols/social-graph',
  },
  types: {
    status: {
      schema      : 'https://identity.foundation/schemas/status/status',
      dataFormats : ['application/json'],
    },
    reaction: {
      schema      : 'https://identity.foundation/schemas/status/reaction',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    status: {
      $size    : { max: 5000 },
      $actions : [
        { who: 'anyone', can: ['read'] },
        { role: 'social:friend', can: ['read'] },
      ],
      reaction: {
        $actions: [
          { role: 'social:friend', can: ['create', 'read', 'delete'] },
        ],
      },
    },
  },
} as const satisfies ProtocolDefinition;

const StatusProtocol = defineProtocol(
  StatusDefinition,
  {} as StatusSchemaMap,
);

type ListsSchemaMap = {
  list: {
    name: string;
    description?: string;
    icon?: string;
    listType: 'todo' | 'bookmarks' | 'reading' | 'custom';
  };
  item: { title: string; url?: string; note?: string; completed?: boolean; sortOrder?: number };
  folder: { name: string; icon?: string; sortOrder?: number };
  collaborator: { did: string; alias?: string };
  comment: { text: string };
};

const ListsDefinition = {
  protocol  : 'https://identity.foundation/protocols/lists',
  published : false,
  uses      : {
    social: 'https://identity.foundation/protocols/social-graph',
  },
  types: {
    list: {
      schema      : 'https://identity.foundation/schemas/lists/list',
      dataFormats : ['application/json'],
    },
    item: {
      schema      : 'https://identity.foundation/schemas/lists/item',
      dataFormats : ['application/json'],
    },
    folder: {
      schema      : 'https://identity.foundation/schemas/lists/folder',
      dataFormats : ['application/json'],
    },
    collaborator: {
      schema      : 'https://identity.foundation/schemas/lists/collaborator',
      dataFormats : ['application/json'],
    },
    comment: {
      schema      : 'https://identity.foundation/schemas/lists/comment',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    list: {
      $actions: [
        { role: 'social:friend', can: ['read'] },
      ],
      $tags: {
        $requiredTags       : ['listType'],
        $allowUndefinedTags : false,
        listType            : { type: 'string', enum: ['todo', 'bookmarks', 'reading', 'custom'] },
      },
      item: {
        $actions: [
          { role: 'social:friend', can: ['read'] },
          { role: 'list/collaborator', can: ['create', 'read', 'update', 'delete'] },
        ],
        $tags: {
          $allowUndefinedTags : true,
          parentItemId        : { type: 'string' },
        },
        comment: {
          $actions: [
            { role: 'list/collaborator', can: ['create', 'read'] },
          ],
        },
      },
      collaborator: {
        $role    : true,
        $actions : [
          { who: 'anyone', can: ['read'] },
        ],
        $tags: {
          $requiredTags       : ['did'],
          $allowUndefinedTags : false,
          did                 : { type: 'string' },
        },
      },
    },
    folder: {
      $tags: {
        $allowUndefinedTags : true,
        sortOrder           : { type: 'number' },
      },
      folder: {
        folder: {},
      },
    },
  },
} as const satisfies ProtocolDefinition;

const ListsProtocol = defineProtocol(
  ListsDefinition,
  {} as ListsSchemaMap,
);

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
      const record = await typed.records.create('friend', {
        data      : { did: 'did:example:bob', alias: 'Bob' },
        tags      : { did: 'did:example:bob' },
        recipient : 'did:example:bob',
      });

      expect(record).toBeInstanceOf(Record);
      expect(record.protocolPath).toBe('friend');

      const data = await record.data.json();
      expect(data.did).toBe('did:example:bob');
      expect(data.alias).toBe('Bob');
    });

    it('should create a block record with tags', async () => {
      const typed = new TypedEnbox(dwnAlice, SocialGraphProtocol);
      await typed.configure();

      const record = await typed.records.create('block', {
        data : { did: 'did:example:troll', reason: 'spam' },
        tags : { did: 'did:example:troll' },
      });

      expect(record.protocolPath).toBe('block');

      const data = await record.data.json();
      expect(data.did).toBe('did:example:troll');
      expect(data.reason).toBe('spam');
    });

    it('should create a group with nested members', async () => {
      const typed = new TypedEnbox(dwnAlice, SocialGraphProtocol);
      await typed.configure();

      const groupRecord = await typed.records.create('group', {
        data: { name: 'Dev Team', description: 'Engineering' },
      });

      const memberRecord = await typed.records.create('group/member', {
        data            : { did: 'did:example:carol', alias: 'Carol' },
        parentContextId : groupRecord.contextId,
        tags            : { did: 'did:example:carol' },
      });

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
      expect(records).toHaveLength(2);
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

    it('should create and query a singleton profile', async () => {
      await installSocialGraph();

      const typed = new TypedEnbox(dwnAlice, ProfileProtocol);
      await typed.configure();

      const profile = await typed.records.create('profile', {
        data: { displayName: 'Alice', bio: 'Building the future' },
      });

      const data = await profile.data.json();
      expect(data.displayName).toBe('Alice');

      const { records } = await typed.records.query('profile');
      const fetched = records[0];
      const fetchedData = await fetched.data.json();
      expect(fetchedData.displayName).toBe('Alice');
    });

    it('should update a loaded singleton profile explicitly', async () => {
      await installSocialGraph();

      const typed = new TypedEnbox(dwnAlice, ProfileProtocol);
      await typed.configure();

      const record = await typed.records.create('profile', { data: { displayName: 'Alice v1' } });
      const updated = await record.update({
        data: { displayName: 'Alice v2', bio: 'Updated bio' },
      });
      expect(updated).toBe(record);

      const { records } = await typed.records.query('profile');
      const fetched = records[0];
      const data = await fetched.data.json();
      expect(data.displayName).toBe('Alice v2');
      expect(data.bio).toBe('Updated bio');
    });

    it('should create nested links under profile', async () => {
      await installSocialGraph();

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

      const linkData = await link.data.json();
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
      const data = await fetched.data.json();
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

      const record = await typed.records.create('status', {
        data: { text: 'Hello world!', emoji: '🌍' },
      });

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
      expect(records).toHaveLength(2);
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

      const folder1 = await typed.records.create('folder', {
        data: { name: 'Projects' },
      });

      const folder2 = await typed.records.create('folder/folder', {
        data            : { name: 'Work' },
        parentContextId : folder1.contextId,
      });
      expect(folder2.protocolPath).toBe('folder/folder');

      const folder3 = await typed.records.create('folder/folder/folder', {
        data            : { name: 'Q1' },
        parentContextId : folder2.contextId,
      });
      expect(folder3.protocolPath).toBe('folder/folder/folder');
    });

    it('should query nested folders under a parent', async () => {
      await installSocialGraph();

      const typed = new TypedEnbox(dwnAlice, ListsProtocol);
      await typed.configure();

      const folder1 = await typed.records.create('folder', {
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
      expect(records).toHaveLength(2);
    });
  });
});
