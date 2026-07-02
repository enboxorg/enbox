import type { PermissionScope } from '../../src/types/permission-types.js';
import type { PublicKeyJwk } from '../../src/types/jose-types.js';
import type { GrantKeyEligibleRecordsScope, GrantKeyProtocolPathScope } from '../../src/utils/grant-key-coverage.js';
import type { ProtocolDefinition, ProtocolRuleSet } from '../../src/types/protocols-types.js';

import { describe, expect, it } from 'bun:test';

import { KeyDerivationScheme } from '../../src/utils/hd-key.js';
import { ProtocolAction } from '../../src/types/protocols-types.js';
import { DwnInterfaceName, DwnMethodName } from '../../src/enums/dwn-interface-method.js';
import {
  getGrantKeyDeliveryScopes,
  grantKeyScopeCoversDeliveredScope,
  isGrantKeyEligibleRecordsScope,
  isGrantKeyRecordsScope,
} from '../../src/utils/grant-key-coverage.js';

const protocol = 'https://example.com/chat';
const otherProtocol = 'https://example.com/other';
const publicKeyJwk: PublicKeyJwk = {
  crv : 'X25519',
  kty : 'OKP',
  x   : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
};

describe('GrantKeyCoverage', () => {
  describe('isGrantKeyRecordsScope()', () => {
    it('should identify Records read and write scopes with a protocol', () => {
      expect(isGrantKeyRecordsScope(recordsReadScope())).toBe(true);
      expect(isGrantKeyRecordsScope(recordsWriteScope())).toBe(true);
    });

    it('should reject non-Records scopes, Records delete scopes, and scopes without a protocol', () => {
      expect(isGrantKeyRecordsScope({
        interface : DwnInterfaceName.Messages,
        method    : DwnMethodName.Read,
        protocol,
      })).toBe(false);

      expect(isGrantKeyRecordsScope({
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Delete,
        protocol,
      })).toBe(false);

      expect(isGrantKeyRecordsScope({
        interface : DwnInterfaceName.Protocols,
        method    : DwnMethodName.Query,
      })).toBe(false);

      expect(isGrantKeyRecordsScope({
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Read,
      } as PermissionScope)).toBe(false);
    });
  });

  describe('isGrantKeyEligibleRecordsScope()', () => {
    it('should reject context-scoped Records grants', () => {
      const contextScopedGrant: PermissionScope = {
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Read,
        protocol,
        contextId : 'context-1',
      };

      expect(isGrantKeyEligibleRecordsScope(contextScopedGrant)).toBe(false);
      expect(isGrantKeyEligibleRecordsScope(recordsReadScope())).toBe(true);
      expect(isGrantKeyEligibleRecordsScope({
        interface : DwnInterfaceName.Messages,
        method    : DwnMethodName.Read,
        protocol,
      })).toBe(false);
    });
  });

  describe('getGrantKeyDeliveryScopes()', () => {
    it('should deliver the protocol root key for protocol-scoped read grants', () => {
      expect(getGrantKeyDeliveryScopes(recordsReadScope())).toEqual([{
        scheme: KeyDerivationScheme.ProtocolPath,
        protocol,
      }]);
    });

    it('should deliver read-subtree and referenced local role keys for path-scoped read grants', () => {
      const scopes = getGrantKeyDeliveryScopes(
        recordsReadScope({ protocolPath: 'chat/message' }),
        grantKeyProtocolDefinition(),
      );

      expect(scopeKeys(scopes)).toEqual([
        'chat/admin',
        'chat/member',
        'chat/message',
      ]);
    });

    it('should deliver only the read-subtree key when no protocol definition is supplied', () => {
      const scopes = getGrantKeyDeliveryScopes(recordsReadScope({ protocolPath: 'chat/message' }));

      expect(scopeKeys(scopes)).toEqual([
        'chat/message',
      ]);
    });

    it('should deliver only the read-subtree key when the scoped path is not configured', () => {
      const scopes = getGrantKeyDeliveryScopes(
        recordsReadScope({ protocolPath: 'chat/missing' }),
        grantKeyProtocolDefinition(),
      );

      expect(scopeKeys(scopes)).toEqual([
        'chat/missing',
      ]);
    });

    it('should deliver covered local role keys for write grants', () => {
      const scopes = getGrantKeyDeliveryScopes(
        recordsWriteScope({ protocolPath: 'chat/message' }),
        grantKeyProtocolDefinition(),
      );

      expect(scopeKeys(scopes)).toEqual([
        'chat/message/moderator',
      ]);
    });

    it('should deliver all local role keys for protocol-scoped write grants', () => {
      const scopes = getGrantKeyDeliveryScopes(
        recordsWriteScope(),
        grantKeyProtocolDefinition(),
      );

      expect(scopeKeys(scopes)).toEqual([
        'chat/admin',
        'chat/member',
        'chat/message/moderator',
        'chat/unreferenced',
      ]);
    });

    it('should reject write-grant delivery scope generation without a protocol definition', () => {
      const getDeliveryScopes = getGrantKeyDeliveryScopes as (
        grantScope: GrantKeyEligibleRecordsScope,
        protocolDefinition?: ProtocolDefinition,
      ) => GrantKeyProtocolPathScope[];

      expect(() => getDeliveryScopes(recordsWriteScope())).toThrow('write grants require a protocol definition');
    });
  });

  describe('grantKeyScopeCoversDeliveredScope()', () => {
    it('should allow protocol-scoped read grants to cover any key in the same protocol', () => {
      expect(grantKeyScopeCoversDeliveredScope({
        grantScope     : recordsReadScope(),
        deliveredScope : { protocol },
      })).toBe(true);

      expect(grantKeyScopeCoversDeliveredScope({
        grantScope     : recordsReadScope(),
        deliveredScope : { protocol, protocolPath: 'chat/message/reply' },
      })).toBe(true);
    });

    it('should reject delivered keys outside the grant protocol', () => {
      expect(grantKeyScopeCoversDeliveredScope({
        grantScope     : recordsReadScope(),
        deliveredScope : { protocol: otherProtocol, protocolPath: 'chat/message' },
      })).toBe(false);
    });

    it('should allow path-scoped read grants to cover their subtree', () => {
      expect(grantKeyScopeCoversDeliveredScope({
        grantScope     : recordsReadScope({ protocolPath: 'chat/message' }),
        deliveredScope : { protocol, protocolPath: 'chat/message/reply' },
      })).toBe(true);
    });

    it('should reject protocol root keys and sibling paths for path-scoped read grants', () => {
      expect(grantKeyScopeCoversDeliveredScope({
        grantScope     : recordsReadScope({ protocolPath: 'chat/message' }),
        deliveredScope : { protocol },
      })).toBe(false);

      expect(grantKeyScopeCoversDeliveredScope({
        grantScope     : recordsReadScope({ protocolPath: 'chat/message' }),
        deliveredScope : { protocol, protocolPath: 'chat/message-extra' },
      })).toBe(false);
    });

    it('should allow path-scoped read grants to cover referenced local role paths', () => {
      expect(grantKeyScopeCoversDeliveredScope({
        grantScope         : recordsReadScope({ protocolPath: 'chat/message' }),
        deliveredScope     : { protocol, protocolPath: 'chat/member' },
        protocolDefinition : grantKeyProtocolDefinition(),
      })).toBe(true);
    });

    it('should reject unreferenced, unkeyed, and cross-protocol role paths for path-scoped read grants', () => {
      const definition = grantKeyProtocolDefinition();

      expect(grantKeyScopeCoversDeliveredScope({
        grantScope         : recordsReadScope({ protocolPath: 'chat/message' }),
        deliveredScope     : { protocol, protocolPath: 'chat/unreferenced' },
        protocolDefinition : definition,
      })).toBe(false);

      expect(grantKeyScopeCoversDeliveredScope({
        grantScope         : recordsReadScope({ protocolPath: 'chat/message' }),
        deliveredScope     : { protocol, protocolPath: 'chat/guest' },
        protocolDefinition : definition,
      })).toBe(false);
    });

    it('should allow write grants to cover local role paths in scope', () => {
      expect(grantKeyScopeCoversDeliveredScope({
        grantScope         : recordsWriteScope({ protocolPath: 'chat/message' }),
        deliveredScope     : { protocol, protocolPath: 'chat/message/moderator' },
        protocolDefinition : grantKeyProtocolDefinition(),
      })).toBe(true);
    });

    it('should allow protocol-scoped write grants to cover local role paths', () => {
      expect(grantKeyScopeCoversDeliveredScope({
        grantScope         : recordsWriteScope(),
        deliveredScope     : { protocol, protocolPath: 'chat/member' },
        protocolDefinition : grantKeyProtocolDefinition(),
      })).toBe(true);
    });

    it('should reject protocol root keys, non-role paths, and sibling role paths for write grants', () => {
      const definition = grantKeyProtocolDefinition();
      const grantScope = recordsWriteScope({ protocolPath: 'chat/message' });

      expect(grantKeyScopeCoversDeliveredScope({
        grantScope,
        deliveredScope: { protocol },
      })).toBe(false);

      expect(grantKeyScopeCoversDeliveredScope({
        grantScope,
        deliveredScope     : { protocol, protocolPath: 'chat/message/reply' },
        protocolDefinition : definition,
      })).toBe(false);

      expect(grantKeyScopeCoversDeliveredScope({
        grantScope,
        deliveredScope     : { protocol, protocolPath: 'chat/member' },
        protocolDefinition : definition,
      })).toBe(false);
    });
  });
});

function recordsReadScope(
  overrides: { protocolPath?: string } = {},
): GrantKeyEligibleRecordsScope & { method: typeof DwnMethodName.Read } {
  return {
    interface : DwnInterfaceName.Records,
    method    : DwnMethodName.Read,
    protocol,
    ...overrides,
  };
}

function recordsWriteScope(
  overrides: { protocolPath?: string } = {},
): GrantKeyEligibleRecordsScope & { method: typeof DwnMethodName.Write } {
  return {
    interface : DwnInterfaceName.Records,
    method    : DwnMethodName.Write,
    protocol,
    ...overrides,
  };
}

function grantKeyProtocolDefinition(): ProtocolDefinition {
  return {
    protocol,
    published : true,
    uses      : { external: otherProtocol },
    types     : {
      admin        : {},
      chat         : {},
      guest        : {},
      member       : {},
      message      : {},
      messageExtra : {},
      moderator    : {},
      reply        : {},
      unreferenced : {},
    },
    structure: {
      chat: {
        admin   : roleRuleSet(),
        guest   : { $role: true },
        member  : roleRuleSet(),
        message : {
          $actions: [
            { role: 'chat/member', can: [ProtocolAction.Read] },
            { role: 'chat/guest', can: [ProtocolAction.Read] },
            { role: 'external:member', can: [ProtocolAction.Read] },
          ],
          moderator : roleRuleSet(),
          reply     : {
            $actions: [
              { role: 'chat/admin', can: [ProtocolAction.Read] },
            ],
          },
        },
        messageExtra: {
          $actions: [
            { role: 'chat/admin', can: [ProtocolAction.Read] },
          ],
        },
        unreferenced: roleRuleSet(),
      },
    },
  };
}

function roleRuleSet(): ProtocolRuleSet {
  return {
    $keyAgreement : { publicKeyJwk },
    $role         : true,
  };
}

function scopeKeys(scopes: { protocolPath?: string }[]): string[] {
  return scopes
    .map((scope) => scope.protocolPath ?? '<protocol>')
    .sort();
}
