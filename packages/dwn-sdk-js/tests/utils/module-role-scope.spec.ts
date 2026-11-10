import type { ModuleDefinition } from '../../src/types/modules-types.js';
import type { ResolvedRoleReference } from '../../src/core/module-graph.js';

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

const notebook: ModuleDefinition = {
  module    : 'https://example.com/notebook',
  published : true,
  types     : {
    notebook : { dataFormats: ['application/json'] },
    page     : { dataFormats: ['application/json'] },
    other    : { dataFormats: ['application/json'] },
    editor   : { dataFormats: ['application/json'] },
    viewer   : { dataFormats: ['application/json'] },
    owner    : { dataFormats: ['application/json'] },
  },
  structure: {
    owner    : { $role: true },
    notebook : {
      page: {
        $actions: [
          { role: 'notebook/page/editor', can: ['read'] },
          { role: 'notebook/page/viewer', can: ['read'] },
        ],
        editor : { $role: true },
        viewer : { $role: true },
      },
      other: {
        $actions : [{ role: 'notebook/other/editor', can: ['read'] }],
        editor   : { $role: true },
      },
    },
  },
};

function realtime(): ModuleDefinition {
  return {
    module    : 'https://example.com/realtime',
    published : true,
    uses      : { notes: notebook.module },
    types     : {
      live     : { dataFormats: ['application/json'] },
      session  : { dataFormats: ['application/json'] },
      draft    : { dataFormats: ['application/json'] },
      roster   : { dataFormats: ['application/json'] },
      public   : { dataFormats: ['application/json'] },
      detached : { dataFormats: ['application/json'] },
    },
    structure: {
      page: {
        $ref : 'notes:notebook/page',
        live : {
          $actions: [
            { role: 'notes:notebook/page/editor', can: ['read'] },
            { role: 'notes:notebook/page/viewer', can: ['read'] },
          ],
          session: {
            $actions: [
              { role: 'notes:notebook/page/editor', can: ['create', 'delete', 'read'] },
              { role: 'notes:notebook/page/viewer', can: ['read'] },
            ],
          },
        },
        draft  : { $actions: [{ role: 'notes:notebook/page/editor', can: ['create'] }] },
        roster : { $role: true, $actions: [{ role: 'notes:notebook/page/editor', can: ['read'] }] },
        public : { $actions: [{ who: 'anyone', can: ['read'] }] },
      },
      detached: { $actions: [{ role: 'notes:owner', can: ['read'] }] },
    },
  };
}

function graph(module: ModuleDefinition = definition): ReturnType<typeof resolveModuleGraph> {
  return resolveModuleGraph(module, uri => uri === provider.module ? provider : undefined, { requireKeyAgreement: false });
}

function notebookRole(path = 'notebook/page/editor'): ResolvedRoleReference {
  return resolveModuleGraph(notebook, () => undefined, { requireKeyAgreement: false }).resolveInvokedRole(path);
}

describe('resolveModuleRoleScope', () => {
  it('returns the context root and only its non-role authorized content paths', () => {
    const scope = resolveModuleRoleScope(graph(), graph().resolveInvokedRole('context/member'));

    expect(scope.contextPath).toBe('context');
    expect(scope.moduleRole).toBe('context/member');
    expect(scope.readablePaths).toEqual(['context', 'context/Zebra', 'context/note']);
    expect([...scope.allowedPaths]).toEqual(['context', 'context/Zebra', 'context/draft', 'context/note']);
  });

  it('requires reading the defining context root even when a descendant is readable', () => {
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

  it('selects role-authorized record paths beneath a composed $ref attachment root', () => {
    const resolved = resolveModuleGraph(realtime(), uri => uri === notebook.module ? notebook : undefined, { requireKeyAgreement: false });
    const scope = resolveModuleRoleScope(resolved, notebookRole());

    expect(scope.contextPath).toBe('page');
    expect(scope.moduleRole).toBe('notes:notebook/page/editor');
    expect([...scope.allowedPaths]).toEqual(['page/draft', 'page/live', 'page/live/session']);
    expect(scope.readablePaths).toEqual(['page/live', 'page/live/session']);
    expect(resolved.nodesByDeclaredPath.get('page')?.physicalDepth).toBe(2);
    expect(resolved.nodesByDeclaredPath.get('page/live/session')?.physicalDepth).toBe(4);
  });

  it('does not promote viewer access to editor-only writes', () => {
    const resolved = resolveModuleGraph(realtime(), () => notebook, { requireKeyAgreement: false });
    const scope = resolveModuleRoleScope(resolved, notebookRole('notebook/page/viewer'));

    expect(scope.moduleRole).toBe('notes:notebook/page/viewer');
    expect([...scope.allowedPaths]).toEqual(['page/live', 'page/live/session']);
    expect(scope.readablePaths).toEqual(['page/live', 'page/live/session']);
  });

  it('resolves equivalent role spellings to one canonical role without exposing role attachments', () => {
    const composed = realtime();
    composed.types.roleNote = { dataFormats: ['application/json'] };
    composed.structure.aliasRole = { $ref: 'notes:notebook/page/editor', roleNote: {} };
    getRuleSetAtPath('page/live', composed.structure)!.$actions = [{ role: 'aliasRole', can: ['read'] }];
    const resolved = resolveModuleGraph(composed, () => notebook, { requireKeyAgreement: false });
    const scope = resolveModuleRoleScope(resolved, notebookRole());

    expect(scope.moduleRole).toBe('aliasRole');
    expect(scope.readablePaths).toEqual(['page/live', 'page/live/session']);
    expect(resolved.resolveInvokedRole(scope.moduleRole).owningModulePath).toBe('notebook/page/editor');
    expect(scope.allowedPaths.has('aliasRole/roleNote')).toBe(false);
  });

  it('resolves a chained $ref attachment to the same context root without importing intermediate children', () => {
    const bridge: ModuleDefinition = {
      module    : 'https://example.com/bridge',
      published : true,
      uses      : { notes: notebook.module },
      types     : { marker: { dataFormats: ['application/json'] } },
      structure : { anchor: { $ref: 'notes:notebook/page', marker: {} } },
    };
    const composed = realtime();
    composed.uses!.bridge = bridge.module;
    composed.structure.page.$ref = 'bridge:anchor';
    const resolved = resolveModuleGraph(composed, uri => uri === notebook.module ? notebook : bridge, { requireKeyAgreement: false });
    const scope = resolveModuleRoleScope(resolved, notebookRole());

    expect(scope.contextPath).toBe('page');
    expect(scope.readablePaths).toEqual(['page/live', 'page/live/session']);
    expect(scope.allowedPaths.has('anchor/marker')).toBe(false);
  });

  it('rejects a role from a sibling context even when its name and depth match', () => {
    const resolved = resolveModuleGraph(realtime(), () => notebook, { requireKeyAgreement: false });
    expect(() => resolveModuleRoleScope(resolved, notebookRole('notebook/other/editor')))
      .toThrow('exact shared root');
  });

  it('rejects a top-level role without a parent context root', () => {
    const resolved = resolveModuleGraph(realtime(), () => notebook, { requireKeyAgreement: false });
    expect(() => resolveModuleRoleScope(resolved, notebookRole('owner'))).toThrow('parent context');
  });

  it('requires at least one readable record path under an attached context root', () => {
    const writeOnly: ModuleDefinition = {
      module    : 'https://example.com/write-only',
      published : true,
      uses      : { notes: notebook.module },
      types     : { draft: { dataFormats: ['application/json'] } },
      structure : {
        page: {
          $ref     : 'notes:notebook/page',
          $actions : [{ role: 'notes:notebook/page/editor', can: ['read'] }],
          draft    : { $actions: [{ role: 'notes:notebook/page/editor', can: ['create'] }] },
        },
      },
    };
    const resolved = resolveModuleGraph(writeOnly, () => notebook, { requireKeyAgreement: false });
    expect(() => resolveModuleRoleScope(resolved, notebookRole())).toThrow('no records readable');
  });
});

describe('resolveModuleContextRoot', () => {
  it('resolves the matching context root node in both defining and composing modules', () => {
    const resolved = graph();
    const root = resolved.nodesByDeclaredPath.get('context')!;
    expect(resolveModuleContextRoot(resolved, root)).toBe(root);
    expect(() => resolveModuleContextRoot(resolved, { ...root, owningModulePath: 'missing' }))
      .toThrow('exact shared root');
  });

  it('does not treat a role record as a context root', () => {
    const resolved = graph();
    expect(() => resolveModuleContextRoot(resolved, resolved.nodesByDeclaredPath.get('context/member')!))
      .toThrow('exact shared root');
  });

  it('binds an owner-only attached root without synthesizing a role or granting member access', () => {
    const privateExtension: ModuleDefinition = {
      module    : 'https://example.com/private-notebook-data',
      published : false,
      uses      : { notes: notebook.module },
      types     : { draft: { dataFormats: ['application/json'] } },
      structure : { collection: { $ref: 'notes:notebook', draft: {} } },
    };
    const providerGraph = resolveModuleGraph(notebook, () => undefined, { requireKeyAgreement: false });
    const consumerGraph = resolveModuleGraph(privateExtension, () => notebook, { requireKeyAgreement: false });
    const root = providerGraph.nodesByDeclaredPath.get('notebook')!;

    expect(resolveModuleContextRoot(consumerGraph, root).declaringModulePath).toBe('collection');
    expect(() => resolveModuleRoleScope(consumerGraph, notebookRole())).toThrow('exact shared root');
  });

  it('rejects a graph with multiple top-level $ref roots targeting the same context root', () => {
    const providerGraph = resolveModuleGraph(notebook, () => undefined, { requireKeyAgreement: false });
    const consumerGraph = resolveModuleGraph(realtime(), () => notebook, { requireKeyAgreement: false });
    const pageRoot = consumerGraph.nodesByDeclaredPath.get('page')!;
    const duplicateGraph = {
      ...consumerGraph,
      nodesByDeclaredPath: new Map([
        ...consumerGraph.nodesByDeclaredPath,
        ['secondPage', { ...pageRoot, declaringModulePath: 'secondPage' }],
      ]),
    };

    expect(() => resolveModuleContextRoot(
      duplicateGraph,
      providerGraph.nodesByDeclaredPath.get('notebook/page')!,
    )).toThrow('must declare one exact shared root');
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

  it('selects direct local read roles at the requested context root', () => {
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
