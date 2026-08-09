import { describe, expect, test } from 'bun:test';

import type { DwnProtocolDefinition } from '@enbox/agent';
import type { ProtocolRequest } from '../src/types.js';

import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';
import { normalizeProtocolRequests, serviceConfigProtocolRequest } from '../src/permissions.js';

/** Minimal protocol definition for testing. */
const TestProtocol = {
  protocol  : 'https://example.com/test',
  published : true,
  types     : { entry: { dataFormats: ['application/json'] } },
  structure : { entry: {} },
} satisfies DwnProtocolDefinition;

/** Structural higher-level protocol carrying runtime-only application data. */
const TypedTestProtocol = {
  definition : TestProtocol,
  codecs     : { entry: { decode: (): void => {}, encode: (): void => {} } },
} as const;

const OtherProtocol = {
  ...TestProtocol,
  protocol: 'https://example.com/other',
} satisfies DwnProtocolDefinition;

function scopeKeys(result: ReturnType<typeof normalizeProtocolRequests>[number]): string[] {
  return result.permissionScopes
    .map((scope) => `${scope.interface}.${scope.method}`)
    .sort();
}

describe('normalizeProtocolRequests', () => {
  test('returns empty array for undefined input', () => {
    expect(normalizeProtocolRequests(undefined)).toEqual([]);
  });

  test('returns empty array for empty array input', () => {
    expect(normalizeProtocolRequests([])).toEqual([]);
  });

  test('builds a read-only service-config request with message-feed replication access', () => {
    const request = serviceConfigProtocolRequest();
    const [result] = normalizeProtocolRequests([request]);

    expect(result.protocolDefinition).toBe(request.definition);
    expect(scopeKeys(result)).toEqual([
      `${DwnInterfaceName.Messages}.${DwnMethodName.Read}`,
      `${DwnInterfaceName.Protocols}.${DwnMethodName.Query}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Read}`,
    ].sort());
  });

  test('normalizes a bare protocol definition with default permissions', () => {
    const result = normalizeProtocolRequests([TestProtocol]);

    expect(result).toHaveLength(1);
    expect(result[0].protocolDefinition).toBe(TestProtocol);
    expect(scopeKeys(result[0])).toEqual([
      `${DwnInterfaceName.Messages}.${DwnMethodName.Read}`,
      `${DwnInterfaceName.Protocols}.${DwnMethodName.Query}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Delete}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Read}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Write}`,
    ].sort());
  });

  test('normalizes a structural definition carrier with default permissions', () => {
    const result = normalizeProtocolRequests([TypedTestProtocol]);

    expect(result).toHaveLength(1);
    expect(result[0].protocolDefinition).toBe(TestProtocol);
    expect(scopeKeys(result[0])).toEqual([
      `${DwnInterfaceName.Messages}.${DwnMethodName.Read}`,
      `${DwnInterfaceName.Protocols}.${DwnMethodName.Query}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Delete}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Read}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Write}`,
    ].sort());
  });

  test('normalizes an explicit { definition, permissions } entry', () => {
    const result = normalizeProtocolRequests([
      { definition: TestProtocol, permissions: ['read', 'write'] },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].protocolDefinition).toBe(TestProtocol);
    expect(scopeKeys(result[0])).toEqual([
      `${DwnInterfaceName.Messages}.${DwnMethodName.Read}`,
      `${DwnInterfaceName.Protocols}.${DwnMethodName.Query}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Read}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Write}`,
    ].sort());
  });

  test('normalizes a structural definition carrier with explicit readonly permissions', () => {
    const protocols = [
      { protocol: TypedTestProtocol, permissions: ['read'] },
    ] as const;
    const result = normalizeProtocolRequests(protocols);

    expect(result).toHaveLength(1);
    expect(result[0].protocolDefinition).toBe(TestProtocol);
    expect(scopeKeys(result[0])).toEqual([
      `${DwnInterfaceName.Messages}.${DwnMethodName.Read}`,
      `${DwnInterfaceName.Protocols}.${DwnMethodName.Query}`,
      `${DwnInterfaceName.Records}.${DwnMethodName.Read}`,
    ].sort());
  });

  test('rejects unsupported runtime permission names', () => {
    for (const permission of ['query', 'subscribe', 'configure']) {
      expect(() => normalizeProtocolRequests([
        { definition: TestProtocol, permissions: [permission] as any },
      ])).toThrow('Supported permissions: read, write, delete');
    }
  });

  test('rejects non-array and duplicate runtime permission policies with deterministic paths', () => {
    expect(() => normalizeProtocolRequests([{
      definition  : TestProtocol,
      permissions : 'read' as unknown as readonly ['read'],
    }])).toThrow('normalizeProtocolRequests: protocols[0].permissions must be an array.');

    expect(() => normalizeProtocolRequests([{
      definition  : TestProtocol,
      permissions : ['delete', 'read', 'delete'],
    }])).toThrow(
      'normalizeProtocolRequests: protocols[0].permissions contains duplicate permission \'delete\' at indexes 0 and 2.',
    );
  });

  test('copies readonly permission policies without mutating their inputs', () => {
    const permissions = Object.freeze(['write', 'read'] as const);
    const protocols = Object.freeze([Object.freeze({ definition: TestProtocol, permissions })] as const);

    const result = normalizeProtocolRequests(protocols);

    expect(result).toHaveLength(1);
    expect(permissions).toEqual(['write', 'read']);
    expect(protocols[0].permissions).toBe(permissions);
  });

  test('rejects duplicate protocol URIs across raw, carrier, and explicit forms', () => {
    const cases: readonly (readonly ProtocolRequest[])[] = [
      [TestProtocol, TypedTestProtocol],
      [TestProtocol, { definition: TestProtocol, permissions: ['read'] }],
      [TypedTestProtocol, { protocol: TypedTestProtocol, permissions: ['write'] }],
      [{ definition: TypedTestProtocol, permissions: ['delete'] }, TestProtocol],
    ];

    for (const protocols of cases) {
      expect(() => normalizeProtocolRequests(protocols)).toThrow(
        'normalizeProtocolRequests: duplicate protocol URI \'https://example.com/test\' at indexes 0 and 1.',
      );
    }
  });

  test('rejects malformed raw definitions and carriers with stable indexes', () => {
    const malformedRequests = [
      {} as ProtocolRequest,
      { definition: {} } as ProtocolRequest,
      { definition: { ...TestProtocol, published: undefined } } as unknown as ProtocolRequest,
      { protocol: { definition: {} }, permissions: ['read'] } as ProtocolRequest,
    ];

    for (const request of malformedRequests) {
      expect(() => normalizeProtocolRequests([OtherProtocol, request])).toThrow(
        'normalizeProtocolRequests: protocols[1] must provide a protocol definition with a non-empty protocol URI, ' +
        'boolean published flag, and object-valued types and structure.',
      );
    }
  });

  test('reports the first duplicate URI with stable indexes without classifying definitions', () => {
    const conflictingDefinition = { ...TestProtocol, published: false };

    expect(() => normalizeProtocolRequests([
      OtherProtocol,
      { definition: TestProtocol, permissions: ['read'] },
      { protocol: { definition: conflictingDefinition }, permissions: ['write'] },
    ])).toThrow(
      'normalizeProtocolRequests: duplicate protocol URI \'https://example.com/test\' at indexes 1 and 2.',
    );
  });

  test('handles mixed bare and explicit entries', () => {
    const result = normalizeProtocolRequests([
      TestProtocol,
      { definition: OtherProtocol, permissions: ['read'] },
    ]);

    expect(result).toHaveLength(2);
  });
});
