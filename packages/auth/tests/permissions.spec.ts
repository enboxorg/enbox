import { describe, expect, test } from 'bun:test';

import type { DwnModuleDefinition } from '@enbox/agent';
import type { ModuleRequest } from '../src/types.js';

import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';
import { normalizeModuleRequests, normalizePermissionPolicy } from '../src/permissions.js';

/** Minimal module definition for testing. */
const TestModule = {
  module    : 'https://example.com/test',
  published : true,
  types     : { entry: { dataFormats: ['application/json'] } },
  structure : { entry: {} },
} satisfies DwnModuleDefinition;

/** Structural higher-level module carrying runtime-only application data. */
const TypedTestModule = {
  definition : TestModule,
  codecs     : { entry: { decode: (): void => {}, encode: (): void => {} } },
} as const;

const OtherModule = {
  ...TestModule,
  module: 'https://example.com/other',
} satisfies DwnModuleDefinition;

function scopeKeys(result: ReturnType<typeof normalizeModuleRequests>[number]): string[] {
  return result.permissionScopes
    .map((scope) => `${scope.interface}.${scope.method}`)
    .sort();
}

describe('normalizeModuleRequests', () => {
  test('returns empty array for undefined input', () => {
    expect(normalizeModuleRequests(undefined)).toEqual([]);
  });

  test('returns empty array for empty array input', () => {
    expect(normalizeModuleRequests([])).toEqual([]);
  });

  test('rejects old and mixed definition fields before deriving permission scopes', () => {
    for (const entry of [
      { ...TestModule, protocol: TestModule.module },
      { module: TypedTestModule, protocol: TypedTestModule, permissions: ['read'] },
      { definition: { ...TestModule, protocol: TestModule.module }, permissions: ['read'] },
    ]) {
      expect(() => normalizeModuleRequests([entry as unknown as ModuleRequest]))
        .toThrow('removed protocol field');
    }
  });

  test('normalizes a bare module definition with default permissions', () => {
    const result = normalizeModuleRequests([TestModule]);

    expect(result).toHaveLength(1);
    expect(result[0].moduleDefinition).toBe(TestModule);
    expect(scopeKeys(result[0])).toEqual([
      `${DwnInterfaceName.Messages}.${DwnMethodName.Read}`,
      `${DwnInterfaceName.Modules}.${DwnMethodName.Query}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Delete}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Read}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Write}`,
    ].sort());
  });

  test('normalizes a structural definition carrier with default permissions', () => {
    const result = normalizeModuleRequests([TypedTestModule]);

    expect(result).toHaveLength(1);
    expect(result[0].moduleDefinition).toBe(TestModule);
    expect(scopeKeys(result[0])).toEqual([
      `${DwnInterfaceName.Messages}.${DwnMethodName.Read}`,
      `${DwnInterfaceName.Modules}.${DwnMethodName.Query}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Delete}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Read}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Write}`,
    ].sort());
  });

  test('normalizes an explicit { definition, permissions } entry', () => {
    const result = normalizeModuleRequests([
      { definition: TestModule, permissions: ['read', 'write'] },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].moduleDefinition).toBe(TestModule);
    expect(scopeKeys(result[0])).toEqual([
      `${DwnInterfaceName.Messages}.${DwnMethodName.Read}`,
      `${DwnInterfaceName.Modules}.${DwnMethodName.Query}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Read}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Write}`,
    ].sort());
  });

  test('normalizes a structural definition carrier with explicit readonly permissions', () => {
    const modules = [
      { module: TypedTestModule, permissions: ['read'] },
    ] as const;
    const result = normalizeModuleRequests(modules);

    expect(result).toHaveLength(1);
    expect(result[0].moduleDefinition).toBe(TestModule);
    expect(scopeKeys(result[0])).toEqual([
      `${DwnInterfaceName.Messages}.${DwnMethodName.Read}`,
      `${DwnInterfaceName.Modules}.${DwnMethodName.Query}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Read}`,
    ].sort());
  });

  test('rejects unsupported runtime permission names', () => {
    for (const permission of ['query', 'subscribe', 'configure']) {
      expect(() => normalizeModuleRequests([
        { definition: TestModule, permissions: [permission] as any },
      ])).toThrow('Supported permissions: read, write, delete');
    }
  });

  test('rejects non-array and duplicate runtime permission policies with deterministic paths', () => {
    expect(() => normalizeModuleRequests([{
      definition  : TestModule,
      permissions : 'read' as unknown as readonly ['read'],
    }])).toThrow('normalizeModuleRequests: modules[0].permissions must be an array.');

    expect(() => normalizeModuleRequests([{
      definition  : TestModule,
      permissions : ['delete', 'read', 'delete'],
    }])).toThrow(
      'normalizeModuleRequests: modules[0].permissions contains duplicate permission \'delete\' at indexes 0 and 2.',
    );
  });

  test('copies readonly permission policies without mutating their inputs', () => {
    const permissions = Object.freeze(['write', 'read'] as const);
    const modules = Object.freeze([Object.freeze({ definition: TestModule, permissions })] as const);

    const result = normalizeModuleRequests(modules);

    expect(result).toHaveLength(1);
    expect(permissions).toEqual(['write', 'read']);
    expect(modules[0].permissions).toBe(permissions);
  });

  test('rejects duplicate module URIs across raw, carrier, and explicit forms', () => {
    const cases: readonly (readonly ModuleRequest[])[] = [
      [TestModule, TypedTestModule],
      [TestModule, { definition: TestModule, permissions: ['read'] }],
      [TypedTestModule, { module: TypedTestModule, permissions: ['write'] }],
      [{ definition: TypedTestModule, permissions: ['delete'] }, TestModule],
    ];

    for (const modules of cases) {
      expect(() => normalizeModuleRequests(modules)).toThrow(
        'normalizeModuleRequests: duplicate module URI \'https://example.com/test\' at indexes 0 and 1.',
      );
    }
  });

  test('rejects malformed raw definitions and carriers with stable indexes', () => {
    const malformedRequests = [
      {} as ModuleRequest,
      { definition: {} } as ModuleRequest,
      { definition: { ...TestModule, published: undefined } } as unknown as ModuleRequest,
      { module: { definition: {} }, permissions: ['read'] } as ModuleRequest,
    ];

    for (const request of malformedRequests) {
      expect(() => normalizeModuleRequests([OtherModule, request])).toThrow(
        'normalizeModuleRequests: modules[1] must provide a module definition with a non-empty module URI, ' +
        'boolean published flag, and object-valued types and structure.',
      );
    }
  });

  test('reports the first duplicate URI with stable indexes without classifying definitions', () => {
    const conflictingDefinition = { ...TestModule, published: false };

    expect(() => normalizeModuleRequests([
      OtherModule,
      { definition: TestModule, permissions: ['read'] },
      { module: { definition: conflictingDefinition }, permissions: ['write'] },
    ])).toThrow(
      'normalizeModuleRequests: duplicate module URI \'https://example.com/test\' at indexes 1 and 2.',
    );
  });

  test('handles mixed bare and explicit entries', () => {
    const result = normalizeModuleRequests([
      TestModule,
      { definition: OtherModule, permissions: ['read'] },
    ]);

    expect(result).toHaveLength(2);
  });
});

describe('normalizePermissionPolicy', () => {
  test('returns a fresh copy of the default policy when omitted', () => {
    const first = normalizePermissionPolicy(undefined, 'permissions');
    const second = normalizePermissionPolicy(undefined, 'permissions');

    expect(first).toEqual(['read', 'write', 'delete']);
    expect(first).not.toBe(second);
    first.pop();
    expect(second).toEqual(['read', 'write', 'delete']);
  });
});
