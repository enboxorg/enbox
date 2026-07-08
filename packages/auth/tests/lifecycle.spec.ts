import { describe, expect, test } from 'bun:test';

import { PermissionsProtocol } from '@enbox/dwn-sdk-js';
import { DwnPermissionGrant, HdIdentityVaultRecoveryPhraseMismatchError } from '@enbox/agent';

import { AuthEventEmitter } from '../src/events.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { RecoveryPhraseMismatchError } from '../src/errors.js';
import { STORAGE_KEYS } from '../src/types.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';
import { deriveActiveSyncScope, deriveSyncScopeFromGrants, ensureVaultReady, finalizeDelegateSession, importDelegateAndSetupSync, processConnectedGrants, registerSyncScopeForIdentity, toSyncIdentityProtocols } from '../src/connect/lifecycle.js';

// ── Helpers ──────────────────────────────────────────────────────

/** Build a mock unscoped (unrestricted) grant — no protocol in scope. */
function buildUnscopedGrantMessage(
  grantId: string,
  scopeInterface = 'Messages',
  scopeMethod = 'Read',
  dateExpires = '2040-06-25T16:09:16.693356Z',
): any {
  const grantData = JSON.stringify({
    dateExpires,
    scope     : { interface: scopeInterface, method: scopeMethod },
    delegated : true,
  });
  const encoded = btoa(grantData).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return {
    recordId    : grantId,
    contextId   : grantId,
    encodedData : encoded,
    descriptor  : {
      interface    : 'Records',
      method       : 'Write',
      protocol     : 'https://identity.foundation/dwn/permissions',
      protocolPath : 'grant',
      recipient    : 'did:jwk:delegate1',
      dateCreated  : '2025-01-01T00:00:00.000000Z',
      dataFormat   : 'application/json',
      dataCid      : 'bafytest',
      dataSize     : 100,
    },
    authorization: {
      signature: {
        signatures: [{ protected: btoa(JSON.stringify({ kid: 'did:dht:owner1#sig' })) }],
      },
    },
  };
}

/** Build a mock DwnDataEncodedRecordsWriteMessage (grant) that DwnPermissionGrant.parse accepts. */
function buildGrantMessage(protocol: string, grantId: string): any {
  const grantData = JSON.stringify({
    dateExpires : '2040-06-25T16:09:16.693356Z',
    scope       : { interface: 'Messages', method: 'Read', protocol },
    delegated   : true,
  });
  const encoded = btoa(grantData).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return {
    recordId    : grantId,
    contextId   : grantId,
    encodedData : encoded,
    descriptor  : {
      interface    : 'Records',
      method       : 'Write',
      protocol     : 'https://identity.foundation/dwn/permissions',
      protocolPath : 'grant',
      recipient    : 'did:jwk:delegate1',
      dateCreated  : '2025-01-01T00:00:00.000000Z',
      dataFormat   : 'application/json',
      dataCid      : 'bafytest',
      dataSize     : 100,
    },
    authorization: {
      signature: {
        signatures: [{ protected: btoa(JSON.stringify({ kid: 'did:dht:owner1#sig' })) }],
      },
    },
  };
}

function buildGrantEntry(protocol: string, grantId: string): any {
  const message = buildGrantMessage(protocol, grantId);
  return {
    grant: DwnPermissionGrant.parse(message),
    message,
  };
}

function buildUnscopedGrantEntry(
  grantId: string,
  scopeInterface = 'Messages',
  scopeMethod = 'Read',
  dateExpires = '2040-06-25T16:09:16.693356Z',
): any {
  const message = buildUnscopedGrantMessage(grantId, scopeInterface, scopeMethod, dateExpires);
  return {
    grant: DwnPermissionGrant.parse(message),
    message,
  };
}

describe('ensureVaultReady', () => {
  test('translates HD vault recovery phrase mismatch errors', async () => {
    const emitter = new AuthEventEmitter();
    let startCalled = false;
    const agent = createMockAgent({
      start: async () => {
        startCalled = true;
      },
      vaultResetPasswordWithRecoveryPhrase: async () => {
        throw new HdIdentityVaultRecoveryPhraseMismatchError();
      },
    });

    await expect(
      ensureVaultReady({
        userAgent      : agent,
        emitter,
        password       : 'pass',
        isFirstLaunch  : false,
        recoveryPhrase : 'wrong phrase',
      })
    ).rejects.toBeInstanceOf(RecoveryPhraseMismatchError);

    expect(startCalled).toBe(false);
  });
});

describe('deriveSyncScopeFromGrants', () => {
  /** Build a minimal mock grant object (no DWN parse overhead). */
  function mockGrant(scope: any, dateExpires = '2040-01-01T00:00:00Z'): any {
    return { scope, dateExpires };
  }

  test('returns all for unscoped Messages.Read grant', () => {
    const grants = [mockGrant({ interface: 'Messages', method: 'Read' })];
    expect(deriveSyncScopeFromGrants(grants)).toBe('all');
  });

  test('returns protocol list for scoped Messages.Read grants', () => {
    const grants = [
      mockGrant({ interface: 'Messages', method: 'Read', protocol: 'https://proto.example/a' }),
      mockGrant({ interface: 'Messages', method: 'Read', protocol: 'https://proto.example/b' }),
    ];
    const result = deriveSyncScopeFromGrants(grants);
    expect(result).toEqual(['https://proto.example/a', 'https://proto.example/b']);
  });

  test('ignores narrow Messages.Read grants because protocol-root sync requires root coverage', () => {
    const grants = [
      mockGrant({ interface: 'Messages', method: 'Read', protocol: 'https://proto.example/a', protocolPath: 'post' }),
      mockGrant({ interface: 'Messages', method: 'Read', protocol: 'https://proto.example/b', contextId: 'bafyroot/bafychild' }),
      mockGrant({ interface: 'Messages', method: 'Read', protocol: 'https://proto.example/c' }),
    ];
    expect(deriveSyncScopeFromGrants(grants)).toEqual(['https://proto.example/c']);
  });

  test('deduplicates protocol URIs', () => {
    const grants = [
      mockGrant({ interface: 'Messages', method: 'Read', protocol: 'https://proto.example/a' }),
      mockGrant({ interface: 'Messages', method: 'Read', protocol: 'https://proto.example/a' }),
    ];
    expect(deriveSyncScopeFromGrants(grants)).toEqual(['https://proto.example/a']);
  });

  test('ignores non-Messages grants (Records.Write does not authorize sync)', () => {
    const grants = [
      mockGrant({ interface: 'Records', method: 'Write', protocol: 'https://proto.example/chat' }),
      mockGrant({ interface: 'Protocols', method: 'Query', protocol: 'https://proto.example/chat' }),
    ];
    expect(deriveSyncScopeFromGrants(grants)).toEqual([]);
  });

  test('ignores Messages grants with method !== Read', () => {
    const grants = [
      mockGrant({ interface: 'Messages', method: 'Subscribe', protocol: 'https://proto.example/chat' }),
    ];
    expect(deriveSyncScopeFromGrants(grants)).toEqual([]);
  });

  test('excludes expired Messages.Read grants', () => {
    const grants = [
      mockGrant({ interface: 'Messages', method: 'Read', protocol: 'https://proto.example/a' }, '2020-01-01T00:00:00Z'),
    ];
    expect(deriveSyncScopeFromGrants(grants)).toEqual([]);
  });

  test('includes non-expired and excludes expired grants in the same set', () => {
    const grants = [
      mockGrant({ interface: 'Messages', method: 'Read', protocol: 'https://proto.example/expired' }, '2020-01-01T00:00:00Z'),
      mockGrant({ interface: 'Messages', method: 'Read', protocol: 'https://proto.example/valid' }, '2040-01-01T00:00:00Z'),
    ];
    expect(deriveSyncScopeFromGrants(grants)).toEqual(['https://proto.example/valid']);
  });

  test('returns empty array when no grants are provided', () => {
    expect(deriveSyncScopeFromGrants([])).toEqual([]);
  });

  test('excludes PermissionsProtocol.uri from collected protocols', () => {
    const grants = [
      mockGrant({ interface: 'Messages', method: 'Read', protocol: 'https://identity.foundation/dwn/permissions' }),
    ];
    expect(deriveSyncScopeFromGrants(grants)).toEqual([]);
  });

  test('returns all when wildcard grant appears first among scoped grants', () => {
    const grants = [
      mockGrant({ interface: 'Messages', method: 'Read' }),
      mockGrant({ interface: 'Messages', method: 'Read', protocol: 'https://proto.example/chat' }),
      mockGrant({ interface: 'Messages', method: 'Read', protocol: 'https://proto.example/notes' }),
    ];
    expect(deriveSyncScopeFromGrants(grants)).toBe('all');
  });

  test('returns all when wildcard grant appears last among scoped grants', () => {
    const grants = [
      mockGrant({ interface: 'Messages', method: 'Read', protocol: 'https://proto.example/chat' }),
      mockGrant({ interface: 'Messages', method: 'Read', protocol: 'https://proto.example/notes' }),
      mockGrant({ interface: 'Messages', method: 'Read' }),
    ];
    expect(deriveSyncScopeFromGrants(grants)).toBe('all');
  });

  test('does not return all when the only wildcard grant is expired', () => {
    const grants = [
      mockGrant({ interface: 'Messages', method: 'Read' }, '2020-01-01T00:00:00Z'),
    ];
    expect(deriveSyncScopeFromGrants(grants)).toEqual([]);
  });

  test('ignores unscoped Messages.Subscribe grants (not Messages.Read)', () => {
    const grants = [
      mockGrant({ interface: 'Messages', method: 'Subscribe' }),
    ];
    expect(deriveSyncScopeFromGrants(grants)).toEqual([]);
  });

  test('ignores scoped Messages.Subscribe grants (not Messages.Read)', () => {
    const grants = [
      mockGrant({ interface: 'Messages', method: 'Subscribe', protocol: 'https://proto.example/chat' }),
    ];
    expect(deriveSyncScopeFromGrants(grants)).toEqual([]);
  });

  test('ignores unscoped Messages.Sync-like method grants (only Read authorizes)', () => {
    const grants = [
      // `Sync` is not `Read` — must be ignored even unscoped.
      mockGrant({ interface: 'Messages', method: 'Sync' }),
    ];
    expect(deriveSyncScopeFromGrants(grants)).toEqual([]);
  });

  test('ignores scoped Messages.Sync-like method grants', () => {
    const grants = [
      mockGrant({ interface: 'Messages', method: 'Sync', protocol: 'https://proto.example/chat' }),
    ];
    expect(deriveSyncScopeFromGrants(grants)).toEqual([]);
  });

  test('ignores unscoped Protocols.Query grants', () => {
    const grants = [
      mockGrant({ interface: 'Protocols', method: 'Query' }),
    ];
    expect(deriveSyncScopeFromGrants(grants)).toEqual([]);
  });

  test('ignores unscoped Records.Read grants', () => {
    const grants = [
      mockGrant({ interface: 'Records', method: 'Read' }),
    ];
    expect(deriveSyncScopeFromGrants(grants)).toEqual([]);
  });
});

describe('deriveActiveSyncScope', () => {
  test('returns protocols from active Messages.Read grants', async () => {
    const agent = createMockAgent({
      permissionsFetchGrants: async () => [
        buildGrantEntry('https://proto.example/a', 'g1'),
        buildGrantEntry('https://proto.example/b', 'g2'),
      ],
    });

    const result = await deriveActiveSyncScope(agent as any, 'did:delegate');
    expect(result).toEqual(['https://proto.example/a', 'https://proto.example/b']);
  });

  test('excludes revoked grants', async () => {
    let fetchParams: any;
    const agent = createMockAgent({
      permissionsFetchGrants: async (params: any) => {
        fetchParams = params;
        return [buildGrantEntry('https://proto.example/valid', 'g-valid')];
      },
    });

    const result = await deriveActiveSyncScope(agent as any, 'did:delegate');
    expect(result).toEqual(['https://proto.example/valid']);
    expect(fetchParams).toEqual({
      author       : 'did:delegate',
      target       : 'did:delegate',
      grantee      : 'did:delegate',
      checkRevoked : true,
    });
  });

  test('does not issue an unscoped nested revocation query', async () => {
    const filters: any[] = [];
    const agent = createMockAgent({
      processDwnRequest: async (params: any) => {
        const filter = params?.messageParams?.filter;
        filters.push(filter);
        if (filter?.protocolPath === PermissionsProtocol.revocationPath && filter.contextId === undefined) {
          return { reply: { status: { code: 400, detail: 'nested revocation queries require contextId' } } };
        }
        return { reply: { status: { code: 200, detail: 'OK' }, entries: [] } };
      },
      permissionsFetchGrants: async () => [buildGrantEntry('https://proto.example/a', 'g1')],
    });

    const result = await deriveActiveSyncScope(agent as any, 'did:delegate');
    expect(result).toEqual(['https://proto.example/a']);
    expect(filters.some(filter =>
      filter?.protocolPath === PermissionsProtocol.revocationPath && filter.contextId === undefined
    )).toBe(false);
    expect(filters).toHaveLength(0);
  });

  test('throws when grant fetching fails', async () => {
    const agent = createMockAgent({
      permissionsFetchGrants: async () => { throw new Error('Internal Error'); },
    });

    await expect(deriveActiveSyncScope(agent as any, 'did:delegate')).rejects.toThrow('Internal Error');
  });

  test('throws when the grant query fails', async () => {
    const agent = createMockAgent({
      permissionsFetchGrants: async () => { throw new Error('Error'); },
    });

    await expect(deriveActiveSyncScope(agent as any, 'did:delegate')).rejects.toThrow('Error');
  });

  test('returns all for unscoped Messages.Read grant', async () => {
    const agent = createMockAgent({
      permissionsFetchGrants: async () => [buildUnscopedGrantEntry('g-unscoped')],
    });

    const result = await deriveActiveSyncScope(agent as any, 'did:delegate');
    expect(result).toBe('all');
  });

  test('excludes revoked wildcard grant', async () => {
    const agent = createMockAgent({
      permissionsFetchGrants: async () => [],
    });

    const result = await deriveActiveSyncScope(agent as any, 'did:delegate');
    expect(result).toEqual([]);
  });

  test('excludes expired wildcard grant', async () => {
    const agent = createMockAgent({
      permissionsFetchGrants: async () => [buildUnscopedGrantEntry('g-expired', 'Messages', 'Read', '2020-01-01T00:00:00Z')],
    });

    const result = await deriveActiveSyncScope(agent as any, 'did:delegate');
    expect(result).toEqual([]);
  });

  test('wildcard wins when mixed with scoped grants', async () => {
    const agent = createMockAgent({
      permissionsFetchGrants: async () => [
        buildGrantEntry('https://proto.example/chat', 'g-scoped'),
        buildUnscopedGrantEntry('g-unscoped'),
      ],
    });

    const result = await deriveActiveSyncScope(agent as any, 'did:delegate');
    expect(result).toBe('all');
  });
});

describe('processConnectedGrants', () => {
  describe('grant rollback on delegate partition write failure', () => {
    test('rolls back succeeded grants when one delegate partition write fails', async () => {
      const deleteCalls: string[] = [];
      let callCount = 0;

      const agent = createMockAgent({
        processDwnRequest: async (params: any): Promise<any> => {
          if (params.messageType === 'RecordsWrite') {
            callCount++;
            // First grant succeeds, second fails.
            if (callCount === 2) {
              return { reply: { status: { code: 500, detail: 'Internal error' } } };
            }
            return { reply: { status: { code: 202, detail: 'Accepted' } } };
          }
          if (params.messageType === 'RecordsDelete') {
            deleteCalls.push(params.messageParams.recordId);
            return { reply: { status: { code: 202, detail: 'Accepted' } } };
          }
          return { reply: { status: { code: 202, detail: 'Accepted' } } };
        },
      });

      const grants = [
        buildGrantMessage('https://proto.a', 'grant-a'),
        buildGrantMessage('https://proto.b', 'grant-b'),
      ];

      await expect(
        processConnectedGrants({
          agent,
          connectedDid : 'did:dht:connected',
          delegateDid  : 'did:jwk:delegate',
          grants,
        })
      ).rejects.toThrow('Failed to store grant in delegate partition');

      // The first (succeeded) grant should have been rolled back.
      expect(deleteCalls).toContain('grant-a');
    });
  });
});

describe('importDelegateAndSetupSync', () => {
  describe('sync registration with zero granted protocols', () => {
    test('unregisters sync when no protocols are granted', async () => {
      const syncCalls: any[] = [];
      const unregisterCalls: string[] = [];

      const identity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate1' },
        metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected1' },
      });

      const agent = createMockAgent({
        identityImport         : async () => identity,
        syncRegisterIdentity   : async (params) => { syncCalls.push(params); },
        syncUnregisterIdentity : async (did) => { unregisterCalls.push(did); },
        dwnProcessRawMessage   : async () => ({ status: { code: 202, detail: 'Accepted' } }),
      });

      // Empty grants → processConnectedGrants returns [] → unregister stale registration.
      const result = await importDelegateAndSetupSync({
        userAgent           : agent,
        delegatePortableDid : { uri: 'did:jwk:delegate1', document: {} as any, metadata: {} },
        connectedDid        : 'did:dht:connected1',
        delegateGrants      : [],
        flowName            : 'test',
      });

      expect(result).toBeDefined();
      expect(syncCalls).toHaveLength(0);
      expect(unregisterCalls).toHaveLength(1);
      expect(unregisterCalls[0]).toBe('did:dht:connected1');
    });

    test('tolerates unregister when identity was never registered', async () => {
      const identity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate1' },
        metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected1' },
      });

      const agent = createMockAgent({
        identityImport         : async () => identity,
        syncUnregisterIdentity : async () => { throw new Error('is not registered'); },
        dwnProcessRawMessage   : async () => ({ status: { code: 202, detail: 'Accepted' } }),
      });

      // Should not throw — unregister failure is silently ignored.
      const result = await importDelegateAndSetupSync({
        userAgent           : agent,
        delegatePortableDid : { uri: 'did:jwk:delegate1', document: {} as any, metadata: {} },
        connectedDid        : 'did:dht:connected1',
        delegateGrants      : [],
        flowName            : 'test',
      });

      expect(result).toBeDefined();
    });

    test('rethrows I/O errors from unregisterIdentity', async () => {
      const identity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate1' },
        metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected1' },
      });

      const agent = createMockAgent({
        identityImport         : async () => identity,
        syncUnregisterIdentity : async () => { throw new Error('LEVEL_IO_ERROR'); },
        dwnProcessRawMessage   : async () => ({ status: { code: 202, detail: 'Accepted' } }),
      });

      await expect(
        importDelegateAndSetupSync({
          userAgent           : agent,
          delegatePortableDid : { uri: 'did:jwk:delegate1', document: {} as any, metadata: {} },
          connectedDid        : 'did:dht:connected1',
          delegateGrants      : [],
          flowName            : 'test',
        })
      ).rejects.toThrow('LEVEL_IO_ERROR');
    });

    test('registers with protocols: all for unscoped grant', async () => {
      const syncCalls: any[] = [];

      const identity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate1' },
        metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected1' },
      });

      const agent = createMockAgent({
        identityImport       : async () => identity,
        syncRegisterIdentity : async (params) => { syncCalls.push(params); },
        dwnProcessRawMessage : async () => ({ status: { code: 202, detail: 'Accepted' } }),
      });

      const grants = [buildUnscopedGrantMessage('grant-unrestricted')];

      const result = await importDelegateAndSetupSync({
        userAgent           : agent,
        delegatePortableDid : { uri: 'did:jwk:delegate1', document: {} as any, metadata: {} },
        connectedDid        : 'did:dht:connected1',
        delegateGrants      : grants,
        flowName            : 'test',
      });

      expect(result).toBeDefined();
      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0].options.protocols).toBe('all');
    });

    test('does not treat unscoped non-Messages grant as all', async () => {
      const syncCalls: any[] = [];
      const unregisterCalls: string[] = [];

      const identity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate1' },
        metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected1' },
      });

      const agent = createMockAgent({
        identityImport         : async () => identity,
        syncRegisterIdentity   : async (params) => { syncCalls.push(params); },
        syncUnregisterIdentity : async (did) => { unregisterCalls.push(did); },
        dwnProcessRawMessage   : async () => ({ status: { code: 202, detail: 'Accepted' } }),
      });

      // A Protocols.Query grant has no protocol but is NOT a Messages grant.
      const grants = [buildUnscopedGrantMessage('grant-proto-query', 'Protocols', 'Query')];

      const result = await importDelegateAndSetupSync({
        userAgent           : agent,
        delegatePortableDid : { uri: 'did:jwk:delegate1', document: {} as any, metadata: {} },
        connectedDid        : 'did:dht:connected1',
        delegateGrants      : grants,
        flowName            : 'test',
      });

      expect(result).toBeDefined();
      // Should NOT register with 'all' — Protocols.Query grant does not authorize sync.
      expect(syncCalls).toHaveLength(0);
      // Should trigger unregister since no sync-relevant protocols were found.
      expect(unregisterCalls).toHaveLength(1);
    });

    test('registers sync when protocols are granted', async () => {
      const syncCalls: any[] = [];

      const identity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate1' },
        metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected1' },
      });

      const agent = createMockAgent({
        identityImport       : async () => identity,
        syncRegisterIdentity : async (params) => { syncCalls.push(params); },
        dwnProcessRawMessage : async () => ({ status: { code: 202, detail: 'Accepted' } }),
      });

      const grants = [buildGrantMessage('https://proto.example/chat', 'grant-chat')];

      const result = await importDelegateAndSetupSync({
        userAgent           : agent,
        delegatePortableDid : { uri: 'did:jwk:delegate1', document: {} as any, metadata: {} },
        connectedDid        : 'did:dht:connected1',
        delegateGrants      : grants,
        flowName            : 'test',
      });

      expect(result).toBeDefined();
      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0].options.protocols).toContain('https://proto.example/chat');
    });

    test('falls back to updateIdentityOptions when already registered', async () => {
      const updateCalls: any[] = [];

      const identity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate1' },
        metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected1' },
      });

      const agent = createMockAgent({
        identityImport            : async () => identity,
        syncRegisterIdentity      : async () => { throw new Error('already registered'); },
        syncUpdateIdentityOptions : async (params) => { updateCalls.push(params); },
        dwnProcessRawMessage      : async () => ({ status: { code: 202, detail: 'Accepted' } }),
      });

      const grants = [buildGrantMessage('https://proto.example/chat', 'grant-chat')];

      const result = await importDelegateAndSetupSync({
        userAgent           : agent,
        delegatePortableDid : { uri: 'did:jwk:delegate1', document: {} as any, metadata: {} },
        connectedDid        : 'did:dht:connected1',
        delegateGrants      : grants,
        flowName            : 'test',
      });

      expect(result).toBeDefined();
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].options.protocols).toContain('https://proto.example/chat');
    });

    test('rethrows non-registration errors from sync registerIdentity', async () => {
      const identity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate1' },
        metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected1' },
      });

      const agent = createMockAgent({
        identityImport       : async () => identity,
        syncRegisterIdentity : async () => { throw new Error('database unavailable'); },
        dwnProcessRawMessage : async () => ({ status: { code: 202, detail: 'Accepted' } }),
      });

      const grants = [buildGrantMessage('https://proto.example/chat', 'grant-chat')];

      await expect(
        importDelegateAndSetupSync({
          userAgent           : agent,
          delegatePortableDid : { uri: 'did:jwk:delegate1', document: {} as any, metadata: {} },
          connectedDid        : 'did:dht:connected1',
          delegateGrants      : grants,
          flowName            : 'test',
        })
      ).rejects.toThrow('database unavailable');
    });

    test('registers with all when any grant is unscoped even with other scoped grants', async () => {
      const syncCalls: any[] = [];

      const identity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate1' },
        metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected1' },
      });

      const agent = createMockAgent({
        identityImport       : async () => identity,
        syncRegisterIdentity : async (params) => { syncCalls.push(params); },
        dwnProcessRawMessage : async () => ({ status: { code: 202, detail: 'Accepted' } }),
      });

      const grants = [
        buildGrantMessage('https://proto.example/chat', 'grant-chat'),
        buildUnscopedGrantMessage('grant-unrestricted'),
        buildGrantMessage('https://proto.example/notes', 'grant-notes'),
      ];

      await importDelegateAndSetupSync({
        userAgent           : agent,
        delegatePortableDid : { uri: 'did:jwk:delegate1', document: {} as any, metadata: {} },
        connectedDid        : 'did:dht:connected1',
        delegateGrants      : grants,
        flowName            : 'test',
      });

      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0].options.protocols).toBe('all');
    });

    test('ignores unscoped Messages.Subscribe grant (only Messages.Read authorizes sync)', async () => {
      const syncCalls: any[] = [];
      const unregisterCalls: string[] = [];

      const identity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate1' },
        metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected1' },
      });

      const agent = createMockAgent({
        identityImport         : async () => identity,
        syncRegisterIdentity   : async (params) => { syncCalls.push(params); },
        syncUnregisterIdentity : async (did) => { unregisterCalls.push(did); },
        dwnProcessRawMessage   : async () => ({ status: { code: 202, detail: 'Accepted' } }),
      });

      const grants = [buildUnscopedGrantMessage('grant-subscribe', 'Messages', 'Subscribe')];

      await importDelegateAndSetupSync({
        userAgent           : agent,
        delegatePortableDid : { uri: 'did:jwk:delegate1', document: {} as any, metadata: {} },
        connectedDid        : 'did:dht:connected1',
        delegateGrants      : grants,
        flowName            : 'test',
      });

      // Should NOT register with 'all' — Messages.Subscribe does not authorize sync.
      expect(syncCalls).toHaveLength(0);
      // Should unregister since no sync-relevant protocols were found.
      expect(unregisterCalls).toHaveLength(1);
    });
  });
});

describe('toSyncIdentityProtocols', () => {
  test('passes through the `all` literal unchanged', () => {
    expect(toSyncIdentityProtocols('all')).toBe('all');
  });

  test('returns undefined for an empty array (caller should unregister)', () => {
    expect(toSyncIdentityProtocols([])).toBeUndefined();
  });

  test('returns the array for a single-element scope', () => {
    expect(toSyncIdentityProtocols(['https://proto.example/a'])).toEqual(['https://proto.example/a']);
  });

  test('returns the array for multi-element scopes', () => {
    expect(toSyncIdentityProtocols(['https://proto.example/a', 'https://proto.example/b']))
      .toEqual(['https://proto.example/a', 'https://proto.example/b']);
  });
});

describe('registerSyncScopeForIdentity', () => {
  test('delegate with scoped grants: calls registerIdentity with the right protocols', async () => {
    const syncCalls: any[] = [];
    const agent = createMockAgent({
      processDwnRequest: async (params: any) => {
        const filter = params?.messageParams?.filter;
        if (filter?.protocolPath === 'grant') {
          return { reply: { status  : { code: 200, detail: 'OK' }, entries : [
            buildGrantMessage('https://proto.example/chat', 'g1'),
            buildGrantMessage('https://proto.example/notes', 'g2'),
          ] } };
        }
        return { reply: { status: { code: 200, detail: 'OK' }, entries: [] } };
      },
      syncRegisterIdentity: async (params) => { syncCalls.push(params); },
    });

    await registerSyncScopeForIdentity({
      userAgent    : agent,
      connectedDid : 'did:dht:connected1',
      delegateDid  : 'did:jwk:delegate1',
    });

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].did).toBe('did:dht:connected1');
    expect(syncCalls[0].options.delegateDid).toBe('did:jwk:delegate1');
    expect(syncCalls[0].options.protocols).toEqual(['https://proto.example/chat', 'https://proto.example/notes']);
  });

  test('delegate with unscoped Messages.Read grant: calls registerIdentity with protocols: all', async () => {
    const syncCalls: any[] = [];
    const agent = createMockAgent({
      processDwnRequest: async (params: any) => {
        const filter = params?.messageParams?.filter;
        if (filter?.protocolPath === 'grant') {
          return { reply: { status  : { code: 200, detail: 'OK' }, entries : [
            buildUnscopedGrantMessage('g-unscoped'),
          ] } };
        }
        return { reply: { status: { code: 200, detail: 'OK' }, entries: [] } };
      },
      syncRegisterIdentity: async (params) => { syncCalls.push(params); },
    });

    await registerSyncScopeForIdentity({
      userAgent    : agent,
      connectedDid : 'did:dht:connected1',
      delegateDid  : 'did:jwk:delegate1',
    });

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].options.delegateDid).toBe('did:jwk:delegate1');
    expect(syncCalls[0].options.protocols).toBe('all');
  });

  test('delegate with zero grants: calls unregisterIdentity and tolerates "is not registered"', async () => {
    const unregisterCalls: string[] = [];
    const agent = createMockAgent({
      processDwnRequest: async (params: any) => {
        const filter = params?.messageParams?.filter;
        if (filter?.protocolPath === 'grant') {
          return { reply: { status: { code: 200, detail: 'OK' }, entries: [] } };
        }
        return { reply: { status: { code: 200, detail: 'OK' }, entries: [] } };
      },
      syncUnregisterIdentity: async (did: string) => {
        unregisterCalls.push(did);
        throw new Error('identity is not registered');
      },
    });

    // Should not throw — unregister failure with "is not registered" is tolerated.
    await registerSyncScopeForIdentity({
      userAgent    : agent,
      connectedDid : 'did:dht:connected1',
      delegateDid  : 'did:jwk:delegate1',
    });

    expect(unregisterCalls).toEqual(['did:dht:connected1']);
  });

  test('delegate with zero grants: rethrows non-"not registered" errors from unregister', async () => {
    const agent = createMockAgent({
      processDwnRequest: async (params: any) => {
        const filter = params?.messageParams?.filter;
        if (filter?.protocolPath === 'grant') {
          return { reply: { status: { code: 200, detail: 'OK' }, entries: [] } };
        }
        return { reply: { status: { code: 200, detail: 'OK' }, entries: [] } };
      },
      syncUnregisterIdentity: async () => { throw new Error('LEVEL_IO_ERROR'); },
    });

    await expect(
      registerSyncScopeForIdentity({
        userAgent    : agent,
        connectedDid : 'did:dht:connected1',
        delegateDid  : 'did:jwk:delegate1',
      })
    ).rejects.toThrow('LEVEL_IO_ERROR');
  });

  test('delegate already-registered: falls back to updateIdentityOptions', async () => {
    const updateCalls: any[] = [];
    const agent = createMockAgent({
      processDwnRequest: async (params: any) => {
        const filter = params?.messageParams?.filter;
        if (filter?.protocolPath === 'grant') {
          return { reply: { status  : { code: 200, detail: 'OK' }, entries : [
            buildGrantMessage('https://proto.example/chat', 'g1'),
          ] } };
        }
        return { reply: { status: { code: 200, detail: 'OK' }, entries: [] } };
      },
      syncRegisterIdentity      : async () => { throw new Error('already registered'); },
      syncUpdateIdentityOptions : async (params) => { updateCalls.push(params); },
    });

    await registerSyncScopeForIdentity({
      userAgent    : agent,
      connectedDid : 'did:dht:connected1',
      delegateDid  : 'did:jwk:delegate1',
    });

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].did).toBe('did:dht:connected1');
    expect(updateCalls[0].options.delegateDid).toBe('did:jwk:delegate1');
    expect(updateCalls[0].options.protocols).toContain('https://proto.example/chat');
  });

  test('delegate: rethrows non-"already registered" errors from registerIdentity', async () => {
    const agent = createMockAgent({
      processDwnRequest: async (params: any) => {
        const filter = params?.messageParams?.filter;
        if (filter?.protocolPath === 'grant') {
          return { reply: { status  : { code: 200, detail: 'OK' }, entries : [
            buildGrantMessage('https://proto.example/chat', 'g1'),
          ] } };
        }
        return { reply: { status: { code: 200, detail: 'OK' }, entries: [] } };
      },
      syncRegisterIdentity: async () => { throw new Error('database unavailable'); },
    });

    await expect(
      registerSyncScopeForIdentity({
        userAgent    : agent,
        connectedDid : 'did:dht:connected1',
        delegateDid  : 'did:jwk:delegate1',
      })
    ).rejects.toThrow('database unavailable');
  });

  test('local with explicit protocols: calls registerIdentity with that scope', async () => {
    const syncCalls: any[] = [];
    const agent = createMockAgent({
      syncRegisterIdentity: async (params) => { syncCalls.push(params); },
    });

    await registerSyncScopeForIdentity({
      userAgent             : agent,
      connectedDid          : 'did:dht:connected1',
      identitySyncProtocols : ['https://proto.example/profile'],
    });

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].did).toBe('did:dht:connected1');
    expect(syncCalls[0].options.protocols).toEqual(['https://proto.example/profile']);
    // Local session — delegateDid should not be present in the options payload.
    expect(syncCalls[0].options.delegateDid).toBeUndefined();
  });

  test('local without explicit protocols: leaves sync registration to the application', async () => {
    const registerCalls: any[] = [];
    const unregisterCalls: string[] = [];
    const agent = createMockAgent({
      syncRegisterIdentity   : async (params) => { registerCalls.push(params); },
      syncUnregisterIdentity : async (did) => { unregisterCalls.push(did); },
    });

    await registerSyncScopeForIdentity({
      userAgent    : agent,
      connectedDid : 'did:dht:connected1',
    });

    expect(registerCalls).toHaveLength(0);
    expect(unregisterCalls).toHaveLength(0);
  });

  test('local already-registered: falls back to updateIdentityOptions', async () => {
    const updateCalls: any[] = [];
    const agent = createMockAgent({
      syncRegisterIdentity      : async () => { throw new Error('already registered') ; },
      syncUpdateIdentityOptions : async (params) => { updateCalls.push(params); },
    });

    await registerSyncScopeForIdentity({
      userAgent             : agent,
      connectedDid          : 'did:dht:connected1',
      identitySyncProtocols : ['https://proto.example/profile'],
    });

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].did).toBe('did:dht:connected1');
    expect(updateCalls[0].options.protocols).toEqual(['https://proto.example/profile']);
  });

  test('local: rethrows non-"already registered" errors from registerIdentity', async () => {
    const agent = createMockAgent({
      syncRegisterIdentity: async () => { throw new Error('database unavailable'); },
    });

    await expect(
      registerSyncScopeForIdentity({
        userAgent             : agent,
        connectedDid          : 'did:dht:connected1',
        identitySyncProtocols : ['https://proto.example/profile'],
      })
    ).rejects.toThrow('database unavailable');
  });
});

describe('finalizeDelegateSession', () => {
  describe('stale state cleanup on reconnect', () => {
    test('clears old context keys and multi-party protocols when absent on reconnect', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      const agent = createMockAgent();

      // Simulate a prior session that stored context keys and multi-party protocols.
      await agent.secrets.put(
        STORAGE_KEYS.DELEGATE_CONTEXT_KEYS,
        new TextEncoder().encode(JSON.stringify([{ contextId: 'old-ctx' }])),
      );
      await storage.set(STORAGE_KEYS.DELEGATE_MULTI_PARTY_PROTOCOLS, JSON.stringify(['old-proto']));

      const identity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate2' },
        metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected1' },
      });

      await finalizeDelegateSession({
        userAgent    : agent,
        emitter,
        storage,
        identity     : identity as any,
        connectedDid : 'did:dht:connected1',
        delegateDid  : 'did:jwk:delegate2',
        sync         : '15s',
      });

      const ctxKeys = await agent.secrets.get(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS);
      expect(ctxKeys).toBeUndefined();
      const mpProtos = await storage.get(STORAGE_KEYS.DELEGATE_MULTI_PARTY_PROTOCOLS);
      expect(mpProtos).toBeNull();
    });

    test('clears old session revocations when absent on reconnect', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      const agent = createMockAgent();

      // Simulate a prior session that stored revocations.
      await storage.set(STORAGE_KEYS.SESSION_REVOCATIONS, JSON.stringify([
        { grantId: 'old-grant', revocationGrantId: 'old-revocation' },
      ]));

      const identity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate2' },
        metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected1' },
      });
      // No _sessionRevocations set on identity.

      await finalizeDelegateSession({
        userAgent    : agent,
        emitter,
        storage,
        identity     : identity as any,
        connectedDid : 'did:dht:connected1',
        delegateDid  : 'did:jwk:delegate2',
        sync         : '15s',
      });

      const revocations = await storage.get(STORAGE_KEYS.SESSION_REVOCATIONS);
      expect(revocations).toBeNull();
    });

    test('persists session revocations when present on reconnect', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      const agent = createMockAgent();
      const sessionRevocations = [
        { grantId: 'grant-1', revocationGrantId: 'revocation-1' },
      ];

      const identity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate2' },
        metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected1' },
      });

      await finalizeDelegateSession({
        userAgent     : agent,
        emitter,
        storage,
        identity      : identity as any,
        connectedDid  : 'did:dht:connected1',
        delegateDid   : 'did:jwk:delegate2',
        sync          : '15s',
        delegateState : { sessionRevocations },
      });

      const revocations = await storage.get(STORAGE_KEYS.SESSION_REVOCATIONS);
      expect(revocations).toBe(JSON.stringify(sessionRevocations));
    });
  });

});
