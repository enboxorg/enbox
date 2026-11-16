import type { AttachModuleDefinitionOptions } from '../src/authoring.js';
import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type { PayloadSchema } from '../src/catalog-types.js';

import { resolveModuleGraph } from '@enbox/dwn-sdk-js';
import { attachModuleDefinition, realtimeDefinition, validateAuthoredGraph } from '../src/authoring.js';
import { bundleSchema, roleDefinition, sharedSchemas } from '../src/authoring.js';
import { describe, expect, it } from 'bun:test';

const uri = (name: string): string => `https://example.org/authoring/${name}`;
const json = { dataFormats: ['application/json'] };
const provider: ModuleDefinition = {
  module    : uri('collaboration'),
  published : true,
  types     : { space: json, admin: json, editor: json, viewer: json },
  structure : {
    space: {
      $actions : ['admin', 'editor', 'viewer'].map((role) => ({ role: `space/${role}`, can: ['read'] })),
      admin    : roleDefinition('space/admin'),
      editor   : roleDefinition('space/editor'),
      viewer   : roleDefinition('space/viewer'),
    },
  },
};
const source: ModuleDefinition = {
  module    : uri('source'),
  published : true,
  types     : { list: json, entry: json, editor: json, viewer: json, state: json },
  structure : {
    list: {
      $size    : { max: 1000 },
      $actions : [
        { role: 'list/editor', can: ['read', 'co-update'] },
        { role: 'list/viewer', can: ['read'] },
      ],
      entry: {
        $actions: [
          { role: 'list/editor', can: ['create', 'read', 'update', 'delete'] },
          { who: 'author', of: 'list', can: ['read'] },
        ],
      },
      editor : roleDefinition('list/editor'),
      viewer : roleDefinition('list/viewer'),
    },
    state: {},
  },
};
function attachment(overrides: Partial<AttachModuleDefinitionOptions> = {}): ModuleDefinition {
  return attachModuleDefinition({
    module       : uri('attached'),
    source,
    root         : 'list',
    provider,
    parentPath   : 'space',
    alias        : 'shared-space',
    attachment   : 'space',
    roleBindings : { 'list/editor': ['space/admin', 'space/editor'], 'list/viewer': ['space/viewer'] },
    rootActions  : [{ role: 'shared-space:space/viewer', can: ['read'] }],
    ...overrides,
  });
}

describe('explicit role authoring', () => {
  it('keeps self-removal scoped to the recipient and independently declares issuance and roster access', () => {
    const readers = ['root/admin'];
    const result = roleDefinition('root/viewer', { readableBy: readers, issuedBy: ['root/admin'], revokedBy: ['root/admin'] });
    readers.push('root/viewer');
    expect(result).toEqual({
      $role      : true,
      $immutable : true,
      $size      : { max: 2 },
      $actions   : [
        { who: 'recipient', of: 'root/viewer', can: ['read'] },
        { who: 'recipient', can: ['co-delete'] },
        { role: 'root/admin', can: ['read', 'create', 'co-delete'] },
      ],
    });
    expect(roleDefinition('root/viewer', { selfRead: false }).$actions).toEqual([{ who: 'recipient', can: ['co-delete'] }]);
    expect(roleDefinition('root/editor', { readableBy: ['shared-space:space/editor'] }).$actions[2].role).toBe('shared-space:space/editor');
  });

  it('rejects malformed paths and duplicate declarations without silently merging them', () => {
    for (const path of ['', 'root//viewer', 'root/viewer2', '../viewer']) {
      expect(() => roleDefinition(path)).toThrow();
    }
    for (const reference of ['bad:alias:viewer', ':viewer', '1alias:viewer']) {
      expect(() => roleDefinition('root/viewer', { readableBy: [reference] })).toThrow();
    }
    expect(() => roleDefinition('root/viewer', { readableBy: ['root/admin', 'root/admin'] })).toThrow('duplicate');
  });
});

describe('shared schema bundling', () => {
  const money = 'https://enbox.id/schemas/common/money/v1';

  it('bundles registered contracts, retains explicit aliases and preserves literal example values', () => {
    const input: PayloadSchema = {
      $id         : uri('schema'),
      type        : 'object',
      properties  : { amount: { $ref: money } },
      examples    : [{ $ref: 'https://example.org/a-data-value' }],
      definitions : { Price: { $ref: money } },
    };
    const original = structuredClone(input);
    const result = bundleSchema(input, sharedSchemas);
    expect(result.properties).toEqual({ amount: { $ref: '#/definitions/Price' } });
    expect(result.examples).toEqual(input.examples);
    expect((result.definitions as Record<string, PayloadSchema>).Price.type).toBe('object');
    expect(input).toEqual(original);
    expect(JSON.stringify(result)).not.toContain(`"$ref":"${money}"`);
  });

  it('supports direct fragment references, transitive provenance references, and a shared root schema', () => {
    const bundled = bundleSchema(
      {
        type       : 'object',
        properties : {
          cost   : { $ref: money },
          source : { $ref: 'https://enbox.id/schemas/common/provenance/v1' },
          value  : { type: 'integer', enum: [1, 2] },
        },
      },
      sharedSchemas,
    );
    expect(Object.keys(bundled.definitions as PayloadSchema).sort()).toEqual(['money', 'provenance', 'record-reference']);
    expect(
      bundleSchema({ $id: uri('empty'), title: 'Assignment', $ref: 'https://enbox.id/schemas/common/role-assignment/v1' }, sharedSchemas),
    ).toEqual({ $id: uri('empty'), title: 'Assignment', type: 'object', additionalProperties: false, properties: {} });
    expect(bundleSchema({ type: 'string' }, sharedSchemas)).toEqual({ type: 'string' });
    const namespaced = bundleSchema({ properties: { cost: { $ref: money } } }, sharedSchemas, { definitionPrefix: 'item' });
    expect(namespaced.properties).toEqual({ cost: { $ref: '#/definitions/itemMoney' } });
    expect(() => bundleSchema({}, sharedSchemas, { definitionPrefix: '../bad' })).toThrow('identifier');
    const aliases = bundleSchema({ definitions: { One: { $ref: money }, Two: { $ref: money, description: 'An alias' } } }, sharedSchemas);
    expect((aliases.definitions as Record<string, PayloadSchema>).Two.description).toBe('An alias');
  });

  it('rebinds imported local pointers without changing their meaning or dropping root definitions', () => {
    const id = 'https://example.org/measurement.json';
    const contract: PayloadSchema = {
      $id         : id,
      type        : 'object',
      properties  : { value: { $ref: '#/definitions/Amount' } },
      definitions : { Amount: { type: 'number' } },
    };
    const result = bundleSchema({ properties: { measurement: { $ref: id } } }, { [id]: contract });
    const embedded = (result.definitions as Record<string, PayloadSchema>).measurement;
    expect(embedded.properties).toEqual({ value: { $ref: '#/definitions/measurement/definitions/Amount' } });
    expect(embedded.definitions).toEqual({ Amount: { type: 'number' } });
    const atRoot = bundleSchema({ $id: uri('root'), $ref: id }, { [id]: contract });
    expect(atRoot.properties).toEqual({ value: { $ref: '#/definitions/Amount' } });
    expect(atRoot.definitions).toEqual({ Amount: { type: 'number' } });
    const alias = uri('measurement-alias');
    const throughAlias = bundleSchema(
      { $id: uri('consumer'), $ref: alias },
      {
        [alias] : { $id: alias, $ref: id },
        [id]    : contract,
      },
    );
    expect(throughAlias.$id).toBe(uri('consumer'));
    expect(throughAlias.$ref).toBe('#/definitions/measurement');
    expect(() => bundleSchema({ $ref: id }, { [id]: { ...contract, properties: { nested: { $id: 'nested', type: 'number' } } } })).toThrow(
      'identifier scopes',
    );
    expect(() => bundleSchema({ $ref: id }, { [id]: { ...contract, properties: { value: { $ref: '#anchor' } } } })).toThrow(
      'JSON Pointers',
    );
  });

  it('rejects unknown dependencies, contract overrides, ambiguous names and cycles', () => {
    expect(() => bundleSchema({ $ref: uri('missing') }, sharedSchemas)).toThrow('unregistered');
    expect(() => bundleSchema({ $ref: money, additionalProperties: true }, sharedSchemas)).toThrow('override');
    expect(() =>
      bundleSchema({ properties: { cost: { $ref: money } }, definitions: { money: { type: 'string' } } }, sharedSchemas),
    ).toThrow('collision');
    const recursive = uri('recursive');
    expect(() => bundleSchema({ $ref: recursive }, { [recursive]: { $id: recursive, properties: { next: { $ref: recursive } } } })).toThrow(
      'cyclic',
    );
    expect(() => bundleSchema({ $ref: money }, { [money]: { $id: uri('wrong') } })).toThrow('unregistered');
  });
});

describe('attached feature authoring', () => {
  it('rebinds roles and actors, excludes memberships and private sibling state, and preserves explicit root authority', () => {
    const original = structuredClone(source);
    const definition = attachment();
    expect(Object.keys(definition.types).sort()).toEqual(['entry', 'list']);
    const node = definition.structure.space.list as Record<string, unknown>;
    expect(node.$actions).toEqual([{ role: 'shared-space:space/viewer', can: ['read'] }]);
    const graph = resolveModuleGraph(definition, (id): ModuleDefinition | undefined => (id === provider.module ? provider : undefined), {
      requireKeyAgreement: false,
    });
    const entry = graph.nodesByDeclaredPath.get('space/list/entry')!;
    expect(entry.physicalDepth).toBe(3);
    expect(entry.actions.map((action): string | undefined => action.rule.role ?? action.rule.of)).toEqual([
      'shared-space:space/admin',
      'shared-space:space/editor',
      'space/list',
    ]);
    expect(source).toEqual(original);
  });

  it('rejects incomplete or conflicting bindings before producing a usable definition', () => {
    const invalid: Partial<AttachModuleDefinitionOptions>[] = [
      { root: 'list/entry' },
      { attachment: 'a/b' },
      { alias: '1bad' },
      { root: 'missing' },
      { module: source.module },
      { module: provider.module },
      { roleBindings: {} },
      { roleBindings: { 'list/editor': [], 'list/viewer': ['space/viewer'] } },
      { roleBindings: { 'list/editor': ['space/editor'], 'list/viewer': ['space/viewer'], unused: ['space/editor'] } },
      { roleBindings: { 'list/editor': ['space/editor', 'space/editor'], 'list/viewer': ['space/viewer'] } },
      { source: { ...source, uses: { 'shared-space': uri('elsewhere') } } },
      { source: { ...source, uses: { other: provider.module } } },
    ];
    for (const overrides of invalid) {
      expect(() => attachment(overrides)).toThrow();
    }
    const outsideActor = structuredClone(source);
    (outsideActor.structure.list.entry as Record<string, unknown>).$actions = [{ who: 'author', of: 'state', can: ['read'] }];
    expect(() => attachment({ source: outsideActor })).toThrow('outside');
    const missingMembership = structuredClone(source);
    (missingMembership.structure.list as Record<string, unknown>).unused = roleDefinition('list/unused');
    expect(() => attachment({ source: missingMembership })).toThrow('explicit binding');
    const missingType = structuredClone(source);
    delete missingType.types.entry;
    expect(() => attachment({ source: missingType })).toThrow('missing type');
    const referenceRoot = structuredClone(source);
    referenceRoot.structure.list.$ref = 'other:root';
    expect(() => attachment({ source: referenceRoot })).toThrow('concrete');
    const nestedReference = structuredClone(source);
    (nestedReference.structure.list.entry as Record<string, unknown>).$ref = 'other:root';
    expect(() => attachment({ source: nestedReference })).toThrow('concrete records');
    expect(() => validateAuthoredGraph(source, [provider, provider])).toThrow('Duplicate dependency');
  });
});

describe('realtime authoring', () => {
  const options = {
    module     : uri('live'),
    schemaBase : uri('live-schema'),
    provider,
    alias      : 'shared-space',
    parentPath : 'space',
    attachment : 'space',
    readers    : ['space/admin', 'space/editor', 'space/viewer'],
    writers    : ['space/admin', 'space/editor'],
  };

  it('keeps advertisements owner-managed and session writes author-scoped in declared role order', () => {
    const definition = realtimeDefinition(options);
    const graph = resolveModuleGraph(definition, (id): ModuleDefinition | undefined => (id === provider.module ? provider : undefined), {
      requireKeyAgreement: false,
    });
    expect(graph.nodesByDeclaredPath.get('space/live')!.actions.every((action): boolean => action.rule.can.join() === 'read')).toBe(true);
    expect(graph.nodesByDeclaredPath.get('space/live/session')!.actions[0].rule.can).toEqual(['create', 'delete', 'read']);
    expect(graph.nodesByDeclaredPath.get('space/live/session')!.actions[2].rule.can).toEqual(['read']);
  });

  it('rejects invalid roots, duplicate roles, and writers without read access', () => {
    for (const change of [
      { attachment: 'a/b' },
      { alias: '1bad' },
      { readers: [] },
      { readers: ['space/editor', 'space/editor'] },
      { writers: ['space/editor', 'space/editor'] },
      { writers: ['space/missing'] },
      { parentPath: 'missing' },
    ]) {
      expect(() => realtimeDefinition({ ...options, ...change })).toThrow();
    }
  });
});
