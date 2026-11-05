import type { PermissionScope } from '../../src/types/permission-types.js';
import type { PublicKeyJwk } from '../../src/types/jose-types.js';
import type { GrantKeyEligibleRecordsScope, GrantKeyModulePathScope } from '../../src/utils/grant-key-coverage.js';
import type { ModuleDefinition, ModuleRuleSet } from '../../src/types/modules-types.js';

import { describe, expect, it } from 'bun:test';

import { KeyDerivationScheme } from '../../src/utils/hd-key.js';
import { ModuleAction } from '../../src/types/modules-types.js';
import { DwnInterfaceName, DwnMethodName } from '../../src/enums/dwn-interface-method.js';
import {
  getGrantKeyDeliveryScopes,
  grantKeyScopeCoversDeliveredScope,
  isGrantKeyEligibleRecordsScope,
  isGrantKeyRecordsScope,
} from '../../src/utils/grant-key-coverage.js';

const module = 'https://example.com/chat';
const otherModule = 'https://example.com/other';
const publicKeyJwk: PublicKeyJwk = {
  crv : 'X25519',
  kty : 'OKP',
  x   : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
};

describe('GrantKeyCoverage', () => {
  describe('isGrantKeyRecordsScope()', () => {
    it('should identify Records read and write scopes with a module', () => {
      expect(isGrantKeyRecordsScope(recordsReadScope())).toBe(true);
      expect(isGrantKeyRecordsScope(recordsWriteScope())).toBe(true);
    });

    it('should reject non-Records scopes, Records delete scopes, and scopes without a module', () => {
      expect(isGrantKeyRecordsScope({
        interface : DwnInterfaceName.Messages,
        method    : DwnMethodName.Read,
        module,
      })).toBe(false);

      expect(isGrantKeyRecordsScope({
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Delete,
        module,
      })).toBe(false);

      expect(isGrantKeyRecordsScope({
        interface : DwnInterfaceName.Modules,
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
        module,
        contextId : 'context-1',
      };

      expect(isGrantKeyEligibleRecordsScope(contextScopedGrant)).toBe(false);
      expect(isGrantKeyEligibleRecordsScope(recordsReadScope())).toBe(true);
      expect(isGrantKeyEligibleRecordsScope({
        interface : DwnInterfaceName.Messages,
        method    : DwnMethodName.Read,
        module,
      })).toBe(false);
    });
  });

  describe('getGrantKeyDeliveryScopes()', () => {
    it('should deliver the module root key for module-scoped read grants', () => {
      expect(getGrantKeyDeliveryScopes(recordsReadScope())).toEqual([{
        scheme: KeyDerivationScheme.ModulePath,
        module,
      }]);
    });

    it('should deliver read-subtree and referenced local role keys for path-scoped read grants', () => {
      const scopes = getGrantKeyDeliveryScopes(
        recordsReadScope({ modulePath: 'chat/message' }),
        grantKeyModuleDefinition(),
      );

      expect(scopeKeys(scopes)).toEqual([
        'chat/admin',
        'chat/member',
        'chat/message',
      ]);
    });

    it('should deliver only the read-subtree key when no module definition is supplied', () => {
      const scopes = getGrantKeyDeliveryScopes(recordsReadScope({ modulePath: 'chat/message' }));

      expect(scopeKeys(scopes)).toEqual([
        'chat/message',
      ]);
    });

    it('should deliver only the read-subtree key when the scoped path is not configured', () => {
      const scopes = getGrantKeyDeliveryScopes(
        recordsReadScope({ modulePath: 'chat/missing' }),
        grantKeyModuleDefinition(),
      );

      expect(scopeKeys(scopes)).toEqual([
        'chat/missing',
      ]);
    });

    it('should deliver covered local role keys for write grants', () => {
      const scopes = getGrantKeyDeliveryScopes(
        recordsWriteScope({ modulePath: 'chat/message' }),
        grantKeyModuleDefinition(),
      );

      expect(scopeKeys(scopes)).toEqual([
        'chat/message/moderator',
      ]);
    });

    it('should deliver all local role keys for module-scoped write grants', () => {
      const scopes = getGrantKeyDeliveryScopes(
        recordsWriteScope(),
        grantKeyModuleDefinition(),
      );

      expect(scopeKeys(scopes)).toEqual([
        'chat/admin',
        'chat/member',
        'chat/message/moderator',
        'chat/unreferenced',
      ]);
    });

    it('should reject write-grant delivery scope generation without a module definition', () => {
      const getDeliveryScopes = getGrantKeyDeliveryScopes as (
        grantScope: GrantKeyEligibleRecordsScope,
        moduleDefinition?: ModuleDefinition,
      ) => GrantKeyModulePathScope[];

      expect(() => getDeliveryScopes(recordsWriteScope())).toThrow('write grants require a module definition');
    });
  });

  describe('grantKeyScopeCoversDeliveredScope()', () => {
    it('should allow module-scoped read grants to cover any key in the same module', () => {
      expect(grantKeyScopeCoversDeliveredScope({
        grantScope     : recordsReadScope(),
        deliveredScope : { module },
      })).toBe(true);

      expect(grantKeyScopeCoversDeliveredScope({
        grantScope     : recordsReadScope(),
        deliveredScope : { module, modulePath: 'chat/message/reply' },
      })).toBe(true);
    });

    it('should reject delivered keys outside the grant module', () => {
      expect(grantKeyScopeCoversDeliveredScope({
        grantScope     : recordsReadScope(),
        deliveredScope : { module: otherModule, modulePath: 'chat/message' },
      })).toBe(false);
    });

    it('should allow path-scoped read grants to cover their subtree', () => {
      expect(grantKeyScopeCoversDeliveredScope({
        grantScope     : recordsReadScope({ modulePath: 'chat/message' }),
        deliveredScope : { module, modulePath: 'chat/message/reply' },
      })).toBe(true);
    });

    it('should reject module root keys and sibling paths for path-scoped read grants', () => {
      expect(grantKeyScopeCoversDeliveredScope({
        grantScope     : recordsReadScope({ modulePath: 'chat/message' }),
        deliveredScope : { module },
      })).toBe(false);

      expect(grantKeyScopeCoversDeliveredScope({
        grantScope     : recordsReadScope({ modulePath: 'chat/message' }),
        deliveredScope : { module, modulePath: 'chat/message-extra' },
      })).toBe(false);
    });

    it('should allow path-scoped read grants to cover referenced local role paths', () => {
      expect(grantKeyScopeCoversDeliveredScope({
        grantScope       : recordsReadScope({ modulePath: 'chat/message' }),
        deliveredScope   : { module, modulePath: 'chat/member' },
        moduleDefinition : grantKeyModuleDefinition(),
      })).toBe(true);
    });

    it('should reject unreferenced, unkeyed, and cross-module role paths for path-scoped read grants', () => {
      const definition = grantKeyModuleDefinition();

      expect(grantKeyScopeCoversDeliveredScope({
        grantScope       : recordsReadScope({ modulePath: 'chat/message' }),
        deliveredScope   : { module, modulePath: 'chat/unreferenced' },
        moduleDefinition : definition,
      })).toBe(false);

      expect(grantKeyScopeCoversDeliveredScope({
        grantScope       : recordsReadScope({ modulePath: 'chat/message' }),
        deliveredScope   : { module, modulePath: 'chat/guest' },
        moduleDefinition : definition,
      })).toBe(false);
    });

    it('should allow write grants to cover local role paths in scope', () => {
      expect(grantKeyScopeCoversDeliveredScope({
        grantScope       : recordsWriteScope({ modulePath: 'chat/message' }),
        deliveredScope   : { module, modulePath: 'chat/message/moderator' },
        moduleDefinition : grantKeyModuleDefinition(),
      })).toBe(true);
    });

    it('should allow module-scoped write grants to cover local role paths', () => {
      expect(grantKeyScopeCoversDeliveredScope({
        grantScope       : recordsWriteScope(),
        deliveredScope   : { module, modulePath: 'chat/member' },
        moduleDefinition : grantKeyModuleDefinition(),
      })).toBe(true);
    });

    it('should reject module root keys, non-role paths, and sibling role paths for write grants', () => {
      const definition = grantKeyModuleDefinition();
      const grantScope = recordsWriteScope({ modulePath: 'chat/message' });

      expect(grantKeyScopeCoversDeliveredScope({
        grantScope,
        deliveredScope: { module },
      })).toBe(false);

      expect(grantKeyScopeCoversDeliveredScope({
        grantScope,
        deliveredScope   : { module, modulePath: 'chat/message/reply' },
        moduleDefinition : definition,
      })).toBe(false);

      expect(grantKeyScopeCoversDeliveredScope({
        grantScope,
        deliveredScope   : { module, modulePath: 'chat/member' },
        moduleDefinition : definition,
      })).toBe(false);
    });
  });
});

function recordsReadScope(
  overrides: { modulePath?: string } = {},
): GrantKeyEligibleRecordsScope & { method: typeof DwnMethodName.Read } {
  return {
    interface : DwnInterfaceName.Records,
    method    : DwnMethodName.Read,
    module,
    ...overrides,
  };
}

function recordsWriteScope(
  overrides: { modulePath?: string } = {},
): GrantKeyEligibleRecordsScope & { method: typeof DwnMethodName.Write } {
  return {
    interface : DwnInterfaceName.Records,
    method    : DwnMethodName.Write,
    module,
    ...overrides,
  };
}

function grantKeyModuleDefinition(): ModuleDefinition {
  return {
    module,
    published : true,
    uses      : { external: otherModule },
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
            { role: 'chat/member', can: [ModuleAction.Read] },
            { role: 'chat/guest', can: [ModuleAction.Read] },
            { role: 'external:member', can: [ModuleAction.Read] },
          ],
          moderator : roleRuleSet(),
          reply     : {
            $actions: [
              { role: 'chat/admin', can: [ModuleAction.Read] },
            ],
          },
        },
        messageExtra: {
          $actions: [
            { role: 'chat/admin', can: [ModuleAction.Read] },
          ],
        },
        unreferenced: roleRuleSet(),
      },
    },
  };
}

function roleRuleSet(): ModuleRuleSet {
  return {
    $keyAgreement : { publicKeyJwk },
    $role         : true,
  };
}

function scopeKeys(scopes: { modulePath?: string }[]): string[] {
  return scopes
    .map((scope) => scope.modulePath ?? '<module>')
    .sort();
}
