import type { ModuleDefinition } from '../../src/types/modules-types.js';
import type { ResolvedRoleReference } from '../../src/core/module-graph.js';

import { describe, expect, it } from 'bun:test';

import { getRuleSetAtPath } from '../../src/utils/modules.js';
import { resolveModuleGraph } from '../../src/core/module-graph.js';
import { resolveModuleAttachment, resolveModuleRoleProjection } from '../../src/utils/module-role-projection.js';

const notebook: ModuleDefinition = {
  module    : 'https://example.com/projection/notebook',
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
    module    : 'https://example.com/projection/realtime',
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

function rootRole(path = 'notebook/page/editor'): ResolvedRoleReference {
  return resolveModuleGraph(notebook, () => undefined, { requireKeyAgreement: false }).resolveInvokedRole(path);
}

describe('resolveModuleAttachment', () => {
  it('binds an owner-only root without synthesizing a role or granting member access', () => {
    const definition: ModuleDefinition = {
      module    : 'https://example.com/projection/private-notebook-data',
      published : false,
      uses      : { notes: notebook.module },
      types     : { draft: { dataFormats: ['application/json'] } },
      structure : { collection: { $ref: 'notes:notebook', draft: {} } },
    };
    const providerGraph = resolveModuleGraph(notebook, () => undefined, { requireKeyAgreement: false });
    const consumerGraph = resolveModuleGraph(definition, () => notebook, { requireKeyAgreement: false });
    const root = providerGraph.nodesByDeclaredPath.get('notebook')!;

    expect(resolveModuleAttachment(consumerGraph, root).declaringModulePath).toBe('collection');
    expect(() => resolveModuleRoleProjection(consumerGraph, rootRole())).toThrow('exact shared root');
  });

  it('rejects mismatched physical depth or ancestry even when owner and path strings match', () => {
    const providerGraph = resolveModuleGraph(notebook, () => undefined, { requireKeyAgreement: false });
    const graph = resolveModuleGraph(realtime(), () => notebook, { requireKeyAgreement: false });
    const root = providerGraph.nodesByDeclaredPath.get('notebook/page')!;

    expect(() => resolveModuleAttachment(graph, { ...root, physicalDepth: root.physicalDepth + 1 }))
      .toThrow('exact shared root');
    expect(() => resolveModuleAttachment(graph, { ...root, physicalAncestors: [] })).toThrow('exact shared root');
  });
});

describe('resolveModuleRoleProjection', () => {
  it('selects concrete role-authorized paths beneath the exact shared attachment', () => {
    const graph = resolveModuleGraph(realtime(), uri => uri === notebook.module ? notebook : undefined, { requireKeyAgreement: false });
    const projection = resolveModuleRoleProjection(graph, rootRole());

    expect(projection.attachmentPath).toBe('page');
    expect(projection.moduleRole).toBe('notes:notebook/page/editor');
    expect([...projection.allowedPaths]).toEqual(['page/draft', 'page/live', 'page/live/session']);
    expect(projection.readablePaths).toEqual(['page/live', 'page/live/session']);
    expect(graph.nodesByDeclaredPath.get('page')?.physicalDepth).toBe(2);
    expect(graph.nodesByDeclaredPath.get('page/live/session')?.physicalDepth).toBe(4);
  });

  it('does not promote viewer access to editor-only writes', () => {
    const graph = resolveModuleGraph(realtime(), () => notebook, { requireKeyAgreement: false });
    const projection = resolveModuleRoleProjection(graph, rootRole('notebook/page/viewer'));

    expect(projection.moduleRole).toBe('notes:notebook/page/viewer');
    expect([...projection.allowedPaths]).toEqual(['page/live', 'page/live/session']);
    expect(projection.readablePaths).toEqual(['page/live', 'page/live/session']);
  });

  it('resolves equivalent role spellings to one canonical role without exposing role attachments', () => {
    const definition = realtime();
    definition.types.roleNote = { dataFormats: ['application/json'] };
    definition.structure.aliasRole = { $ref: 'notes:notebook/page/editor', roleNote: {} };
    getRuleSetAtPath('page/live', definition.structure)!.$actions = [{ role: 'aliasRole', can: ['read'] }];
    const graph = resolveModuleGraph(definition, () => notebook, { requireKeyAgreement: false });
    const projection = resolveModuleRoleProjection(graph, rootRole());

    expect(projection.moduleRole).toBe('aliasRole');
    expect(projection.readablePaths).toEqual(['page/live', 'page/live/session']);
    expect(graph.resolveInvokedRole(projection.moduleRole).owningModulePath).toBe('notebook/page/editor');
    expect(projection.allowedPaths.has('aliasRole/roleNote')).toBe(false);
  });

  it('resolves a chained reference to the same physical root without importing provider children', () => {
    const bridge: ModuleDefinition = {
      module    : 'https://example.com/projection/bridge',
      published : true,
      uses      : { notes: notebook.module },
      types     : { marker: { dataFormats: ['application/json'] } },
      structure : { anchor: { $ref: 'notes:notebook/page', marker: {} } },
    };
    const definition = realtime();
    definition.uses!.bridge = bridge.module;
    definition.structure.page.$ref = 'bridge:anchor';
    const graph = resolveModuleGraph(definition, uri => uri === notebook.module ? notebook : bridge, { requireKeyAgreement: false });
    const projection = resolveModuleRoleProjection(graph, rootRole());

    expect(projection.attachmentPath).toBe('page');
    expect(projection.readablePaths).toEqual(['page/live', 'page/live/session']);
    expect(projection.allowedPaths.has('anchor/marker')).toBe(false);
  });

  it('rejects a role from a sibling context even when its name and physical depth match', () => {
    const graph = resolveModuleGraph(realtime(), () => notebook, { requireKeyAgreement: false });
    expect(() => resolveModuleRoleProjection(graph, rootRole('notebook/other/editor')))
      .toThrow('exact shared root');
  });

  it('rejects a root-level role without a physical context parent', () => {
    const graph = resolveModuleGraph(realtime(), () => notebook, { requireKeyAgreement: false });
    expect(() => resolveModuleRoleProjection(graph, rootRole('owner'))).toThrow('physical parent');
  });

  it('requires an explicit readable consumer path and does not inherit provider or attachment rules', () => {
    const definition: ModuleDefinition = {
      module    : 'https://example.com/projection/write-only',
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
    const graph = resolveModuleGraph(definition, () => notebook, { requireKeyAgreement: false });
    expect(() => resolveModuleRoleProjection(graph, rootRole())).toThrow('no consumer records readable');
  });
});
