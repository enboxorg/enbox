import { describe, expect, it } from 'bun:test';

import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { GrantAuthorization } from '../../src/core/grant-authorization.js';

describe('GrantAuthorization', () => {
  describe('verifyGrantScopeInterfaceAndMethod', () => {
    const validationStateReader = {
      fetchOldestGrantRevocation: async (): Promise<any> => undefined,
    };

    it('should reject Messages grant with method !== Read', async () => {
      // Build a minimal mock that passes grantor/grantee/active checks
      // but has a malformed Messages scope.
      const mockGrant = {
        id          : 'grant-malformed',
        grantor     : 'did:example:grantor',
        grantee     : 'did:example:grantee',
        dateGranted : '2020-01-01T00:00:00.000Z',
        dateExpires : '2040-01-01T00:00:00.000Z',
        scope       : { interface: 'Messages', method: 'Sync', protocol: 'https://proto.example' },
      };

      const mockMessage = {
        descriptor: {
          interface        : 'Messages',
          method           : 'Sync',
          messageTimestamp : '2025-01-01T00:00:00.000Z',
        },
      };

      await expect(
        GrantAuthorization.performBaseValidation({
          incomingMessage       : mockMessage as any,
          expectedGrantor       : 'did:example:grantor',
          expectedGrantee       : 'did:example:grantee',
          permissionGrant       : mockGrant as any,
          validationStateReader : validationStateReader as any,
        })
      ).rejects.toThrow(DwnErrorCode.GrantAuthorizationMethodMismatch);
    });

    it('allows Records Read grants to authorize read-like record methods', async () => {
      const mockGrant = {
        id          : 'grant-records-read',
        grantor     : 'did:example:grantor',
        grantee     : 'did:example:grantee',
        dateGranted : '2020-01-01T00:00:00.000Z',
        dateExpires : '2040-01-01T00:00:00.000Z',
        scope       : { interface: 'Records', method: 'Read', protocol: 'https://proto.example' },
      };

      for (const method of ['Read', 'Query', 'Subscribe', 'Count']) {
        const mockMessage = {
          descriptor: {
            interface        : 'Records',
            method,
            messageTimestamp : '2025-01-01T00:00:00.000Z',
          },
        };

        await expect(
          GrantAuthorization.performBaseValidation({
            incomingMessage       : mockMessage as any,
            expectedGrantor       : 'did:example:grantor',
            expectedGrantee       : 'did:example:grantee',
            permissionGrant       : mockGrant as any,
            validationStateReader : validationStateReader as any,
          })
        ).resolves.toBeUndefined();
      }
    });

    it('rejects read-like Records grants that do not use method Read', async () => {
      for (const method of ['Query', 'Subscribe', 'Count']) {
        const mockGrant = {
          id          : `grant-records-${method.toLowerCase()}`,
          grantor     : 'did:example:grantor',
          grantee     : 'did:example:grantee',
          dateGranted : '2020-01-01T00:00:00.000Z',
          dateExpires : '2040-01-01T00:00:00.000Z',
          scope       : { interface: 'Records', method, protocol: 'https://proto.example' },
        };

        const mockMessage = {
          descriptor: {
            interface        : 'Records',
            method,
            messageTimestamp : '2025-01-01T00:00:00.000Z',
          },
        };

        await expect(
          GrantAuthorization.performBaseValidation({
            incomingMessage       : mockMessage as any,
            expectedGrantor       : 'did:example:grantor',
            expectedGrantee       : 'did:example:grantee',
            permissionGrant       : mockGrant as any,
            validationStateReader : validationStateReader as any,
          })
        ).rejects.toThrow(DwnErrorCode.GrantAuthorizationMethodMismatch);
      }
    });
  });
});
