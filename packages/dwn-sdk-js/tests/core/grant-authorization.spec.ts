import { describe, expect, it } from 'bun:test';

import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { GrantAuthorization } from '../../src/core/grant-authorization.js';

describe('GrantAuthorization', () => {
  describe('verifyGrantScopeInterfaceAndMethod', () => {
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

      // Mock message store that returns no revocations.
      const mockMessageStore = {
        query: async (): Promise<any> => ({ messages: [] }),
      };

      await expect(
        GrantAuthorization.performBaseValidation({
          incomingMessage : mockMessage as any,
          expectedGrantor : 'did:example:grantor',
          expectedGrantee : 'did:example:grantee',
          permissionGrant : mockGrant as any,
          messageStore    : mockMessageStore as any,
        })
      ).rejects.toThrow(DwnErrorCode.GrantAuthorizationMethodMismatch);
    });
  });
});
