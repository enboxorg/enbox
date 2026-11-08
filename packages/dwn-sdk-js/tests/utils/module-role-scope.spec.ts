import type { ModuleDefinition } from '../../src/types/modules-types.js';

import { canonicalJsonStringify } from '@enbox/common';
import { describe, expect, it } from 'bun:test';

import { getRuleSetAtPath } from '../../src/utils/modules.js';
import { ModuleAction } from '../../src/types/modules-types.js';
import { resolveModuleGraph } from '../../src/core/module-graph.js';
import { resolveModuleContextRoles, resolveModuleContextRoot, resolveModuleRoleScope } from '../../src/utils/module-role-scope.js';

const definition = {
  module    : 'https://example.com/context',
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
      $actions : [{ role: 'context/member', can: [ModuleAction.Read] }],
      member   : { $role: true },
      draft    : {
        $actions: [{ role: 'context/member', can: [ModuleAction.Create] }],
      },
      note: {
        $actions: [{ role: 'context/member', can: [ModuleAction.Create, ModuleAction.Read] }],
      },
      secret : {},
      Zebra  : {
        $actions: [{ role: 'context/member', can: [ModuleAction.Read] }],
      },
    },
  },
} as const satisfies ModuleDefinition;

const provider: ModuleDefinition = {
  module    : 'https://example.com/other',
  published : true,
  types     : { context: {}, global: {} },
  structure : { context: {}, global: { $role: true } },
};

function graph(module: ModuleDefinition = definition): ReturnType<typeof resolveModuleGraph> {
  return resolveModuleGraph(module, uri => uri === provider.module ? provider : undefined, { requireKeyAgreement: false });
}

describe('resolveModuleRoleScope', () => {
  it('returns the context root and only its non-role authorized content paths', () => {
    const scope = resolveModuleRoleScope(graph(), graph().resolveInvokedRole('context/member'));

    expect(scope.contextPath).toBe('context');
    expect(scope.moduleRole).toBe('context/member');
    expect(scope.readablePaths).toEqual(['context', 'context/Zebra', 'context/note']);
    expect([...scope.allowedPaths]).toEqual(['context', 'context/Zebra', 'context/draft', 'context/note']);
  });

  it('requires reading the native root even when a descendant is readable', () => {
    const inaccessible = structuredClone(definition) as ModuleDefinition;
    inaccessible.structure.context.$actions = [];
    const resolved = graph(inaccessible);

    expect(() => resolveModuleRoleScope(resolved, resolved.resolveInvokedRole('context/member')))
      .toThrow('must authorize reading its parent context \'context\'');
  });

  it('does not expose role records even when the same role can read them', () => {
    const withRoleRead = structuredClone(definition) as ModuleDefinition;
    getRuleSetAtPath('context/member', withRoleRead.structure)!.$actions = [{ role: 'context/member', can: ['read'] }];
    const resolved = graph(withRoleRead);

    const scope = resolveModuleRoleScope(resolved, resolved.resolveInvokedRole('context/member'));
    expect(scope.allowedPaths.has('context/member')).toBe(false);
    expect(scope.readablePaths).not.toContain('context/member');
  });
});

describe('resolveModuleContextRoot', () => {
  it('uses the same canonical coordinates for native and attached roots', () => {
    const resolved = graph();
    const root = resolved.nodesByDeclaredPath.get('context')!;
    expect(resolveModuleContextRoot(resolved, root)).toBe(root);
    expect(() => resolveModuleContextRoot(resolved, { ...root, physicalDepth: root.physicalDepth + 1 }))
      .toThrow('exact shared root');
  });

  it('does not treat a role record as a context root', () => {
    const resolved = graph();
    expect(() => resolveModuleContextRoot(resolved, resolved.nodesByDeclaredPath.get('context/member')!))
      .toThrow('exact shared root');
  });
});

describe('resolveModuleContextRoles', () => {
  it('preserves read-action order independently of object-key order', () => {
    const ordered: ModuleDefinition = {
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
    const canonical = JSON.parse(canonicalJsonStringify(ordered)) as ModuleDefinition;

    expect(Object.keys(ordered.structure.context)).not.toEqual(Object.keys(canonical.structure.context));
    expect(resolveModuleContextRoles(graph(ordered), 'context')).toEqual(['context/viewer', 'context/member']);
    expect(resolveModuleContextRoles(graph(canonical), 'context')).toEqual(['context/viewer', 'context/member']);
    expect(JSON.stringify(ordered)).toBe(original);

    canonical.structure.context.$actions!.reverse();
    expect(resolveModuleContextRoles(graph(canonical), 'context')).toEqual(['context/member', 'context/viewer']);
  });

  it('selects direct local read roles at the exact requested root', () => {
    const nested: ModuleDefinition = {
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
              { role: 'other:global', can: ['read'] },
              { role: 'context/note/draft', can: ['create'] },
              { role: 'context/note/member', can: ['create', 'read'] },
            ],
            draft  : { $role: true },
            member : { $role: true },
          },
        },
      },
    };

    expect(resolveModuleContextRoles(graph(nested), 'context')).toEqual(['context/member']);
    expect(resolveModuleContextRoles(graph(nested), 'context/note')).toEqual(['context/note/member']);
  });

  it('returns no roles for content without role read rules or external attachment points', () => {
    expect(resolveModuleContextRoles(graph(definition), 'context/secret')).toEqual([]);
    expect(resolveModuleContextRoles(graph(definition), 'context/draft')).toEqual([]);
    const composed: ModuleDefinition = {
      ...definition,
      uses      : { other: 'https://example.com/other' },
      structure : { attachment: { $ref: 'other:context', note: {} } },
    };
    expect(resolveModuleContextRoles(graph(composed), 'attachment')).toEqual([]);
  });

  it('keeps reference actions out of managed contexts while preserving local descendant contexts', () => {
    const composed: ModuleDefinition = {
      ...definition,
      uses      : { other: 'https://example.com/other' },
      structure : {
        attachment: {
          $ref     : 'other:context',
          $actions : [{ role: 'attachment/member', can: ['read'] }],
          member   : { $role: true },
          note     : {
            $actions : [{ role: 'attachment/note/member', can: ['read'] }],
            member   : { $role: true },
          },
        },
      },
    };
    expect(resolveModuleContextRoles(graph(composed), 'attachment')).toEqual([]);
    expect(() => resolveModuleRoleScope(graph(composed), graph(composed).resolveInvokedRole('attachment/member'))).toThrow(TypeError);
    expect(resolveModuleContextRoles(graph(composed), 'attachment/note')).toEqual(['attachment/note/member']);
    expect(resolveModuleRoleScope(graph(composed), graph(composed).resolveInvokedRole('attachment/note/member')).readablePaths).toEqual(['attachment/note']);
  });

  for (const path of ['', '/context', 'context/', 'context//note', 'context/$actions', 'missing', 'context/member']) {
    it(`rejects a target that is not a canonical content path: '${path}'`, () => {
      expect(() => resolveModuleContextRoles(graph(definition), path)).toThrow(TypeError);
    });
  }
});
