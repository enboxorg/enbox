import type { ModuleDefinition } from '../../src/types/modules-types.js';
import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import {
  authoredModuleDefinitionsEqual,
  getRoleAudienceContextId,
  getRoleContextPrefix,
  getRoleRecordIdentity,
  getTypeName,
  isCrossModuleRef,
  parseCrossModuleRef,
} from '../../src/utils/modules.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

describe('Module utility functions — fuzz', () => {

  describe('parseCrossModuleRef / isCrossModuleRef consistency', () => {
    it('should agree on whether a string is a cross-module reference', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 50 }),
          (ref) => {
            const parsed = parseCrossModuleRef(ref);
            const isCross = isCrossModuleRef(ref);
            expect(isCross).toBe(parsed !== undefined);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('parseCrossModuleRef — roundtrip reconstruction', () => {
    it('should reconstruct the original string from alias + colon + modulePath', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 20 }).filter((s) => !s.includes(':')),
          fc.string({ minLength: 0, maxLength: 20 }),
          (alias, path) => {
            const input = `${alias}:${path}`;
            const parsed = parseCrossModuleRef(input);
            expect(parsed).toBeDefined();
            expect(`${parsed!.alias}:${parsed!.modulePath}`).toBe(input);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('isCrossModuleRef — strings without colon are never cross-module', () => {
    it('should return false for strings without a colon', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !s.includes(':')),
          (ref) => {
            expect(isCrossModuleRef(ref)).toBe(false);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('getTypeName — last segment of module path', () => {
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
        contextId  : 'role-record',
        module     : 'https://example.com/forum',
        modulePath : 'admin',
        recipient  : 'did:example:alice',
      });
      const rootFromContent = getRoleRecordIdentity({
        contextId  : 'thread/message',
        module     : 'https://example.com/forum',
        modulePath : 'admin',
        recipient  : 'did:example:alice',
      });
      const nestedFromRole = getRoleRecordIdentity({
        contextId  : 'thread/role-record',
        module     : 'https://example.com/forum',
        modulePath : 'thread/participant',
        recipient  : 'did:example:alice',
      });
      const nestedFromContent = getRoleRecordIdentity({
        contextId  : 'thread/role-record/message',
        module     : 'https://example.com/forum',
        modulePath : 'thread/participant',
        recipient  : 'did:example:alice',
      });

      expect(rootFromRecord.contextIdPrefix).toBeUndefined();
      expect(rootFromRecord.key).toBe(rootFromContent.key);
      expect(nestedFromRole.contextIdPrefix).toBe('thread');
      expect(nestedFromRole.key).toBe(nestedFromContent.key);
    });
  });

  describe('module definition policy equality', () => {
    it('ignores injected encryption metadata without mutating the definition', () => {
      const authored: ModuleDefinition = {
        module    : 'https://example.com/module',
        published : true,
        structure : { note: {} },
        types     : { note: {} },
      };
      const installed = structuredClone(authored);
      installed.structure.note.$keyAgreement = {
        publicKeyJwk: { crv: 'X25519', kty: 'OKP', x: 'key' },
      };

      expect(authoredModuleDefinitionsEqual(authored, installed)).toBe(true);
      expect(installed.structure.note.$keyAgreement).toBeDefined();
    });
  });
});
