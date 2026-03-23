import type { DirectionFrontier } from '../src/types/sync.js';
import type { ProgressToken } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { MAX_PENDING_TOKENS } from '../src/types/sync.js';
import { ReplicationLedger } from '../src/sync-replication-ledger.js';

/** Helper to build a ProgressToken at a given position. */
function token(pos: number, cid?: string): ProgressToken {
  return { streamId: 'stream-1', epoch: 'epoch-1', position: String(pos), messageCid: cid ?? `cid-${pos}` };
}

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
    it('should create a new link with initializing status and empty frontiers', async () => {
      const link = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
      });

      expect(link.tenantDid).toBe('did:example:alice');
      expect(link.remoteEndpoint).toBe('https://dwn.example.com');
      expect(link.scopeId.length).toBeGreaterThan(0);
      expect(link.status).toBe('initializing');
      expect(link.pull.pendingTokens).toEqual([]);
      expect(link.push.pendingTokens).toEqual([]);
      expect(link.pull.contiguousAppliedToken).toBeUndefined();
      expect(link.push.contiguousAppliedToken).toBeUndefined();
    });

    it('should return existing link on second call', async () => {
      const link1 = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
      });

      // Modify and save.
      link1.status = 'live';
      await ledger.saveLink(link1);

      // Second call should return the saved version.
      const link2 = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
      });

      expect(link2.status).toBe('live');
    });

    it('should create separate links for different endpoints', async () => {
      const linkA = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://a.example.com',
        scope          : { kind: 'full' },
      });

      const linkB = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://b.example.com',
        scope          : { kind: 'full' },
      });

      expect(linkA.scopeId).toBe(linkB.scopeId); // same scope
      expect(linkA.remoteEndpoint).not.toBe(linkB.remoteEndpoint);
    });

    it('should store delegateDid and protocol on creation', async () => {
      const link = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
        delegateDid    : 'did:example:delegate',
        protocol       : 'https://protocol.xyz',
      });

      expect(link.delegateDid).toBe('did:example:delegate');
      expect(link.protocol).toBe('https://protocol.xyz');
    });
  });

  describe('saveLink', () => {
    it('should persist frontier changes', async () => {
      const link = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
      });

      link.pull.contiguousAppliedToken = token(42);
      await ledger.saveLink(link);

      // Re-read.
      const reloaded = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
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
      });

      await ledger.deleteLink(link.tenantDid, link.remoteEndpoint, link.scopeId);

      // Should create a fresh link on next call.
      const fresh = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
      });

      expect(fresh.status).toBe('initializing');
    });
  });

  describe('getLinksForTenant', () => {
    it('should return only links for the specified tenant', async () => {
      await ledger.getOrCreateLink({
        tenantDid: 'did:example:alice', remoteEndpoint: 'https://a.example.com', scope: { kind: 'full' },
      });
      await ledger.getOrCreateLink({
        tenantDid: 'did:example:alice', remoteEndpoint: 'https://b.example.com', scope: { kind: 'full' },
      });
      await ledger.getOrCreateLink({
        tenantDid: 'did:example:bob', remoteEndpoint: 'https://a.example.com', scope: { kind: 'full' },
      });

      const aliceLinks = await ledger.getLinksForTenant('did:example:alice');
      expect(aliceLinks).toHaveLength(2);
      expect(aliceLinks.every(l => l.tenantDid === 'did:example:alice')).toBe(true);
    });
  });

  describe('getAllLinks', () => {
    it('should return all links', async () => {
      await ledger.getOrCreateLink({
        tenantDid: 'did:example:alice', remoteEndpoint: 'https://a.example.com', scope: { kind: 'full' },
      });
      await ledger.getOrCreateLink({
        tenantDid: 'did:example:bob', remoteEndpoint: 'https://b.example.com', scope: { kind: 'full' },
      });

      const all = await ledger.getAllLinks();
      expect(all).toHaveLength(2);
    });
  });

  describe('setStatus', () => {
    it('should update status and persist', async () => {
      const link = await ledger.getOrCreateLink({
        tenantDid: 'did:example:alice', remoteEndpoint: 'https://dwn.example.com', scope: { kind: 'full' },
      });

      expect(link.status).toBe('initializing');

      await ledger.setStatus(link, 'live');
      expect(link.status).toBe('live');

      // Verify persisted.
      const reloaded = await ledger.getOrCreateLink({
        tenantDid: 'did:example:alice', remoteEndpoint: 'https://dwn.example.com', scope: { kind: 'full' },
      });
      expect(reloaded.status).toBe('live');
    });
  });

  // ---------------------------------------------------------------------------
  // Frontier progression
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
      const big1 = { ...token(0), position: '9007199254740993' }; // > MAX_SAFE_INTEGER
      const big2 = { ...token(0), position: '9007199254740994' };
      expect(ReplicationLedger.comparePosition(big1, big2)).toBeLessThan(0);
    });
  });

  describe('advanceFrontier', () => {
    it('should set contiguousAppliedToken on first token', () => {
      const frontier: DirectionFrontier = { pendingTokens: [] };

      const result = ReplicationLedger.advanceFrontier(frontier, token(1));

      expect(result).toBe('ok');
      expect(frontier.contiguousAppliedToken).toEqual(token(1));
      expect(frontier.receivedToken).toEqual(token(1));
      expect(frontier.pendingTokens).toEqual([]);
    });

    it('should advance contiguously for sequential tokens', () => {
      const frontier: DirectionFrontier = { pendingTokens: [] };

      ReplicationLedger.advanceFrontier(frontier, token(1));
      ReplicationLedger.advanceFrontier(frontier, token(2));
      ReplicationLedger.advanceFrontier(frontier, token(3));

      expect(frontier.contiguousAppliedToken).toEqual(token(3));
      expect(frontier.pendingTokens).toEqual([]);
    });

    it('should add out-of-order tokens to pending', () => {
      const frontier: DirectionFrontier = { pendingTokens: [] };

      ReplicationLedger.advanceFrontier(frontier, token(1));
      ReplicationLedger.advanceFrontier(frontier, token(3)); // gap at 2

      expect(frontier.contiguousAppliedToken).toEqual(token(1));
      expect(frontier.pendingTokens).toEqual([token(3)]);
    });

    it('should drain pending when the gap is filled', () => {
      const frontier: DirectionFrontier = { pendingTokens: [] };

      ReplicationLedger.advanceFrontier(frontier, token(1));
      ReplicationLedger.advanceFrontier(frontier, token(3));
      ReplicationLedger.advanceFrontier(frontier, token(4));

      // pendingTokens has [3, 4], contiguous is still 1.
      expect(frontier.contiguousAppliedToken).toEqual(token(1));
      expect(frontier.pendingTokens).toEqual([token(3), token(4)]);

      // Now fill the gap at 2.
      ReplicationLedger.advanceFrontier(frontier, token(2));

      // Should drain all the way to 4.
      expect(frontier.contiguousAppliedToken).toEqual(token(4));
      expect(frontier.pendingTokens).toEqual([]);
    });

    it('should ignore duplicate tokens', () => {
      const frontier: DirectionFrontier = { pendingTokens: [] };

      ReplicationLedger.advanceFrontier(frontier, token(1));
      ReplicationLedger.advanceFrontier(frontier, token(1)); // duplicate

      expect(frontier.contiguousAppliedToken).toEqual(token(1));
      expect(frontier.pendingTokens).toEqual([]);
    });

    it('should ignore tokens at or behind the contiguous position', () => {
      const frontier: DirectionFrontier = { pendingTokens: [] };

      ReplicationLedger.advanceFrontier(frontier, token(1));
      ReplicationLedger.advanceFrontier(frontier, token(2));
      ReplicationLedger.advanceFrontier(frontier, token(3));

      // Replay an old token.
      ReplicationLedger.advanceFrontier(frontier, token(1));

      expect(frontier.contiguousAppliedToken).toEqual(token(3));
      expect(frontier.pendingTokens).toEqual([]);
    });

    it('should return overflow when pendingTokens exceeds MAX_PENDING_TOKENS', () => {
      const frontier: DirectionFrontier = { pendingTokens: [] };

      // Apply token 1 as baseline.
      ReplicationLedger.advanceFrontier(frontier, token(1));

      // Skip token 2, then add MAX_PENDING_TOKENS + 1 out-of-order tokens.
      for (let i = 3; i <= MAX_PENDING_TOKENS + 3; i++) {
        ReplicationLedger.advanceFrontier(frontier, token(i));
      }

      // The last call should return overflow.
      const result = ReplicationLedger.advanceFrontier(frontier, token(MAX_PENDING_TOKENS + 4));
      expect(result).toBe('overflow');
    });

    it('should maintain pending in ascending position order', () => {
      const frontier: DirectionFrontier = { pendingTokens: [] };

      ReplicationLedger.advanceFrontier(frontier, token(1));

      // Add out-of-order: 5, 3, 7, 4
      ReplicationLedger.advanceFrontier(frontier, token(5));
      ReplicationLedger.advanceFrontier(frontier, token(3));
      ReplicationLedger.advanceFrontier(frontier, token(7));
      ReplicationLedger.advanceFrontier(frontier, token(4));

      const positions = frontier.pendingTokens.map(t => Number(t.position));
      expect(positions).toEqual([3, 4, 5, 7]);
    });

    it('should not add duplicate pending tokens', () => {
      const frontier: DirectionFrontier = { pendingTokens: [] };

      ReplicationLedger.advanceFrontier(frontier, token(1));
      ReplicationLedger.advanceFrontier(frontier, token(5));
      ReplicationLedger.advanceFrontier(frontier, token(5)); // duplicate

      expect(frontier.pendingTokens).toHaveLength(1);
    });
  });

  describe('resetFrontier', () => {
    it('should clear pending and set the token', () => {
      const frontier: DirectionFrontier = {
        receivedToken          : token(10),
        contiguousAppliedToken : token(5),
        pendingTokens          : [token(7), token(8), token(9)],
      };

      ReplicationLedger.resetFrontier(frontier, token(10));

      expect(frontier.contiguousAppliedToken).toEqual(token(10));
      expect(frontier.receivedToken).toEqual(token(10));
      expect(frontier.pendingTokens).toEqual([]);
    });

    it('should clear to undefined when no token is provided', () => {
      const frontier: DirectionFrontier = {
        receivedToken          : token(10),
        contiguousAppliedToken : token(5),
        pendingTokens          : [token(7)],
      };

      ReplicationLedger.resetFrontier(frontier);

      expect(frontier.contiguousAppliedToken).toBeUndefined();
      expect(frontier.receivedToken).toBeUndefined();
      expect(frontier.pendingTokens).toEqual([]);
    });
  });
});
