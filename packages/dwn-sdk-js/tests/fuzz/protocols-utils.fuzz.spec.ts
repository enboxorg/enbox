import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { getRoleAudienceContextId, getRoleContextPrefix, getRoleRecordIdentity, getTypeName, isCrossProtocolRef, parseCrossProtocolRef } from '../../src/utils/protocols.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

describe('Protocol utility functions — fuzz', () => {

  describe('parseCrossProtocolRef / isCrossProtocolRef consistency', () => {
    it('should agree on whether a string is a cross-protocol reference', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 50 }),
          (ref) => {
            const parsed = parseCrossProtocolRef(ref);
            const isCross = isCrossProtocolRef(ref);
            expect(isCross).toBe(parsed !== undefined);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('parseCrossProtocolRef — roundtrip reconstruction', () => {
    it('should reconstruct the original string from alias + colon + protocolPath', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 20 }).filter((s) => !s.includes(':')),
          fc.string({ minLength: 0, maxLength: 20 }),
          (alias, path) => {
            const input = `${alias}:${path}`;
            const parsed = parseCrossProtocolRef(input);
            expect(parsed).toBeDefined();
            expect(`${parsed!.alias}:${parsed!.protocolPath}`).toBe(input);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('isCrossProtocolRef — strings without colon are never cross-protocol', () => {
    it('should return false for strings without a colon', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !s.includes(':')),
          (ref) => {
            expect(isCrossProtocolRef(ref)).toBe(false);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('getTypeName — last segment of protocol path', () => {
    it('should return the last segment after splitting on /', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !s.includes('/')),
            { minLength: 1, maxLength: 5 },
          ),
          (segments) => {
            const path = segments.join('/');
            expect(getTypeName(path)).toBe(segments[segments.length - 1]);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('getRoleAudienceContextId', () => {
    it('should return an empty context id for a root role path', () => {
      expect(getRoleAudienceContextId('member')).toBe('');
      expect(getRoleAudienceContextId('member', 'thread/message')).toBe('');
    });

    it('should return the ancestor context prefix at the role parent depth', () => {
      expect(getRoleAudienceContextId('thread/member', 'thread-record/message-record')).toBe('thread-record');
      expect(getRoleAudienceContextId('thread/message/member', 'thread-record/message-record/reply-record')).toBe('thread-record/message-record');
    });

    it('should return undefined when a nested role path has no covering context id', () => {
      expect(getRoleAudienceContextId('thread/member')).toBeUndefined();
      expect(getRoleAudienceContextId('thread/message/member', 'thread-record')).toBeUndefined();
    });
  });

  describe('getRoleContextPrefix', () => {
    it('should return undefined for a root role path', () => {
      expect(getRoleContextPrefix('member')).toBeUndefined();
      expect(getRoleContextPrefix('member', 'thread/message')).toBeUndefined();
    });

    it('should return the ancestor context prefix at the role parent depth', () => {
      expect(getRoleContextPrefix('thread/member', 'thread-record/message-record')).toBe('thread-record');
      expect(getRoleContextPrefix('thread/message/member', 'thread-record/message-record/reply-record')).toBe('thread-record/message-record');
    });

    it('should return undefined when a nested role path has no covering context id', () => {
      expect(getRoleContextPrefix('thread/member')).toBeUndefined();
      expect(getRoleContextPrefix('thread/message/member', 'thread-record')).toBeUndefined();
    });
  });

  describe('getRoleRecordIdentity', () => {
    it('normalizes root and nested role contexts into stable keys', () => {
      const rootFromRecord = getRoleRecordIdentity({
        contextId    : 'role-record',
        protocol     : 'https://example.com/forum',
        protocolPath : 'admin',
        recipient    : 'did:example:alice',
      });
      const rootFromContent = getRoleRecordIdentity({
        contextId    : 'thread/message',
        protocol     : 'https://example.com/forum',
        protocolPath : 'admin',
        recipient    : 'did:example:alice',
      });
      const nestedFromRole = getRoleRecordIdentity({
        contextId    : 'thread/role-record',
        protocol     : 'https://example.com/forum',
        protocolPath : 'thread/participant',
        recipient    : 'did:example:alice',
      });
      const nestedFromContent = getRoleRecordIdentity({
        contextId    : 'thread/role-record/message',
        protocol     : 'https://example.com/forum',
        protocolPath : 'thread/participant',
        recipient    : 'did:example:alice',
      });

      expect(rootFromRecord.contextIdPrefix).toBeUndefined();
      expect(rootFromRecord.key).toBe(rootFromContent.key);
      expect(nestedFromRole.contextIdPrefix).toBe('thread');
      expect(nestedFromRole.key).toBe(nestedFromContent.key);
    });
  });
});
