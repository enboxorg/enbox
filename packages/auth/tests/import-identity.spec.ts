import { describe, expect, test } from 'bun:test';
import { DwnEndpointResolutionError, DwnEndpointResolutionErrorCode } from '@enbox/dids';

import { AuthEventEmitter } from '../src/events.js';
import { createFlowContext } from './helpers/flow-context.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { importFromPortable as runImportFromPortable } from '../src/connect/import.js';
import { STORAGE_KEYS } from '../src/types.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';

function importFromPortable(
  context: Parameters<typeof createFlowContext>[0],
  options: Parameters<typeof runImportFromPortable>[1],
): ReturnType<typeof runImportFromPortable> {
  return runImportFromPortable(createFlowContext(context), options);
}

function createPortableIdentity({
  uri = 'did:dht:testuser123',
  connectedDid,
}: {
  uri?: string;
  connectedDid?: string;
} = {}): any {
  return {
    portableDid: {
      uri,
      document: {
        id      : uri,
        service : [{
          id              : `${uri}#dwn`,
          type            : 'DecentralizedWebNode',
          serviceEndpoint : ['https://stale-portable.example'],
        }],
      },
      metadata: {},
    },
    metadata: {
      uri,
      name   : 'Portable',
      tenant : 'did:dht:testagent',
      connectedDid,
    },
  };
}

describe('importFromPortable', () => {
  test('fresh-resolves the connected DID even without tenant registration', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const refreshedDids: string[] = [];
    const agent = createMockAgent({
      identityImport: async (params) => {
        const didUri = params.portableIdentity.portableDid.uri;
        const resolution = await agent.did.refreshResolution(didUri);
        return createMockIdentity({
          did: { uri: didUri, document: resolution.didDocument },
        });
      },
      didRefreshResolution: async (didUri) => {
        refreshedDids.push(didUri);
        return {
          didDocument: {
            id      : didUri,
            service : [{
              id              : `${didUri}#dwn`,
              type            : 'DecentralizedWebNode',
              serviceEndpoint : ['https://current.example/dwn'],
            }],
          },
          didDocumentMetadata   : {},
          didResolutionMetadata : {},
        };
      },
    });

    await importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: 'off' },
      { portableIdentity: createPortableIdentity({ uri: 'did:dht:portable-snapshot' }) },
    );

    expect(refreshedDids).toEqual(['did:dht:portable-snapshot']);
  });

  test('allows a local-only imported identity with no advertised DWN service', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const didUri = 'did:dht:local-only';
    const agent = createMockAgent({
      identityImport: async () => {
        const resolution = await agent.did.refreshResolution(didUri);
        return createMockIdentity({ did: { uri: didUri, document: resolution.didDocument } });
      },
      didRefreshResolution: async () => ({
        didDocument           : { id: didUri },
        didDocumentMetadata   : {},
        didResolutionMetadata : {},
      }),
    });

    const session = await importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: 'off' },
      { portableIdentity: createPortableIdentity({ uri: didUri }) },
    );

    expect(session.did).toBe(didUri);
  });

  test('does not import keys or identity metadata when authoritative resolution fails', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    let importCalls = 0;
    const agent = createMockAgent({
      identityImport: async () => {
        try {
          await agent.did.refreshResolution('did:dht:testuser123');
        } catch (cause: unknown) {
          throw new DwnEndpointResolutionError({
            code    : DwnEndpointResolutionErrorCode.DidResolutionFailed,
            didUri  : 'did:dht:testuser123',
            message : 'Unable to resolve authoritative DID before import.',
            cause,
          });
        }
        importCalls++;
        return createMockIdentity();
      },
      didRefreshResolution: async () => {
        throw new Error('resolver offline');
      },
    });

    await expect(importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: 'off' },
      { portableIdentity: createPortableIdentity() },
    )).rejects.toHaveProperty('code', DwnEndpointResolutionErrorCode.DidResolutionFailed);

    expect(importCalls).toBe(0);
  });

  test('fails closed when the agent cannot guarantee authoritative atomic import', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    let importCalls = 0;
    const agent = createMockAgent({
      identitySupportsAuthoritativeDidImport : false,
      identityImport                         : async () => {
        importCalls++;
        return createMockIdentity();
      },
    });

    await expect(importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: 'off' },
      { portableIdentity: createPortableIdentity() },
    )).rejects.toThrow('authoritative DID import support');

    expect(importCalls).toBe(0);
  });

  test('imports identity and creates session', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const importCalls: any[] = [];
    const identity = createMockIdentity();

    const agent = createMockAgent({
      identityImport: async (params) => { importCalls.push(params); return identity; },
    });

    const context = createFlowContext({ userAgent: agent, emitter, storage });
    const session = await runImportFromPortable(
      context,
      { portableIdentity: createPortableIdentity() },
    );

    expect(importCalls).toHaveLength(1);
    expect(importCalls[0].portableIdentity.portableDid.document.service[0].serviceEndpoint)
      .toEqual(['https://stale-portable.example']);
    expect(session.did).toBe('did:dht:testuser123');
    expect(session.signal).toBe(context.sessionSignal);
  });

  test('handles wallet-connected portable identity', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();

    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate' },
      metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
    });

    const agent = createMockAgent({
      identityImport: async () => identity,
    });

    const session = await importFromPortable(
      { userAgent: agent, emitter, storage },
      {
        portableIdentity: createPortableIdentity({
          uri          : 'did:dht:delegate',
          connectedDid : 'did:dht:external',
        }),
      },
    );

    expect(session.did).toBe('did:dht:external');
    expect(session.delegateDid).toBe('did:dht:delegate');
  });

  test('resolves the owner once and leaves the delegate resolution to authoritative import', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const refreshedDids: string[] = [];
    const agent = createMockAgent({
      didRefreshResolution: async (didUri) => {
        refreshedDids.push(didUri);
        return {
          didDocument: {
            id      : didUri,
            service : [{
              id              : `${didUri}#dwn`,
              type            : 'DecentralizedWebNode',
              serviceEndpoint : ['https://current.example/dwn'],
            }],
          },
          didDocumentMetadata   : {},
          didResolutionMetadata : {},
        };
      },
      identityImport: async (params) => {
        const delegateDid = params.portableIdentity.portableDid.uri;
        const resolution = await agent.did.refreshResolution(delegateDid);
        return createMockIdentity({
          did      : { uri: delegateDid, document: resolution.didDocument },
          metadata : {
            name         : 'Wallet',
            tenant       : 'did:dht:testagent',
            connectedDid : 'did:dht:owner',
          },
        });
      },
    });

    await importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: 'off' },
      {
        portableIdentity: createPortableIdentity({
          uri          : 'did:jwk:delegate',
          connectedDid : 'did:dht:owner',
        }),
      },
    );

    expect(refreshedDids).toEqual(['did:dht:owner', 'did:jwk:delegate']);
  });

  test('registers explicit local identity sync scope and starts sync when enabled', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncRegCalls: any[] = [];
    const syncStartCalls: any[] = [];

    const agent = createMockAgent({
      identityImport       : async () => createMockIdentity(),
      syncRegisterIdentity : async (params) => { syncRegCalls.push(params); },
      syncStartSync        : async (params) => { syncStartCalls.push(params); },
    });

    await importFromPortable(
      {
        userAgent                    : agent,
        emitter,
        storage,
        defaultSync                  : '30s',
        defaultIdentitySyncProtocols : ['https://proto.example/profile'],
      },
      { portableIdentity: createPortableIdentity() },
    );

    expect(syncRegCalls).toHaveLength(1);
    expect(syncRegCalls[0].options.protocols).toEqual(['https://proto.example/profile']);
    expect(syncStartCalls).toHaveLength(1);
    expect(syncStartCalls[0].interval).toBe('30s');
  });

  test('leaves local sync registration to the application when no identity scope is provided', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const unregisterCalls: string[] = [];
    const syncStartCalls: any[] = [];

    const agent = createMockAgent({
      identityImport         : async () => createMockIdentity(),
      syncUnregisterIdentity : async (did) => { unregisterCalls.push(did); },
      syncStartSync          : async (params) => { syncStartCalls.push(params); },
    });

    await importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: '30s' },
      { portableIdentity: createPortableIdentity() },
    );

    expect(unregisterCalls).toHaveLength(0);
    expect(syncStartCalls).toHaveLength(1);
  });

  test('skips sync when disabled', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncCalls: any[] = [];

    const agent = createMockAgent({
      identityImport       : async () => createMockIdentity(),
      syncRegisterIdentity : async (params) => { syncCalls.push(params); },
    });

    await importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: 'off' },
      { portableIdentity: createPortableIdentity() },
    );

    expect(syncCalls).toHaveLength(0);
  });

  test('derives scoped sync from grants for delegate portable import', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncRegCalls: any[] = [];

    const delegateIdentity = createMockIdentity({
      did      : { uri: 'did:jwk:delegate' },
      metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner' },
    });

    const grantData = JSON.stringify({
      dateExpires : '2040-01-01T00:00:00Z',
      scope       : { interface: 'Messages', method: 'Read', protocol: 'https://proto.example/chat' },
      delegated   : true,
    });
    const encoded = btoa(grantData).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const agent = createMockAgent({
      identityImport       : async () => delegateIdentity,
      syncRegisterIdentity : async (params) => { syncRegCalls.push(params); },
      processDwnRequest    : async (params: any) => {
        const filter = params?.messageParams?.filter;
        if (filter?.protocolPath === 'grant') {
          return { reply: { status  : { code: 200, detail: 'OK' }, entries : [{
            recordId      : 'g1',
            contextId     : 'g1',
            encodedData   : encoded,
            descriptor    : { interface: 'Records', method: 'Write', protocol: 'https://identity.foundation/dwn/permissions', protocolPath: 'grant', recipient: 'did:jwk:delegate', dateCreated: '2025-01-01T00:00:00Z', dataFormat: 'application/json', dataCid: 'bafytest', dataSize: 100 },
            authorization : { signature: { signatures: [{ protected: btoa(JSON.stringify({ kid: 'did:dht:owner#sig' })) }] } },
          }] } };
        }
        // Revocations: none.
        return { reply: { status: { code: 200, detail: 'OK' }, entries: [] } };
      },
    });

    await importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: '30s' },
      {
        portableIdentity: createPortableIdentity({
          uri          : 'did:jwk:delegate',
          connectedDid : 'did:dht:owner',
        }),
      },
    );

    expect(syncRegCalls).toHaveLength(1);
    // Should register with the scoped protocol, NOT 'all'.
    expect(syncRegCalls[0].options.protocols).toEqual(['https://proto.example/chat']);
    expect(syncRegCalls[0].options.delegateDid).toBe('did:jwk:delegate');
  });

  test('persists session info', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();

    const agent = createMockAgent({
      identityImport: async () => createMockIdentity(),
    });

    await importFromPortable(
      { userAgent: agent, emitter, storage },
      { portableIdentity: createPortableIdentity() },
    );

    expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBe('true');
    expect(await storage.get(STORAGE_KEYS.ACTIVE_IDENTITY)).toBe('did:dht:testuser123');
  });

  test('emits identity-added while session publication remains manager-owned', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const events: string[] = [];

    emitter.on('identity-added', () => { events.push('identity-added'); });
    emitter.on('session-start', () => { events.push('session-start'); });

    const agent = createMockAgent({
      identityImport: async () => createMockIdentity(),
    });

    await importFromPortable(
      { userAgent: agent, emitter, storage },
      { portableIdentity: createPortableIdentity() },
    );

    expect(events).toEqual(['identity-added']);
  });

  test('calls registration when registration options are provided', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();

    let registrationSucceeded = false;
    const agent = createMockAgent({
      identityImport   : async () => createMockIdentity(),
      rpcGetServerInfo : async () => ({
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
      }),
    });

    await importFromPortable(
      {
        userAgent    : agent,
        emitter,
        storage,
        registration : {
          onSuccess : () => { registrationSucceeded = true; },
          onFailure : () => {},
        },
      },
      { portableIdentity: createPortableIdentity() },
    );

    expect(registrationSucceeded).toBe(true);
  });

  test('removes the imported DID and identity when tenant registration fails', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const didDeletes: string[] = [];
    const identityDeletes: string[] = [];
    const rollbackOrder: string[] = [];
    const agent = createMockAgent({
      identityImport   : async () => createMockIdentity(),
      didDelete        : async ({ didUri }) => { rollbackOrder.push('did'); didDeletes.push(didUri); },
      identityDelete   : async ({ didUri }) => { rollbackOrder.push('identity'); identityDeletes.push(didUri); },
      rpcGetServerInfo : async () => { throw new Error('registration unavailable'); },
    });

    await expect(importFromPortable(
      {
        userAgent    : agent,
        emitter,
        storage,
        registration : {
          onSuccess : () => {},
          onFailure : () => {},
        },
      },
      { portableIdentity: createPortableIdentity() },
    )).rejects.toThrow('registration unavailable');

    expect(didDeletes).toEqual(['did:dht:testuser123']);
    expect(identityDeletes).toEqual(['did:dht:testuser123']);
    expect(rollbackOrder).toEqual(['identity', 'did']);
  });

  test('removes the imported DID and identity when session setup fails', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const didDeletes: string[] = [];
    const identityDeletes: string[] = [];
    const agent = createMockAgent({
      identityImport : async () => createMockIdentity(),
      didDelete      : async ({ didUri }) => { didDeletes.push(didUri); },
      identityDelete : async ({ didUri }) => { identityDeletes.push(didUri); },
      syncStartSync  : async () => { throw new Error('sync unavailable'); },
    });

    await expect(importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: '30s' },
      { portableIdentity: createPortableIdentity() },
    )).rejects.toThrow('sync unavailable');

    expect(didDeletes).toEqual(['did:dht:testuser123']);
    expect(identityDeletes).toEqual(['did:dht:testuser123']);
  });

  test('retains the DID and surfaces both failures when identity metadata rollback fails', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    let didDeleteCalls = 0;
    const agent = createMockAgent({
      identityImport : async () => createMockIdentity(),
      identityDelete : async () => { throw new Error('identity metadata unavailable'); },
      didDelete      : async () => { didDeleteCalls++; },
      syncStartSync  : async () => { throw new Error('sync unavailable'); },
    });

    let importError: unknown;
    try {
      await importFromPortable(
        { userAgent: agent, emitter, storage, defaultSync: '30s' },
        { portableIdentity: createPortableIdentity() },
      );
    } catch (cause: unknown) {
      importError = cause;
    }

    expect(importError).toBeInstanceOf(AggregateError);
    expect((importError as AggregateError).message).toContain('rollback was incomplete');
    expect(((importError as AggregateError).errors[0] as Error).message).toBe('sync unavailable');
    expect(((importError as AggregateError).errors[1] as Error).message).toBe('identity metadata unavailable');
    expect(didDeleteCalls).toBe(0);
  });

  test('registers sync with protocols: all for delegate with unscoped Messages.Read grant', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncRegCalls: any[] = [];

    const delegateIdentity = createMockIdentity({
      did      : { uri: 'did:jwk:delegate' },
      metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner' },
    });

    const grantData = JSON.stringify({
      dateExpires : '2040-01-01T00:00:00Z',
      scope       : { interface: 'Messages', method: 'Read' },
      delegated   : true,
    });
    const encoded = btoa(grantData).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const agent = createMockAgent({
      identityImport       : async () => delegateIdentity,
      syncRegisterIdentity : async (params) => { syncRegCalls.push(params); },
      processDwnRequest    : async (params: any) => {
        const filter = params?.messageParams?.filter;
        if (filter?.protocolPath === 'grant') {
          return { reply: { status  : { code: 200, detail: 'OK' }, entries : [{
            recordId      : 'g-unscoped',
            contextId     : 'g-unscoped',
            encodedData   : encoded,
            descriptor    : { interface: 'Records', method: 'Write', protocol: 'https://identity.foundation/dwn/permissions', protocolPath: 'grant', recipient: 'did:jwk:delegate', dateCreated: '2025-01-01T00:00:00Z', dataFormat: 'application/json', dataCid: 'bafytest', dataSize: 100 },
            authorization : { signature: { signatures: [{ protected: btoa(JSON.stringify({ kid: 'did:dht:owner#sig' })) }] } },
          }] } };
        }
        return { reply: { status: { code: 200, detail: 'OK' }, entries: [] } };
      },
    });

    await importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: '30s' },
      {
        portableIdentity: createPortableIdentity({
          uri          : 'did:jwk:delegate',
          connectedDid : 'did:dht:owner',
        }),
      },
    );

    expect(syncRegCalls).toHaveLength(1);
    expect(syncRegCalls[0].options.protocols).toBe('all');
    expect(syncRegCalls[0].options.delegateDid).toBe('did:jwk:delegate');
  });

  test('unregisters identity for delegate with zero grants (clears stale registration)', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const unregisterCalls: string[] = [];

    const delegateIdentity = createMockIdentity({
      did      : { uri: 'did:jwk:delegate' },
      metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner' },
    });

    const agent = createMockAgent({
      identityImport         : async () => delegateIdentity,
      syncUnregisterIdentity : async (did) => { unregisterCalls.push(did); },
      processDwnRequest      : async () => ({
        reply: { status: { code: 200, detail: 'OK' }, entries: [] },
      }),
    });

    await importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: '30s' },
      {
        portableIdentity: createPortableIdentity({
          uri          : 'did:jwk:delegate',
          connectedDid : 'did:dht:owner',
        }),
      },
    );

    expect(unregisterCalls).toHaveLength(1);
    expect(unregisterCalls[0]).toBe('did:dht:owner');
  });

  test('tolerates "is not registered" error when unregistering zero-grant delegate', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();

    const delegateIdentity = createMockIdentity({
      did      : { uri: 'did:jwk:delegate' },
      metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner' },
    });

    const agent = createMockAgent({
      identityImport         : async () => delegateIdentity,
      syncUnregisterIdentity : async () => { throw new Error('is not registered'); },
      processDwnRequest      : async () => ({
        reply: { status: { code: 200, detail: 'OK' }, entries: [] },
      }),
    });

    const session = await importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: '30s' },
      {
        portableIdentity: createPortableIdentity({
          uri          : 'did:jwk:delegate',
          connectedDid : 'did:dht:owner',
        }),
      },
    );

    expect(session).toBeDefined();
  });

  test('rethrows I/O errors from unregisterIdentity on zero-grant delegate path', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();

    const delegateIdentity = createMockIdentity({
      did      : { uri: 'did:jwk:delegate' },
      metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner' },
    });

    const agent = createMockAgent({
      identityImport         : async () => delegateIdentity,
      syncUnregisterIdentity : async () => { throw new Error('LEVEL_IO_ERROR'); },
      processDwnRequest      : async () => ({
        reply: { status: { code: 200, detail: 'OK' }, entries: [] },
      }),
    });

    await expect(
      importFromPortable(
        { userAgent: agent, emitter, storage, defaultSync: '30s' },
        {
          portableIdentity: createPortableIdentity({
            uri          : 'did:jwk:delegate',
            connectedDid : 'did:dht:owner',
          }),
        },
      )
    ).rejects.toThrow('LEVEL_IO_ERROR');
  });
});
