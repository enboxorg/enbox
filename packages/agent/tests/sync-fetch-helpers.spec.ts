import sinon from 'sinon';

import { TestDataGenerator } from '@enbox/dwn-sdk-js';
import { describe, expect, it } from 'bun:test';

import { DwnInterface } from '../src/types/dwn.js';
import { PermissionGrantNotFoundError } from '../src/permissions-api.js';
import {
  dependencyKey,
  hasTerminalDependency,
  isTenantProtocolConfig,
  missingDependencyDetail,
  newestProtocolConfig,
  resolveDelegatePermissionGrantId,
} from '../src/sync-fetch-helpers.js';

describe('sync-fetch-helpers', () => {
  describe('resolveDelegatePermissionGrantId', () => {
    it('returns undefined when there is no delegate', async () => {
      const result = await resolveDelegatePermissionGrantId(
        { did: 'did:example:alice' },
        DwnInterface.RecordsQuery,
        'https://example.com/protocol',
      );
      expect(result).toBeUndefined();
    });

    it('returns undefined when no permissions API is configured', async () => {
      const result = await resolveDelegatePermissionGrantId(
        { did: 'did:example:alice', delegateDid: 'did:example:delegate' },
        DwnInterface.RecordsQuery,
        'https://example.com/protocol',
      );
      expect(result).toBeUndefined();
    });

    it('returns the grant id when a matching grant exists', async () => {
      const permissionsApi = { getPermissionForRequest: sinon.stub().resolves({ grant: { id: 'grant-123' } }) };
      const result = await resolveDelegatePermissionGrantId(
        { did: 'did:example:alice', delegateDid: 'did:example:delegate', permissionsApi: permissionsApi as any },
        DwnInterface.RecordsQuery,
        'https://example.com/protocol',
      );
      expect(result).toBe('grant-123');
      expect(permissionsApi.getPermissionForRequest.firstCall.args[0]).toEqual({
        connectedDid : 'did:example:alice',
        delegateDid  : 'did:example:delegate',
        messageType  : DwnInterface.RecordsQuery,
        protocol     : 'https://example.com/protocol',
      });
    });

    it('returns undefined when no matching grant exists (expected not-found)', async () => {
      const permissionsApi = {
        getPermissionForRequest: sinon.stub().rejects(
          new PermissionGrantNotFoundError({
            messageType : DwnInterface.RecordsQuery,
            protocol    : 'https://example.com/protocol',
          })
        ),
      };
      const result = await resolveDelegatePermissionGrantId(
        { did: 'did:example:alice', delegateDid: 'did:example:delegate', permissionsApi: permissionsApi as any },
        DwnInterface.RecordsQuery,
        'https://example.com/protocol',
      );
      expect(result).toBeUndefined();
    });

    it('surfaces an unexpected error instead of treating it as no grant', async () => {
      const permissionsApi = {
        getPermissionForRequest: sinon.stub().rejects(new Error('PermissionsApi: Failed to fetch grants: 500 boom')),
      };
      await expect(resolveDelegatePermissionGrantId(
        { did: 'did:example:alice', delegateDid: 'did:example:delegate', permissionsApi: permissionsApi as any },
        DwnInterface.RecordsQuery,
        'https://example.com/protocol',
      )).rejects.toThrow('Failed to fetch grants');
    });
  });

  describe('dependency ref helpers', () => {
    it('dependencyKey is stable and distinguishes refs', () => {
      expect(dependencyKey({ type: 'Protocol', protocol: 'p' }))
        .toBe(dependencyKey({ type: 'Protocol', protocol: 'p' }));
      expect(dependencyKey({ type: 'Protocol', protocol: 'p' }))
        .not.toBe(dependencyKey({ type: 'Protocol', protocol: 'q' }));
    });

    it('hasTerminalDependency detects a terminal ref', () => {
      expect(hasTerminalDependency([{ type: 'Protocol', protocol: 'p' }])).toBe(false);
      expect(hasTerminalDependency([{ type: 'Protocol', protocol: 'p', terminal: true }])).toBe(true);
    });

    it('missingDependencyDetail lists each ref', () => {
      const detail = missingDependencyDetail([
        { type: 'Protocol', protocol: 'p' },
        { type: 'Grant', permissionGrantId: 'g' },
      ]);
      expect(detail).toContain('Protocol');
      expect(detail).toContain('Grant');
    });
  });

  describe('protocol config helpers', () => {
    it('newestProtocolConfig picks the latest by timestamp', () => {
      const older = { descriptor: { messageTimestamp: '2024-01-01T00:00:00.000Z' } } as any;
      const newer = { descriptor: { messageTimestamp: '2024-02-01T00:00:00.000Z' } } as any;
      expect(newestProtocolConfig([older, newer])).toBe(newer);
      expect(newestProtocolConfig([newer, older])).toBe(newer);
      expect(newestProtocolConfig([])).toBeUndefined();
    });

    it('isTenantProtocolConfig matches the tenant own config for the protocol', async () => {
      const { message, author } = await TestDataGenerator.generateProtocolsConfigure();
      const protocol = message.descriptor.definition.protocol;

      expect(isTenantProtocolConfig(author.did, protocol)(message)).toBe(true);
      expect(isTenantProtocolConfig('did:example:other', protocol)(message)).toBe(false);
      expect(isTenantProtocolConfig(author.did, 'https://other.example/proto')(message)).toBe(false);
    });
  });
});
