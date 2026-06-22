import { describe, expect, test } from 'bun:test';

import { normalizeProtocolRequests } from '../src/permissions.js';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

/** Minimal protocol definition for testing. */
const TestProtocol = {
  protocol  : 'https://example.com/test',
  published : true,
  types     : { entry: { dataFormats: ['application/json'] } },
  structure : { entry: {} },
};

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

  test('normalizes a bare protocol definition with default permissions', () => {
    const result = normalizeProtocolRequests([TestProtocol as any]);

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
      { definition: TestProtocol as any, permissions: ['read', 'write'] },
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

  test('rejects unsupported runtime permission names', () => {
    for (const permission of ['query', 'subscribe', 'configure']) {
      expect(() => normalizeProtocolRequests([
        { definition: TestProtocol as any, permissions: [permission] as any },
      ])).toThrow('Supported permissions: read, write, delete');
    }
  });

  test('handles mixed bare and explicit entries', () => {
    const result = normalizeProtocolRequests([
      TestProtocol as any,
      { definition: TestProtocol as any, permissions: ['read'] },
    ]);

    expect(result).toHaveLength(2);
  });
});
