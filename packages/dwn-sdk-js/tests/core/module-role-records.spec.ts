import type { RecordsWriteMessage } from '../../src/types/records-types.js';

import { Modules } from '../../src/utils/modules.js';
import { describe, expect, it } from 'bun:test';
import { getRecordsWriteRoleIdentity, getRoleAudienceContextId, getRoleContextPrefix, getRoleRecordIdentity } from '../../src/core/module-role-records.js';

describe('resolved module role contexts', () => {
  it('keeps root roles tenant-wide without inventing a context prefix', () => {
    const role = { parentPhysicalDepth: 0 };
    expect(getRoleAudienceContextId(role, undefined)).toBe('');
    expect(getRoleAudienceContextId(role, 'workspace/board/message')).toBe('');
    expect(getRoleContextPrefix(role, undefined)).toBeUndefined();
    expect(getRoleContextPrefix(role, 'workspace')).toBeUndefined();
  });

  it('uses the real parent depth for contextual roles and rejects insufficient context', () => {
    const role = { parentPhysicalDepth: 2 };
    expect(getRoleAudienceContextId(role, 'workspace/board/message')).toBe('workspace/board');
    expect(getRoleContextPrefix(role, 'workspace/board')).toBe('workspace/board');
    expect(getRoleContextPrefix(role, 'workspace')).toBeUndefined();
    expect(getRoleContextPrefix(role, undefined)).toBeUndefined();
    expect(getRoleContextPrefix(role, 'workspace//message')).toBeUndefined();
  });

  it('computes record identity from the direct physical parent rather than the declared path', () => {
    const message = {
      contextId  : 'workspace/board/assignment',
      descriptor : { module: 'https://example.com/module', modulePath: 'board/member', recipient: 'did:example:member' },
    } as RecordsWriteMessage;
    const result = getRecordsWriteRoleIdentity(message)!;
    expect(result.contextIdPrefix).toBe('workspace/board');
    expect(result.key).toBe(JSON.stringify(['https://example.com/module', 'board/member', 'did:example:member', 'workspace/board']));
    expect(getRoleRecordIdentity({
      role: {
        owningModuleUri     : 'https://example.com/module',
        owningModulePath    : 'board/member',
        parentPhysicalDepth : 2,
      },
      contextId : 'workspace/board/comment',
      recipient : 'did:example:member',
    })).toEqual(result);
  });

  it('requires keys for plaintext role providers without treating ordinary plaintext as encrypted', () => {
    const definition = {
      module    : 'https://example.com/module',
      published : false,
      types     : { member: { dataFormats: ['application/json'] } },
      structure : { member: {} },
    };
    expect(Modules.requiresKeyAgreement(definition)).toBe(false);
    expect(Modules.requiresKeyAgreement({ ...definition, structure: { member: { $role: true } } })).toBe(true);
    expect(Modules.requiresKeyAgreement({ ...definition, types: { member: { encryptionRequired: true } } })).toBe(true);
  });
});
