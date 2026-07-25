import { DwnConstant } from '@enbox/dwn-sdk-js';
import { describe, expect, it } from 'bun:test';

import { getProtocolClosureEdges } from '../src/sync-scope-closure.js';
import {
  computeAuthorizationEpoch,
  computeProjectionId,
  normalizeSyncProtocols,
  protocolsForSyncScope,
  singleProtocolForSyncScope,
  SYNC_PROJECTION_ROOT_VERSION,
  syncScopeFromProtocols,
} from '../src/types/sync.js';

describe('sync scope identity', () => {
  it('normalizes protocol sets by sorting and deduping', () => {
    expect(normalizeSyncProtocols([
      'https://example.com/b',
      'https://example.com/a',
      'https://example.com/b',
    ])).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it('rejects empty protocol sets', () => {
    expect(() => normalizeSyncProtocols([])).toThrow('protocol-set scope requires at least one protocol');
  });

  it('enforces the protocol-set cardinality limit after deduplication', () => {
    const protocols = Array.from(
      { length: DwnConstant.maxFilterValues },
      (_, index) => `https://example.com/protocols/${index.toString().padStart(3, '0')}`,
    );

    expect(normalizeSyncProtocols([...protocols, protocols[0]])).toEqual(protocols);
    expect(() => normalizeSyncProtocols([...protocols, 'https://example.com/protocols/extra']))
      .toThrow(`protocol-set scope supports at most ${DwnConstant.maxFilterValues} protocol URIs`);
  });

  it('uses the durable message-feed projection root version', () => {
    expect(SYNC_PROJECTION_ROOT_VERSION).toBe('replication-log-feed-v1');
  });

  it('derives full and protocol-set scopes from identity options', () => {
    expect(syncScopeFromProtocols('all')).toEqual({ kind: 'full' });

    const scope = syncScopeFromProtocols([
      'https://example.com/b',
      'https://example.com/a',
    ]);
    expect(scope).toEqual({
      kind      : 'protocolSet',
      protocols : ['https://example.com/a', 'https://example.com/b'],
    });
    expect(protocolsForSyncScope(scope)).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(singleProtocolForSyncScope(scope)).toBeUndefined();
  });

  it('returns a single protocol label only for one-protocol scopes', () => {
    const scope = syncScopeFromProtocols(['https://example.com/profile']);
    expect(singleProtocolForSyncScope(scope)).toBe('https://example.com/profile');
  });

  it('computes projection IDs from tenant and normalized scope', async () => {
    const tenantDid = 'did:example:alice';
    const id1 = await computeProjectionId(tenantDid, syncScopeFromProtocols([
      'https://example.com/b',
      'https://example.com/a',
    ]));
    const id2 = await computeProjectionId(tenantDid, syncScopeFromProtocols([
      'https://example.com/a',
      'https://example.com/b',
    ]));
    const id3 = await computeProjectionId('did:example:bob', syncScopeFromProtocols([
      'https://example.com/a',
      'https://example.com/b',
    ]));

    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).not.toContain('+');
    expect(id1).not.toContain('/');
    expect(id1).not.toContain('=');
  });

  it('keeps projection ID independent of authorization epoch', async () => {
    const scope = syncScopeFromProtocols(['https://example.com/profile']);
    const projectionId = await computeProjectionId('did:example:alice', scope);
    const ownerEpoch = await computeAuthorizationEpoch({ kind: 'owner' });
    const delegateEpoch = await computeAuthorizationEpoch({
      kind        : 'delegate',
      delegateDid : 'did:example:delegate',
      grants      : [{
        id          : 'grant-1',
        dateGranted : '2026-01-01T00:00:00.000000Z',
        dateExpires : '2027-01-01T00:00:00.000000Z',
      }],
    });

    expect(projectionId).not.toBe(ownerEpoch);
    expect(ownerEpoch).not.toBe(delegateEpoch);
  });

  it('normalizes grant order when computing authorization epochs', async () => {
    const epoch1 = await computeAuthorizationEpoch({
      kind        : 'delegate',
      delegateDid : 'did:example:delegate',
      grants      : [
        { id: 'grant-b', dateExpires: '2027-01-01T00:00:00.000000Z' },
        { id: 'grant-a', dateExpires: '2027-01-01T00:00:00.000000Z' },
      ],
    });
    const epoch2 = await computeAuthorizationEpoch({
      kind        : 'delegate',
      delegateDid : 'did:example:delegate',
      grants      : [
        { id: 'grant-a', dateExpires: '2027-01-01T00:00:00.000000Z' },
        { id: 'grant-b', dateExpires: '2027-01-01T00:00:00.000000Z' },
      ],
    });

    expect(epoch1).toBe(epoch2);
  });

  it('keeps projection ID stable while changing authorization epoch for a re-grant of the same scope', async () => {
    const tenantDid = 'did:example:alice';
    const scope = syncScopeFromProtocols([
      'https://example.com/social',
      'https://example.com/profile',
    ]);
    const sameScope = syncScopeFromProtocols([
      'https://example.com/profile',
      'https://example.com/social',
    ]);
    const projectionId = await computeProjectionId(tenantDid, scope);
    const sameProjectionId = await computeProjectionId(tenantDid, sameScope);
    const oldEpoch = await computeAuthorizationEpoch({
      kind        : 'delegate',
      delegateDid : 'did:example:delegate',
      grants      : [{ id: 'grant-old', dateExpires: '2027-01-01T00:00:00.000000Z' }],
    });
    const newEpoch = await computeAuthorizationEpoch({
      kind        : 'delegate',
      delegateDid : 'did:example:delegate',
      grants      : [{ id: 'grant-new', dateExpires: '2027-01-01T00:00:00.000000Z' }],
    });

    expect(projectionId).toBe(sameProjectionId);
    expect(oldEpoch).not.toBe(newEpoch);
  });

  it('extracts uses and nested cross-protocol dependency references from protocol definitions', () => {
    const edges = getProtocolClosureEdges({
      protocol  : 'https://example.com/composed',
      published : true,
      uses      : {
        social : 'https://example.com/social',
        tasks  : 'https://example.com/tasks',
      },
      types     : {},
      structure : {
        root: {
          $actions : [{ who: 'anyone', can: ['create'] }],
          reply    : {
            $ref : 'social:thread',
            note : {
              $ref: 'tasks:item',
            },
          },
          localRole: {
            $actions: [{ role: 'social:moderator', can: ['create'] }],
          },
          localOf: {
            $actions: [{ who: 'author', of: 'tasks:item', can: ['read'] }],
          },
          localOnly: {
            $ref     : 'social',
            $actions : [
              { role: 'tasks', can: ['create'] },
              { who: 'recipient', of: 'tasks', can: ['read'] },
            ],
          },
        },
      },
    });

    expect(edges).toEqual({
      dependencyProtocols : ['https://example.com/social', 'https://example.com/tasks'],
      usesProtocols       : ['https://example.com/social', 'https://example.com/tasks'],
    });
  });

  it('does not treat bare local references that match uses aliases as cross-protocol dependencies', () => {
    const edges = getProtocolClosureEdges({
      protocol  : 'https://example.com/composed',
      published : true,
      uses      : {
        roles   : 'https://example.com/roles',
        threads : 'https://example.com/threads',
      },
      types     : {},
      structure : {
        root: {
          child: {
            $ref     : 'threads',
            $actions : [
              { role: 'roles', can: ['create'] },
              { who: 'recipient', of: 'threads', can: ['read'] },
            ],
          },
        },
      },
    });

    expect(edges).toEqual({
      dependencyProtocols : [],
      usesProtocols       : ['https://example.com/roles', 'https://example.com/threads'],
    });
  });

});
