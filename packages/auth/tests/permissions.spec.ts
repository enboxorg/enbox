import { describe, expect, test } from 'bun:test';

import { normalizeProtocolRequests } from '../src/permissions.js';

/** Minimal protocol definition for testing. */
const TestProtocol = {
  protocol  : 'https://example.com/test',
  published : true,
  types     : { entry: { dataFormats: ['application/json'] } },
  structure : { entry: {} },
};

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
    // Default permissions should produce multiple scopes
    expect(result[0].permissionScopes.length).toBeGreaterThan(0);
  });

  test('normalizes an explicit { definition, permissions } entry', () => {
    const result = normalizeProtocolRequests([
      { definition: TestProtocol as any, permissions: ['read', 'write'] },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].protocolDefinition).toBe(TestProtocol);
    expect(result[0].permissionScopes.length).toBeGreaterThan(0);
  });

  test('handles mixed bare and explicit entries', () => {
    const result = normalizeProtocolRequests([
      TestProtocol as any,
      { definition: TestProtocol as any, permissions: ['read'] },
    ]);

    expect(result).toHaveLength(2);
  });
});
