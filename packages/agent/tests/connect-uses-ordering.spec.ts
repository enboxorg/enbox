import { describe, expect, it } from 'bun:test';

import type { ConnectPermissionRequest } from '@enbox/connect';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { orderPermissionRequestsByUsesDependencies } from '../src/connect-approval.js';

/** Minimal permission request builder for pure ordering tests. */
function request(protocol: string, uses?: Record<string, string>): ConnectPermissionRequest {
  const definition = {
    protocol,
    published : false,
    types     : {},
    structure : {},
    ...(uses !== undefined && { uses }),
  } as unknown as ProtocolDefinition;
  return { protocolDefinition: definition, permissionScopes: [] };
}

/** Project ordering levels down to protocol URIs for readable assertions. */
function levelUris(levels: ConnectPermissionRequest[][]): string[][] {
  return levels.map((level) => level.map((request) => request.protocolDefinition.protocol));
}

describe('orderPermissionRequestsByUsesDependencies', () => {
  it('keeps independent protocols in a single concurrent level', () => {
    const levels = orderPermissionRequestsByUsesDependencies([
      request('https://example.org/a'),
      request('https://example.org/b'),
    ]);

    expect(levelUris(levels)).toEqual([['https://example.org/a', 'https://example.org/b']]);
  });

  it('places a composing protocol after its in-batch `uses` dependency', () => {
    const board = request('https://app.example/board', { social: 'https://id.example/social' });
    const social = request('https://id.example/social');

    // Dependent is listed first — ordering must still prepare the dependency first.
    const levels = orderPermissionRequestsByUsesDependencies([board, social]);

    expect(levelUris(levels)).toEqual([
      ['https://id.example/social'],
      ['https://app.example/board'],
    ]);
  });

  it('ignores `uses` targets that are not part of the batch', () => {
    // social-graph is not requested in this batch, so `board` has no in-batch
    // dependency and stays in the first level.
    const levels = orderPermissionRequestsByUsesDependencies([
      request('https://app.example/board', { social: 'https://id.example/social' }),
    ]);

    expect(levelUris(levels)).toEqual([['https://app.example/board']]);
  });

  it('orders a multi-level dependency chain', () => {
    const levels = orderPermissionRequestsByUsesDependencies([
      request('https://x/c', { b: 'https://x/b' }),
      request('https://x/b', { a: 'https://x/a' }),
      request('https://x/a'),
    ]);

    expect(levelUris(levels)).toEqual([['https://x/a'], ['https://x/b'], ['https://x/c']]);
  });

  it('breaks a dependency cycle by emitting the remaining requests as a final level', () => {
    const levels = orderPermissionRequestsByUsesDependencies([
      request('https://x/a', { b: 'https://x/b' }),
      request('https://x/b', { a: 'https://x/a' }),
    ]);

    // No progress is possible, so both are emitted together (best-effort — the
    // DWN's fail-closed verification surfaces the real conflict downstream).
    expect(levels).toHaveLength(1);
    expect(levels[0]).toHaveLength(2);
  });

  it('returns no levels for an empty batch', () => {
    expect(orderPermissionRequestsByUsesDependencies([])).toEqual([]);
  });
});
