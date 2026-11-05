import { describe, expect, it } from 'bun:test';

import { getModuleClosureEdges } from '../src/sync-scope-closure.js';
import {
  areReplicationLinksCurrent,
  canonicalizeSyncScope,
  computeAuthorizationEpoch,
  computeProjectionId,
  messageFeedFiltersForSyncScope,
  modulesForSyncScope,
  normalizeSyncModules,
  singleModuleForSyncScope,
  SYNC_PROJECTION_ROOT_VERSION,
  syncEventCoversModule,
  syncEventScope,
  syncRegistrationCoversModule,
  syncScopeCoversModule,
  syncScopeFromModules,
} from '../src/types/sync.js';

describe('sync scope identity', () => {
  it('rejects old and mixed scope fields before selecting a full feed', () => {
    for (const scope of [
      { kind: 'protocolSet', protocols: ['https://example.com/private'] },
      { kind: 'full', protocols: ['https://example.com/private'] },
      { kind: 'context', protocol: 'https://example.com/private', contextId: 'parent', protocolPaths: ['note'] },
      { kind: 'context', module: 'https://example.com/private', contextId: 'parent', modulePaths: ['note'], protocol: 'old' },
    ]) {
      expect(() => canonicalizeSyncScope(scope as never)).toThrow('module-format fields');
      expect(() => messageFeedFiltersForSyncScope(scope as never)).toThrow('module-format fields');
    }
  });

  it('normalizes module sets by sorting and deduping', () => {
    expect(normalizeSyncModules([
      'https://example.com/b',
      'https://example.com/a',
      'https://example.com/b',
    ])).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it('rejects empty module sets', () => {
    expect(() => normalizeSyncModules([])).toThrow('module-set scope requires at least one module');
  });

  it('uses the durable message-feed projection root version', () => {
    expect(SYNC_PROJECTION_ROOT_VERSION).toBe('replication-log-feed-v1');
  });

  it('derives full and module-set scopes from identity options', () => {
    const fullScope = syncScopeFromModules('all');
    expect(fullScope).toEqual({ kind: 'full' });
    expect(messageFeedFiltersForSyncScope(fullScope)).toBeUndefined();

    const scope = syncScopeFromModules([
      'https://example.com/b',
      'https://example.com/a',
    ]);
    expect(scope).toEqual({
      kind    : 'moduleSet',
      modules : ['https://example.com/a', 'https://example.com/b'],
    });
    expect(modulesForSyncScope(scope)).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(messageFeedFiltersForSyncScope(scope)).toEqual([
      { module: 'https://example.com/a' },
      { module: 'https://example.com/b' },
    ]);
    expect(singleModuleForSyncScope(scope)).toBeUndefined();
  });

  it('returns a single module label only for one-module scopes', () => {
    const scope = syncScopeFromModules(['https://example.com/profile']);
    expect(singleModuleForSyncScope(scope)).toBe('https://example.com/profile');
  });

  it('projects an exact-context scope without widening it to the module root', () => {
    const scope = {
      kind        : 'context' as const,
      module      : 'https://example.com/notebooks',
      contextId   : 'notebook-a',
      modulePaths : ['notebook/page', 'notebook/page/delta'] as [string, ...string[]],
    };

    expect(modulesForSyncScope(scope)).toEqual([scope.module]);
    expect(singleModuleForSyncScope(scope)).toBe(scope.module);
    expect(syncScopeCoversModule(scope, scope.module)).toBe(true);
    expect(syncScopeCoversModule(scope, 'https://example.com/other')).toBe(false);
    expect(messageFeedFiltersForSyncScope(scope)).toEqual([
      {
        interface       : 'Records',
        module          : scope.module,
        modulePath      : 'notebook/page',
        contextIdPrefix : scope.contextId,
      },
      {
        interface       : 'Records',
        module          : scope.module,
        modulePath      : 'notebook/page/delta',
        contextIdPrefix : scope.contextId,
      },
    ]);
    expect(syncEventScope(scope)).toEqual({
      contextId : scope.contextId,
      module    : scope.module,
      modules   : [scope.module],
    });
  });

  it('canonicalizes exact-context scopes and includes the context in projection identity', async () => {
    const tenantDid = 'did:example:alice';
    const module = 'https://example.com/notebooks';
    const scope = {
      kind        : 'context' as const,
      module,
      contextId   : 'notebook-a',
      modulePaths : ['notebook/page', 'notebook/page/delta'] as [string, ...string[]],
    };
    const reorderedScope = {
      contextId   : 'notebook-a',
      module,
      kind        : 'context' as const,
      modulePaths : ['notebook/page/delta', 'notebook/page'] as [string, ...string[]],
    };

    expect(JSON.stringify(canonicalizeSyncScope(scope)))
      .toBe(
        `{"contextId":"notebook-a","kind":"context","module":"${module}",` +
        `"modulePaths":["notebook/page","notebook/page/delta"]}`,
      );
    expect(await computeProjectionId(tenantDid, scope))
      .toBe(await computeProjectionId(tenantDid, reorderedScope));
    expect(await computeProjectionId(tenantDid, scope))
      .not.toBe(await computeProjectionId(tenantDid, { ...scope, contextId: 'notebook-b' }));
    expect(await computeProjectionId(tenantDid, scope))
      .not.toBe(await computeProjectionId(tenantDid, { ...scope, modulePaths: ['notebook/page'] }));
  });

  it('shares module coverage across registrations, links, and event scopes', () => {
    const module = 'https://example.com/profile';
    expect(syncRegistrationCoversModule(undefined, module)).toBe(false);
    expect(syncRegistrationCoversModule({ modules: 'all' }, module)).toBe(true);
    expect(syncRegistrationCoversModule({ modules: [module] }, module)).toBe(true);
    expect(syncRegistrationCoversModule({ modules: ['https://example.com/other'] }, module)).toBe(false);

    expect(syncScopeCoversModule({ kind: 'full' }, module)).toBe(true);
    expect(syncScopeCoversModule({ kind: 'moduleSet', modules: [module] }, module)).toBe(true);
    expect(syncScopeCoversModule({ kind: 'moduleSet', modules: ['https://example.com/other'] }, module))
      .toBe(false);

    expect(syncEventCoversModule({}, module)).toBe(true);
    expect(syncEventCoversModule({ module }, module)).toBe(true);
    expect(syncEventCoversModule({ module: 'https://example.com/other', modules: [module] }, module)).toBe(true);
    expect(syncEventCoversModule({ module, modules: ['https://example.com/other'] }, module)).toBe(false);
  });

  it('requires every replication link to be live, online, and pull-current', () => {
    const current = { connectivity: 'online', isPullCurrent: true, status: 'live' } as const;
    expect(areReplicationLinksCurrent([])).toBe(false);
    expect(areReplicationLinksCurrent([current])).toBe(true);
    expect(areReplicationLinksCurrent([current, { ...current, isPullCurrent: false }])).toBe(false);
    expect(areReplicationLinksCurrent([{ ...current, connectivity: 'offline' }])).toBe(false);
    expect(areReplicationLinksCurrent([{ ...current, status: 'initializing' }])).toBe(false);
  });

  it('computes projection IDs from tenant and normalized scope', async () => {
    const tenantDid = 'did:example:alice';
    const id1 = await computeProjectionId(tenantDid, syncScopeFromModules([
      'https://example.com/b',
      'https://example.com/a',
    ]));
    const id2 = await computeProjectionId(tenantDid, syncScopeFromModules([
      'https://example.com/a',
      'https://example.com/b',
    ]));
    const id3 = await computeProjectionId('did:example:bob', syncScopeFromModules([
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
    const scope = syncScopeFromModules(['https://example.com/profile']);
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

  it('changes role authorization epochs with membership authority but not transient grants', async () => {
    const authorization = {
      kind         : 'role' as const,
      actorDid     : 'did:example:member',
      moduleRole   : 'notebook/viewer',
      roleRecordId : 'role-a',
    };
    const epoch = await computeAuthorizationEpoch(authorization);

    const changedEpochs = await Promise.all([
      computeAuthorizationEpoch({ ...authorization, actorDid: 'did:example:other' }),
      computeAuthorizationEpoch({ ...authorization, moduleRole: 'notebook/editor' }),
      computeAuthorizationEpoch({ ...authorization, roleRecordId: 'role-b' }),
    ]);
    expect(changedEpochs.every(changed => changed !== epoch)).toBe(true);
    expect(await computeAuthorizationEpoch({ ...authorization, delegateDid: 'did:example:other' } as any)).toBe(epoch);
    expect(await computeAuthorizationEpoch({ ...authorization, delegateGrant: { id: 'ignored' } } as any)).toBe(epoch);
  });

  it('keeps projection ID stable while changing authorization epoch for a re-grant of the same scope', async () => {
    const tenantDid = 'did:example:alice';
    const scope = syncScopeFromModules([
      'https://example.com/social',
      'https://example.com/profile',
    ]);
    const sameScope = syncScopeFromModules([
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

  it('extracts uses and nested cross-module dependency references from module definitions', () => {
    const edges = getModuleClosureEdges({
      module    : 'https://example.com/composed',
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
      dependencyModules : ['https://example.com/social', 'https://example.com/tasks'],
      usesModules       : ['https://example.com/social', 'https://example.com/tasks'],
    });
  });

  it('does not treat bare local references that match uses aliases as cross-module dependencies', () => {
    const edges = getModuleClosureEdges({
      module    : 'https://example.com/composed',
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
      dependencyModules : [],
      usesModules       : ['https://example.com/roles', 'https://example.com/threads'],
    });
  });

});
