import type { ProtocolDefinition } from '../../src/types/protocols-types.js';

import { canonicalJsonStringify } from '@enbox/common';
import { describe, expect, it } from 'bun:test';

import { ProtocolAction } from '../../src/types/protocols-types.js';
import { resolveProtocolContextRoles, resolveProtocolRoleContextScope } from '../../src/utils/protocols.js';

const definition = {
  protocol  : 'https://example.com/context',
  published : true,
  types     : {
    context : { dataFormats: ['application/json'] },
    draft   : { dataFormats: ['application/json'] },
    member  : { dataFormats: ['application/json'] },
    note    : { dataFormats: ['application/json'] },
    secret  : { dataFormats: ['application/json'] },
    Zebra   : { dataFormats: ['application/json'] },
  },
  structure: {
    context: {
      $actions : [{ role: 'context/member', can: [ProtocolAction.Read] }],
      member   : { $role: true },
      draft    : {
        $actions: [{ role: 'context/member', can: [ProtocolAction.Create] }],
      },
      note: {
        $actions: [{ role: 'context/member', can: [ProtocolAction.Create, ProtocolAction.Read] }],
      },
      secret : {},
      Zebra  : {
        $actions: [{ role: 'context/member', can: [ProtocolAction.Read] }],
      },
    },
  },
} as const satisfies ProtocolDefinition;

describe('resolveProtocolRoleContextScope', () => {
  it('returns the context root and only its non-role authorized content paths', () => {
    const scope = resolveProtocolRoleContextScope(definition, 'context/member');

    expect(scope.protocolPath).toBe('context');
    expect(scope.readablePaths).toEqual(['context', 'context/Zebra', 'context/note']);
    expect([...scope.allowedPaths]).toEqual(['context', 'context/Zebra', 'context/draft', 'context/note']);
  });
});

describe('resolveProtocolContextRoles', () => {
  it('preserves read-action order independently of object-key order', () => {
    const ordered: ProtocolDefinition = {
      ...definition,
      types     : { ...definition.types, viewer: { dataFormats: ['application/json'] } },
      structure : {
        context: {
          $actions: [
            { role: 'context/viewer', can: ['read'] },
            { role: 'context/member', can: ['read', 'create'] },
          ],
          viewer : { $role: true },
          member : { $role: true },
        },
      },
    };
    const original = JSON.stringify(ordered);
    const canonical = JSON.parse(canonicalJsonStringify(ordered)) as ProtocolDefinition;

    expect(Object.keys(ordered.structure.context)).not.toEqual(Object.keys(canonical.structure.context));
    expect(resolveProtocolContextRoles(ordered, 'context')).toEqual(['context/viewer', 'context/member']);
    expect(resolveProtocolContextRoles(canonical, 'context')).toEqual(['context/viewer', 'context/member']);
    expect(JSON.stringify(ordered)).toBe(original);

    canonical.structure.context.$actions!.reverse();
    expect(resolveProtocolContextRoles(canonical, 'context')).toEqual(['context/member', 'context/viewer']);
  });

  it('selects direct local read roles at the exact requested root', () => {
    const nested: ProtocolDefinition = {
      ...definition,
      types     : { ...definition.types, global: { dataFormats: ['application/json'] } },
      uses      : { other: 'https://example.com/other' },
      structure : {
        global  : { $role: true },
        context : {
          $actions : [{ role: 'context/member', can: ['read'] }],
          member   : { $role: true },
          note     : {
            $actions: [
              { who: 'anyone', can: ['read'] },
              { role: 'global', can: ['read'] },
              { role: 'context/member', can: ['read'] },
              { role: 'other:note/member', can: ['read'] },
              { role: 'context/note/draft', can: ['create'] },
              { role: 'context/note/member', can: ['create', 'read'] },
            ],
            draft  : { $role: true },
            member : { $role: true },
          },
        },
      },
    };

    expect(resolveProtocolContextRoles(nested, 'context')).toEqual(['context/member']);
    expect(resolveProtocolContextRoles(nested, 'context/note')).toEqual(['context/note/member']);
  });

  it('returns no roles for content without role read rules or external attachment points', () => {
    expect(resolveProtocolContextRoles(definition, 'context/secret')).toEqual([]);
    expect(resolveProtocolContextRoles(definition, 'context/draft')).toEqual([]);
    const composed: ProtocolDefinition = {
      ...definition,
      uses      : { other: 'https://example.com/other' },
      structure : { attachment: { $ref: 'other:context' } },
    };
    expect(resolveProtocolContextRoles(composed, 'attachment')).toEqual([]);
  });

  for (const path of ['', '/context', 'context/', 'context//note', 'context/$actions', 'missing', 'context/member']) {
    it(`rejects a target that is not a canonical content path: '${path}'`, () => {
      expect(() => resolveProtocolContextRoles(definition, path)).toThrow(TypeError);
    });
  }
});
