import type { DirectionCheckpoint } from '../src/types/sync.js';
import type { ProgressToken } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { ReplicationLedger } from '../src/sync-replication-ledger.js';

/** Helper to build a ProgressToken at a given position. */
function token(pos: number, cid?: string): ProgressToken {
  return { streamId: 'stream-1', epoch: 'epoch-1', position: String(pos), messageCid: cid ?? `cid-${pos}` };
}

const ownerAuthorization = {
  authorization      : { kind: 'owner' as const },
  authorizationEpoch : 'owner-epoch',
};

describe('ReplicationLedger', () => {
  let db: Level<string, string>;
  let ledger: ReplicationLedger;

  beforeAll(async () => {
    db = new Level<string, string>('__TESTDATA__/replication-ledger-spec');
    ledger = new ReplicationLedger(db);
  });

  afterEach(async () => {
    await db.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  describe('getOrCreateLink', () => {
    it('should create a new link with initializing status and empty checkpoints', async () => {
      const link = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
        ...ownerAuthorization,
      });

      expect(link.tenantDid).toBe('did:example:alice');
      expect(link.remoteEndpoint).toBe('https://dwn.example.com');
      expect(link.projectionId.length).toBeGreaterThan(0);
      expect(link.authorizationEpoch).toBe('owner-epoch');
      expect(link.authorization).toEqual({ kind: 'owner' });
      expect(link.status).toBe('initializing');
      expect(link.pull.contiguousAppliedToken).toBeUndefined();
    });

    it('should return existing link on second call', async () => {
      const link1 = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
        ...ownerAuthorization,
      });

      link1.status = 'live';
      await ledger.saveLink(link1);

      const link2 = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
        ...ownerAuthorization,
      });

      expect(link2.status).toBe('live');
    });

    it('should create separate links for different endpoints', async () => {
      const linkA = await ledger.getOrCreateLink({
        tenantDid: 'did:example:alice', remoteEndpoint: 'https://a.example.com', scope: { kind: 'full' }, ...ownerAuthorization,
      });
      const linkB = await ledger.getOrCreateLink({
        tenantDid: 'did:example:alice', remoteEndpoint: 'https://b.example.com', scope: { kind: 'full' }, ...ownerAuthorization,
      });

      expect(linkA.projectionId).toBe(linkB.projectionId);
      expect(linkA.remoteEndpoint).not.toBe(linkB.remoteEndpoint);
    });

    it('should create separate links for the same projection with different authorization epochs', async () => {
      const ownerLink = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'protocolSet', protocols: ['https://protocol.xyz'] },
        ...ownerAuthorization,
      });
      const delegateLink = await ledger.getOrCreateLink({
        tenantDid          : 'did:example:alice',
        remoteEndpoint     : 'https://dwn.example.com',
        scope              : { kind: 'protocolSet', protocols: ['https://protocol.xyz'] },
        authorizationEpoch : 'delegate-epoch',
        authorization      : {
          kind               : 'delegate',
          delegateDid        : 'did:example:delegate',
          permissionGrantIds : ['grant-1'],
        },
        delegateDid: 'did:example:delegate',
      });

      expect(ownerLink.projectionId).toBe(delegateLink.projectionId);
      expect(ownerLink.authorizationEpoch).not.toBe(delegateLink.authorizationEpoch);
      expect((await ledger.getLinksForTenant('did:example:alice'))).toHaveLength(2);
    });

    it('should store delegate authorization metadata on creation', async () => {
      const link = await ledger.getOrCreateLink({
        tenantDid          : 'did:example:alice',
        remoteEndpoint     : 'https://dwn.example.com',
        scope              : { kind: 'protocolSet', protocols: ['https://protocol.xyz'] },
        authorizationEpoch : 'delegate-epoch',
        authorization      : {
          kind               : 'delegate',
          delegateDid        : 'did:example:delegate',
          permissionGrantIds : ['grant-1'],
        },
        delegateDid: 'did:example:delegate',
      });

      expect(link.delegateDid).toBe('did:example:delegate');
      expect(link.authorization).toEqual({
        kind               : 'delegate',
        delegateDid        : 'did:example:delegate',
        permissionGrantIds : ['grant-1'],
      });
    });

  });

  describe('saveLink', () => {
    it('should persist checkpoint changes', async () => {
      const link = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
        ...ownerAuthorization,
      });

      link.pull.contiguousAppliedToken = token(42);
      await ledger.saveLink(link);

      const reloaded = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
        ...ownerAuthorization,
      });

      expect(reloaded.pull.contiguousAppliedToken).toEqual(token(42));
      expect(reloaded.lastActivityAt).toBeDefined();
    });
  });

  describe('deleteLink', () => {
    it('should remove a link', async () => {
      const link = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
        ...ownerAuthorization,
      });

      await ledger.deleteLink(link.tenantDid, link.remoteEndpoint, link.projectionId, link.authorizationEpoch);

      const fresh = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
        ...ownerAuthorization,
      });

      expect(fresh.status).toBe('initializing');
    });
  });

  describe('getLinksForTenant', () => {
    it('should return only links for the specified tenant', async () => {
      await ledger.getOrCreateLink({
        tenantDid: 'did:example:alice', remoteEndpoint: 'https://a.example.com', scope: { kind: 'full' }, ...ownerAuthorization,
      });
      await ledger.getOrCreateLink({
        tenantDid: 'did:example:alice', remoteEndpoint: 'https://b.example.com', scope: { kind: 'full' }, ...ownerAuthorization,
      });
      await ledger.getOrCreateLink({
        tenantDid: 'did:example:bob', remoteEndpoint: 'https://a.example.com', scope: { kind: 'full' }, ...ownerAuthorization,
      });

      const aliceLinks = await ledger.getLinksForTenant('did:example:alice');
      expect(aliceLinks).toHaveLength(2);
      expect(aliceLinks.every(l => l.tenantDid === 'did:example:alice')).toBe(true);
    });
  });

  describe('getAllLinks', () => {
    it('should return all links', async () => {
      await ledger.getOrCreateLink({
        tenantDid: 'did:example:alice', remoteEndpoint: 'https://a.example.com', scope: { kind: 'full' }, ...ownerAuthorization,
      });
      await ledger.getOrCreateLink({
        tenantDid: 'did:example:bob', remoteEndpoint: 'https://b.example.com', scope: { kind: 'full' }, ...ownerAuthorization,
      });

      const all = await ledger.getAllLinks();
      expect(all).toHaveLength(2);
    });
  });

  describe('setStatus', () => {
    it('should update status and persist', async () => {
      const link = await ledger.getOrCreateLink({
        tenantDid: 'did:example:alice', remoteEndpoint: 'https://dwn.example.com', scope: { kind: 'full' }, ...ownerAuthorization,
      });

      expect(link.status).toBe('initializing');

      await ledger.setStatus(link, 'live');
      expect(link.status).toBe('live');

      const reloaded = await ledger.getOrCreateLink({
        tenantDid: 'did:example:alice', remoteEndpoint: 'https://dwn.example.com', scope: { kind: 'full' }, ...ownerAuthorization,
      });
      expect(reloaded.status).toBe('live');
    });
  });

  // ---------------------------------------------------------------------------
  // Minimal checkpoint helpers
  // ---------------------------------------------------------------------------

  describe('comparePosition', () => {
    it('should return negative for a < b', () => {
      expect(ReplicationLedger.comparePosition(token(1), token(2))).toBeLessThan(0);
    });

    it('should return zero for equal positions', () => {
      expect(ReplicationLedger.comparePosition(token(5), token(5))).toBe(0);
    });

    it('should return positive for a > b', () => {
      expect(ReplicationLedger.comparePosition(token(10), token(3))).toBeGreaterThan(0);
    });

    it('should handle large BigInt values safely', () => {
      const big1 = { ...token(0), position: '9007199254740993' };
      const big2 = { ...token(0), position: '9007199254740994' };
      expect(ReplicationLedger.comparePosition(big1, big2)).toBeLessThan(0);
    });
  });

  describe('validateTokenDomain', () => {
    it('should return true when checkpoint has no baseline', () => {
      const checkpoint: DirectionCheckpoint = {};
      expect(ReplicationLedger.validateTokenDomain(checkpoint, token(1))).toBe(true);
    });

    it('should return true for matching streamId and epoch', () => {
      const checkpoint: DirectionCheckpoint = { contiguousAppliedToken: token(1) };
      expect(ReplicationLedger.validateTokenDomain(checkpoint, token(5))).toBe(true);
    });

    it('should return false for mismatched streamId', () => {
      const checkpoint: DirectionCheckpoint = { contiguousAppliedToken: token(1) };
      const foreign = { streamId: 'other-stream', epoch: 'epoch-1', position: '2', messageCid: 'cid-2' };
      expect(ReplicationLedger.validateTokenDomain(checkpoint, foreign)).toBe(false);
    });

    it('should return false for mismatched epoch', () => {
      const checkpoint: DirectionCheckpoint = { contiguousAppliedToken: token(1) };
      const stale = { streamId: 'stream-1', epoch: 'old-epoch', position: '2', messageCid: 'cid-2' };
      expect(ReplicationLedger.validateTokenDomain(checkpoint, stale)).toBe(false);
    });
  });

  describe('setReceivedToken', () => {
    it('should set receivedToken to the highest seen', () => {
      const checkpoint: DirectionCheckpoint = {};
      ReplicationLedger.setReceivedToken(checkpoint, token(5));
      expect(checkpoint.receivedToken).toEqual(token(5));

      ReplicationLedger.setReceivedToken(checkpoint, token(3));
      expect(checkpoint.receivedToken).toEqual(token(5)); // did not regress

      ReplicationLedger.setReceivedToken(checkpoint, token(10));
      expect(checkpoint.receivedToken).toEqual(token(10));
    });
  });

  describe('commitContiguousToken', () => {
    it('should set contiguousAppliedToken', () => {
      const checkpoint: DirectionCheckpoint = {};
      ReplicationLedger.commitContiguousToken(checkpoint, token(42));
      expect(checkpoint.contiguousAppliedToken).toEqual(token(42));
    });

    it('should not move contiguousAppliedToken backward in the same token domain', () => {
      const checkpoint: DirectionCheckpoint = { contiguousAppliedToken: token(42) };

      ReplicationLedger.commitContiguousToken(checkpoint, token(10));

      expect(checkpoint.contiguousAppliedToken).toEqual(token(42));
    });
  });

  describe('resetCheckpoint', () => {
    it('should clear all state and set the token', () => {
      const checkpoint: DirectionCheckpoint = {
        receivedToken          : token(10),
        contiguousAppliedToken : token(5),
      };

      ReplicationLedger.resetCheckpoint(checkpoint, token(10));

      expect(checkpoint.contiguousAppliedToken).toEqual(token(10));
      expect(checkpoint.receivedToken).toEqual(token(10));
    });

    it('should clear to undefined when no token is provided', () => {
      const checkpoint: DirectionCheckpoint = {
        receivedToken          : token(10),
        contiguousAppliedToken : token(5),
      };

      ReplicationLedger.resetCheckpoint(checkpoint);

      expect(checkpoint.contiguousAppliedToken).toBeUndefined();
      expect(checkpoint.receivedToken).toBeUndefined();
    });
  });
});
