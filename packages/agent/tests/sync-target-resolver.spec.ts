import type { SinonStub } from 'sinon';

import type { FollowedSyncSource } from '../src/followed-sync-source.js';
import type { ReplicationLinkState } from '../src/types/sync.js';
import type { SyncEndpointDiscovery } from '../src/sync-target-resolver.js';
import type { SyncEndpointStore } from '../src/sync-endpoint-store.js';
import type { PermissionGrantEntry, PermissionsApi } from '../src/types/permissions.js';

import sinon from 'sinon';

import { describe, expect, it } from 'bun:test';

import { normalizeDwnEndpoint, syncTargetFromLink, SyncTargetResolver } from '../src/sync-target-resolver.js';

type ResolverFixtureParams = {
  endpointError?: unknown;
  grants?: PermissionGrantEntry[];
  isRemoteMode?: boolean;
  localDwnEndpoint?: string;
  remoteEndpoints?: string[];
  remoteError?: unknown;
  supplementalEndpoint?: string;
};

type ResolverFixture = {
  fetchGrants: SinonStub;
  getPermissionForRequest: SinonStub;
  getEndpointDiscovery: SinonStub;
  getSupplementalEndpoint: SinonStub;
  getRemoteDwnEndpointUrls: SinonStub;
  resolver: SyncTargetResolver;
};

function createGrant(id: string, grantor: string, grantee: string, protocol?: string): PermissionGrantEntry {
  return {
    grant: {
      id,
      grantor,
      grantee,
      dateGranted : '2026-01-01T00:00:00.000000Z',
      dateExpires : '2999-01-01T00:00:00.000000Z',
      scope       : {
        interface : 'Messages',
        method    : 'Read',
        protocol,
      },
    },
    message: {},
  } as PermissionGrantEntry;
}

function createResolver({
  endpointError,
  grants = [],
  isRemoteMode = false,
  localDwnEndpoint,
  remoteEndpoints = [],
  remoteError,
  supplementalEndpoint,
}: ResolverFixtureParams = {}): ResolverFixture {
  const getRemoteDwnEndpointUrls = sinon.stub();
  if (remoteError === undefined) {
    getRemoteDwnEndpointUrls.resolves(remoteEndpoints);
  } else {
    getRemoteDwnEndpointUrls.rejects(remoteError);
  }

  const endpointDiscovery: SyncEndpointDiscovery = {
    getRemoteDwnEndpointUrls,
    isRemoteMode,
    localDwnEndpoint,
  };
  const getSupplementalEndpoint = sinon.stub();
  if (endpointError === undefined) {
    getSupplementalEndpoint.resolves(supplementalEndpoint);
  } else {
    getSupplementalEndpoint.rejects(endpointError);
  }

  const endpointStore = {
    clear : sinon.stub().resolves(),
    get   : getSupplementalEndpoint,
    set   : sinon.stub().resolves(),
  } satisfies SyncEndpointStore;
  const fetchGrants = sinon.stub().resolves(grants);
  const getPermissionForRequest = sinon.stub();
  const getEndpointDiscovery = sinon.stub().returns(endpointDiscovery);
  const permissionsApi = { fetchGrants, getPermissionForRequest } as unknown as PermissionsApi;

  return {
    fetchGrants,
    getPermissionForRequest,
    getEndpointDiscovery,
    getSupplementalEndpoint,
    getRemoteDwnEndpointUrls,
    resolver: new SyncTargetResolver({
      endpointStore,
      getEndpointDiscovery,
      permissionsApi,
    }),
  };
}

describe('SyncTargetResolver', () => {
  describe('getEndpointUrls', () => {
    it('should combine supplemental and discovered endpoints while deduplicating normalized URLs', async () => {
      const { resolver } = createResolver({
        supplementalEndpoint : 'https://dwn.example.com/',
        remoteEndpoints      : ['https://dwn.example.com', 'https://other.example.com/dwn'],
      });

      expect(await resolver.getEndpointUrls('did:example:alice')).toEqual([
        'https://dwn.example.com/',
        'https://other.example.com/dwn',
      ]);
    });

    it('should retain the supplemental endpoint when DID endpoint discovery fails', async () => {
      const { resolver } = createResolver({
        supplementalEndpoint : 'https://handoff.example.com',
        remoteError          : new Error('DID resolution failed'),
      });

      expect(await resolver.getEndpointUrls('did:example:alice')).toEqual(['https://handoff.example.com']);
    });

    it('should surface DID endpoint discovery failures without a supplemental endpoint', async () => {
      const expectedError = new Error('DID resolution failed');
      const { resolver } = createResolver({ remoteError: expectedError });

      await expect(resolver.getEndpointUrls('did:example:alice')).rejects.toBe(expectedError);
    });

    it('should surface endpoint store failures before requesting agent endpoint discovery', async () => {
      const expectedError = new Error('endpoint store unavailable');
      const { getEndpointDiscovery, resolver } = createResolver({ endpointError: expectedError });

      await expect(resolver.getEndpointUrls('did:example:alice')).rejects.toBe(expectedError);
      expect(getEndpointDiscovery.notCalled).toBe(true);
    });

    it('should exclude a supplemental endpoint that is the active remote-mode local DWN', async () => {
      const { resolver } = createResolver({
        isRemoteMode         : true,
        localDwnEndpoint     : 'https://local.example.com',
        supplementalEndpoint : 'https://local.example.com/',
        remoteEndpoints      : ['https://remote.example.com'],
      });

      expect(await resolver.getEndpointUrls('did:example:alice')).toEqual(['https://remote.example.com']);
    });
  });

  describe('target construction', () => {
    it('should recreate a delegated target from its durable link', () => {
      const permissionGrantIds = ['grant-1'] as [string];
      const link = {
        authorization: {
          kind        : 'delegate',
          delegateDid : 'did:example:delegate',
          permissionGrantIds,
        },
        authorizationEpoch : 'delegate-epoch',
        connectivity       : 'online',
        delegateDid        : 'did:example:delegate',
        projectionId       : 'projection',
        pull               : {},
        push               : {},
        remoteEndpoint     : 'https://dwn.example.com',
        scope              : { kind: 'protocolSet', protocols: ['https://protocol.example/notes'] },
        status             : 'live',
        tenantDid          : 'did:example:alice',
      } satisfies ReplicationLinkState;

      expect(syncTargetFromLink(link)).toEqual({
        did                : link.tenantDid,
        dwnUrl             : link.remoteEndpoint,
        delegateDid        : link.delegateDid,
        projectionId       : link.projectionId,
        scope              : link.scope,
        authorization      : link.authorization,
        authorizationEpoch : link.authorizationEpoch,
        permissionGrantIds,
      });
    });

    it('should derive a followed-source registration from role authorization', () => {
      const link = {
        authorization: {
          kind         : 'role',
          actorDid     : 'did:example:member',
          protocolRole : 'notebook/viewer',
          roleRecordId : 'role-a',
        },
        authorizationEpoch : 'role-epoch',
        connectivity       : 'online',
        projectionId       : 'projection',
        pull               : {},
        push               : {},
        remoteEndpoint     : 'https://dwn.example.com',
        scope              : {
          kind          : 'context',
          protocol      : 'https://example.com/notebooks',
          contextId     : 'notebook-a',
          protocolPaths : ['notebook/page'],
        },
        status    : 'live',
        tenantDid : 'did:example:owner',
      } satisfies ReplicationLinkState;

      const target = syncTargetFromLink(link);
      expect(target.authorDelegatedGrant).toBeUndefined();
    });

    it('should build a deterministic owner target for all protocols', async () => {
      const { getEndpointDiscovery, resolver } = createResolver();

      const [first] = await resolver.buildTargetsForEndpoint(
        'did:example:alice',
        'https://dwn.example.com',
        { protocols: 'all' },
      );
      const [second] = await resolver.buildTargetsForEndpoint(
        'did:example:alice',
        'https://dwn.example.com',
        { protocols: 'all' },
      );

      expect(first).toEqual(second);
      expect(first).toMatchObject({
        did           : 'did:example:alice',
        dwnUrl        : 'https://dwn.example.com',
        scope         : { kind: 'full' },
        authorization : { kind: 'owner' },
      });
      expect(typeof first.projectionId).toBe('string');
      expect(typeof first.authorizationEpoch).toBe('string');
      expect(getEndpointDiscovery.notCalled).toBe(true);
    });

    it('should normalize protocol sets before building a target', async () => {
      const { resolver } = createResolver();

      const [target] = await resolver.buildTargetsForEndpoint(
        'did:example:alice',
        'https://dwn.example.com',
        { protocols: ['https://protocol.example/b', 'https://protocol.example/a', 'https://protocol.example/a'] },
      );

      expect(target.scope).toEqual({
        kind      : 'protocolSet',
        protocols : ['https://protocol.example/a', 'https://protocol.example/b'],
      });
    });

    it('should derive delegated authorization from active Messages.Read grants', async () => {
      const did = 'did:example:alice';
      const delegateDid = 'did:example:delegate';
      const protocol = 'https://protocol.example/notes';
      const grant = createGrant('grant-1', did, delegateDid, protocol);
      const { fetchGrants, resolver } = createResolver({ grants: [grant] });

      const [target] = await resolver.buildTargetsForEndpoint(did, 'https://dwn.example.com', {
        delegateDid,
        protocols: [protocol],
      });

      expect(target).toMatchObject({
        delegateDid,
        permissionGrantIds : ['grant-1'],
        scope              : { kind: 'protocolSet', protocols: [protocol] },
        authorization      : {
          kind               : 'delegate',
          delegateDid,
          permissionGrantIds : ['grant-1'],
        },
      });
      expect(fetchGrants.calledOnceWith({
        author       : delegateDid,
        target       : delegateDid,
        grantor      : did,
        grantee      : delegateDid,
        checkRevoked : true,
      })).toBe(true);
    });

    it('should reject delegated targets without a covering active grant', async () => {
      const { resolver } = createResolver();

      await expect(resolver.buildTargetsForEndpoint(
        'did:example:alice',
        'https://dwn.example.com',
        {
          delegateDid : 'did:example:delegate',
          protocols   : ['https://protocol.example/notes'],
        },
      )).rejects.toThrow('No active protocol-root Messages.Read permission');
    });

    it('should bind a followed source to its accepted endpoint and actor role', async () => {
      const source = followedSource();
      const { getRemoteDwnEndpointUrls, resolver } = createResolver();

      const target = await resolver.buildTargetForSource(source);

      expect(getRemoteDwnEndpointUrls.notCalled).toBe(true);
      expect(target).toMatchObject({
        did    : source.sourceDid,
        dwnUrl : source.remoteEndpoint,
        scope  : {
          kind          : 'context',
          protocol      : source.protocol,
          contextId     : source.contextId,
          protocolPaths : source.protocolPaths,
        },
        authorization: {
          kind         : 'role',
          actorDid     : source.actorDid,
          protocolRole : source.protocolRole,
          roleRecordId : source.id,
        },
      });
      expect(typeof target.projectionId).toBe('string');
      expect(typeof target.authorizationEpoch).toBe('string');
    });

    it('should keep transient delegate grants out of followed-source target identity', async () => {
      const delegateDid = 'did:example:delegate';
      const source = followedSource();
      const { getPermissionForRequest, resolver } = createResolver({
        remoteEndpoints: ['https://owner.example.com'],
      });

      const target = await resolver.buildTargetForSource(source, delegateDid);

      expect(getPermissionForRequest.notCalled).toBe(true);
      expect(target.delegateDid).toBe(delegateDid);
      expect(target.authorization).toEqual({
        kind         : 'role',
        actorDid     : source.actorDid,
        protocolRole : source.protocolRole,
        roleRecordId : source.id,
      });
      expect(target.authorDelegatedGrant).toBeUndefined();
      expect(target.permissionGrantIds).toBeUndefined();
    });

    it('should refresh the full role delegate grant without changing durable target identity', async () => {
      const delegateDid = 'did:example:delegate';
      const source = followedSource();
      const initialGrant = createGrant('delegate-grant', source.actorDid, delegateDid, source.protocol);
      const refreshedGrant = { ...initialGrant, message: { recordId: 'fresh-grant' } } as PermissionGrantEntry;
      const { getPermissionForRequest, resolver } = createResolver({
        remoteEndpoints: ['https://owner.example.com'],
      });
      getPermissionForRequest.resolves(initialGrant);
      const target = await resolver.buildTargetForSource(source, delegateDid);
      getPermissionForRequest.resetHistory();
      getPermissionForRequest.onFirstCall().resolves(initialGrant);
      getPermissionForRequest.onSecondCall().resolves(refreshedGrant);

      const first = await resolver.withCurrentRoleGrant(target);
      const second = await resolver.withCurrentRoleGrant(target);

      expect(getPermissionForRequest.callCount).toBe(2);
      expect(getPermissionForRequest.alwaysCalledWithMatch({ forceRefresh: true })).toBe(true);
      expect(getPermissionForRequest.firstCall.args[0].contextId).toBeUndefined();
      expect(getPermissionForRequest.secondCall.args[0].contextId).toBeUndefined();
      expect(first.authorDelegatedGrant).toBe(initialGrant.message);
      expect(second.authorDelegatedGrant).toBe(refreshedGrant.message);
      expect(second.authorization).toBe(target.authorization);
      expect(second.authorizationEpoch).toBe(target.authorizationEpoch);
    });
  });
});

function followedSource(overrides: Partial<FollowedSyncSource> = {}): FollowedSyncSource {
  return {
    acceptanceId   : 'acceptance-a',
    id             : 'role-a',
    sourceDid      : 'did:example:owner',
    remoteEndpoint : 'https://owner.example.com',
    actorDid       : 'did:example:member',
    protocol       : 'https://example.com/notebooks',
    contextId      : 'notebook-a',
    protocolRole   : 'notebook/viewer',
    protocolPaths  : ['notebook', 'notebook/page', 'notebook/page/delta'],
    roles          : ['notebook/collaborator', 'notebook/viewer'],
    ...overrides,
  };
}

describe('normalizeDwnEndpoint', () => {
  it('should remove query, fragment, and a trailing slash', () => {
    expect(normalizeDwnEndpoint('https://dwn.example.com/path/?query=1#fragment')).toBe('https://dwn.example.com/path');
  });

  it('should preserve legacy validation errors', () => {
    expect(() => normalizeDwnEndpoint('not a URL')).toThrow('SyncEngineLevel: drain endpoint must be a valid URL.');
    expect(() => normalizeDwnEndpoint('ftp://dwn.example.com')).toThrow('SyncEngineLevel: drain endpoint must use http or https.');
  });
});
