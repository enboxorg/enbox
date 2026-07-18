import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import sinon from 'sinon';

import { DwnPermissionGrant } from '@enbox/agent';

import { AuthEventEmitter } from '../src/events.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { STORAGE_KEYS } from '../src/types.js';
import { WalletConnect } from '../src/wallet-connect-client.js';
import { ConnectDeniedError, isConnectDeniedError } from '../src/errors.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';
import { processConnectedGrants, walletConnect } from '../src/connect/wallet.js';

/** Build a well-formed Messages.Read grant message that DwnPermissionGrant.parse() accepts. */
function buildTestGrant(protocol: string, grantId: string): any {
  const grantData = JSON.stringify({
    dateExpires : '2040-06-25T16:09:16.693356Z',
    scope       : { interface: 'Messages', method: 'Read', protocol },
    delegated   : true,
  });
  // Use base64url encoding (required by DwnPermissionGrant.parse → Encoder.base64UrlToObject).
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
      recipient    : 'did:dht:delegate123',
      dateCreated  : '2025-01-01T00:00:00.000000Z',
      dataFormat   : 'application/json',
      dataCid      : 'bafytest',
      dataSize     : 100,
    },
    authorization: {
      signature: { signatures: [{ protected: btoa(JSON.stringify({ kid: 'did:dht:connected456#sig' })) }] },
    },
  };
}

/** Build a non-Messages grant (Records.Write) — should NOT contribute to sync scope. */
function buildTestGrantNonMessages(grantId: string): any {
  const grantData = JSON.stringify({
    dateExpires : '2040-06-25T16:09:16.693356Z',
    scope       : { interface: 'Records', method: 'Write', protocol: 'https://proto.example/other' },
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
      recipient    : 'did:dht:delegate123',
      dateCreated  : '2025-01-01T00:00:00.000000Z',
      dataFormat   : 'application/json',
      dataCid      : 'bafytest',
      dataSize     : 100,
    },
    authorization: {
      signature: { signatures: [{ protected: btoa(JSON.stringify({ kid: 'did:dht:connected456#sig' })) }] },
    },
  };
}

function createInitClientResult(delegateGrants: any[] = []): any {
  return {
    delegatePortableDid : { uri: 'did:dht:delegate123' },
    connectedDid        : 'did:dht:connected456',
    delegateGrants,
  };
}

const CHAT_PERMISSION_REQUESTS: any = [{
  protocolDefinition: {
    protocol  : 'https://proto.example/chat',
    published : true,
    types     : {},
    structure : {},
  },
  permissionScopes: [
    { interface: 'Messages', method: 'Read', protocol: 'https://proto.example/chat' },
  ],
}];

let initClientStub: sinon.SinonStub;

function setupStubs(): void {
  initClientStub = sinon.stub(WalletConnect, 'initClient').resolves(createInitClientResult());
  sinon.stub(DwnPermissionGrant, 'parse').callsFake(((message: any): any => {
    // Decode scope from encodedData (base64url) to match real PermissionGrant.parse behavior.
    let scope = {};
    let dateExpires = '2040-01-01T00:00:00Z';
    try {
      const decoded = JSON.parse(atob(message.encodedData.replace(/-/g, '+').replace(/_/g, '/')));
      scope = decoded.scope ?? {};
      dateExpires = decoded.dateExpires ?? dateExpires;
    } catch { /* fallback to empty scope */ }
    return {
      id          : message.recordId,
      grantor     : 'did:dht:connected456',
      grantee     : message.descriptor?.recipient ?? 'did:jwk:delegate1',
      dateGranted : message.descriptor?.dateCreated,
      scope,
      dateExpires,
    };
  }) as any);
}

describe('processConnectedGrants', () => {
  beforeEach((): void => {
    setupStubs();
  });

  afterEach((): void => {
    sinon.restore();
  });

  test('returns empty array for no grants', async () => {
    const agent = createMockAgent();
    const result = await processConnectedGrants({
      agent,
      connectedDid : 'did:dht:connected',
      delegateDid  : 'did:dht:delegate',
      grants       : [],
    });
    expect(result).toEqual([]);
  });

  test('processes grants and returns protocol URIs', async () => {
    const processCalls: any[] = [];
    const agent = createMockAgent({
      processDwnRequest: async (params: any) => {
        processCalls.push(params);
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
      },
      dwnProcessRawMessage: async () => ({ status: { code: 202, detail: 'Accepted' } }),
    });

    const grants = [
      buildTestGrant('https://proto.example/chat', 'rec1'),
      buildTestGrant('https://proto.example/notes', 'rec2'),
      buildTestGrantNonMessages('rec3'), // Records grant — should not contribute to sync scope
    ] as any;

    const result = await processConnectedGrants({
      agent,
      connectedDid : 'did:dht:connected',
      delegateDid  : 'did:dht:delegate',
      grants,
    });

    expect(result).toEqual(['https://proto.example/chat', 'https://proto.example/notes']);
    // 3 grants stored in delegate partition via processDwnRequest
    expect(processCalls).toHaveLength(3);

    // Verify processDwnRequest called with delegate partition params
    expect(processCalls[0].author).toBe('did:dht:delegate');
    expect(processCalls[0].target).toBe('did:dht:delegate');
    expect(processCalls[0].messageType).toBe('RecordsWrite');
    expect(processCalls[0].signAsOwner).toBe(true);
    expect(processCalls[0].store).toBe(true);
    // The connected partition writes go through dwn.processRawMessage
    // (not processDwnRequest), so they don't appear in processCalls.
  });

  test('deduplicates protocol URIs', async () => {
    const agent = createMockAgent({
      processDwnRequest: async () => ({
        reply: { status: { code: 202, detail: 'Accepted' } },
      }),
    });

    const grants = [
      buildTestGrant('https://proto.example/chat', 'rec1'),
      buildTestGrant('https://proto.example/chat', 'rec2'),
    ] as any;

    const result = await processConnectedGrants({
      agent,
      connectedDid : 'did:dht:connected',
      delegateDid  : 'did:dht:delegate',
      grants,
    });

    expect(result).toEqual(['https://proto.example/chat']);
  });

  test('throws when grant processing fails', async () => {
    const agent = createMockAgent({
      processDwnRequest: async () => ({
        reply: { status: { code: 401, detail: 'Unauthorized' } },
      }),
    });

    const grants = [buildTestGrant('https://proto.example/chat', 'rec1')] as any;

    await expect(
      processConnectedGrants({
        agent,
        connectedDid : 'did:dht:connected',
        delegateDid  : 'did:dht:delegate',
        grants,
      })
    ).rejects.toThrow('Failed to store grant in delegate partition: Unauthorized');
  });

  test('rolls back only newly created grants when phase 2 fails (not pre-existing 409)', async () => {
    // Track processDwnRequest calls by messageType so we can inspect
    // the rollback RecordsDelete calls separately from the writes.
    const calls: { messageType: string; recordId?: string; author?: string }[] = [];

    let writeCount = 0;
    const agent = createMockAgent({
      processDwnRequest: async (params: any) => {
        calls.push({
          messageType : params.messageType,
          recordId    : params.messageParams?.recordId ?? params.rawMessage?.recordId,
          author      : params.author,
        });
        if (params.messageType === 'RecordsWrite') {
          writeCount++;
          // First grant returns 409 (pre-existing), second returns 202 (new).
          const code = writeCount === 1 ? 409 : 202;
          return { reply: { status: { code, detail: code === 409 ? 'Conflict' : 'Accepted' } } };
        }
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
      },
      // Phase 2 uses dwn.processRawMessage — first call succeeds, second fails.
      dwnProcessRawMessage: (() => {
        let callCount = 0;
        return async (): Promise<any> => {
          callCount++;
          if (callCount === 2) {
            return { status: { code: 500, detail: 'Internal Server Error' } };
          }
          return { status: { code: 202, detail: 'Accepted' } };
        };
      })(),
    });

    const grants = [
      buildTestGrant('https://proto.example/a', 'rec-a'),
      buildTestGrant('https://proto.example/b', 'rec-b'),
    ] as any;

    await expect(
      processConnectedGrants({ agent, connectedDid: 'did:dht:connected', delegateDid: 'did:dht:delegate', grants })
    ).rejects.toThrow('Failed to store grant in connected partition');

    // Phase 1: 2 RecordsWrite calls (one per grant, delegate partition).
    const writes = calls.filter(c => c.messageType === 'RecordsWrite');
    expect(writes).toHaveLength(2);

    // Rollback: only the newly created grant (rec-b, 202) should be deleted.
    // The pre-existing grant (rec-a, 409) must NOT be deleted.
    const deletes = calls.filter(c => c.messageType === 'RecordsDelete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].author).toBe('did:dht:delegate');
    expect(deletes[0].recordId).toBe('rec-b');
  });

  test('accepts 409 (duplicate) in phase 1 for idempotent retries', async () => {
    const agent = createMockAgent({
      // First grant returns 409 (stale duplicate from prior failed attempt),
      // second grant returns 202 (fresh write).
      processDwnRequest: (() => {
        let callCount = 0;
        return async (): Promise<any> => {
          callCount++;
          const code = callCount === 1 ? 409 : 202;
          return { reply: { status: { code, detail: code === 409 ? 'Conflict' : 'Accepted' } } };
        };
      })(),
    });

    const grants = [
      buildTestGrant('https://proto.example/a', 'rec-a'),
      buildTestGrant('https://proto.example/b', 'rec-b'),
    ] as any;

    // Should succeed — 409 is treated as idempotent success.
    const result = await processConnectedGrants({
      agent,
      connectedDid : 'did:dht:connected',
      delegateDid  : 'did:dht:delegate',
      grants,
    });

    expect(result).toEqual(['https://proto.example/a', 'https://proto.example/b']);
  });
});

describe('walletConnect', () => {
  beforeEach((): void => {
    setupStubs();
  });

  afterEach((): void => {
    sinon.restore();
  });

  test('allows sync off without throwing', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => identity,
    });

    initClientStub.onFirstCall().resolves(createInitClientResult());

    // Should not throw — sync: 'off' is now allowed.
    const session = await walletConnect(
      { userAgent: agent, emitter, storage, defaultSync: 'off' },
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
      },
    );

    expect(session.did).toBe('did:dht:connected456');
  });

  test('throws when initClient returns undefined/null', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const agent = createMockAgent({ firstLaunch: async () => false });

    initClientStub.onFirstCall().resolves(undefined);

    await expect(
      walletConnect(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
        {
          displayName        : 'Test App',
          connectServerUrl   : 'https://relay.example.com',
          permissionRequests : [],
          onWalletUriReady   : () => {},
          validatePin        : async () => '1234',
        },
      )
    ).rejects.toThrow('Connection was denied by the wallet');
  });

  test('wallet denial rejects with a typed ConnectDeniedError and preserves the message', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const agent = createMockAgent({ firstLaunch: async () => false });

    initClientStub.onFirstCall().resolves(undefined);

    let caught: unknown;
    try {
      await walletConnect(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
        {
          displayName        : 'Test App',
          connectServerUrl   : 'https://relay.example.com',
          permissionRequests : [],
          onWalletUriReady   : () => {},
          validatePin        : async () => '1234',
        },
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConnectDeniedError);
    expect(isConnectDeniedError(caught)).toBe(true);
    expect((caught as Error).message).toBe('[@enbox/auth] Connection was denied by the wallet.');
  });

  test('successful wallet connect creates session', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });
    const events: string[] = [];

    emitter.on('identity-added', () => { events.push('identity-added'); });
    emitter.on('session-start', () => { events.push('session-start'); });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => identity,
    });

    initClientStub.onFirstCall().resolves(createInitClientResult());

    const session = await walletConnect(
      { userAgent: agent, emitter, storage, defaultSync: '15s' },
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
      },
    );

    expect(session.did).toBe('did:dht:connected456');
    expect(session.delegateDid).toBe('did:dht:delegate123');
    expect(events).toEqual(['identity-added', 'session-start']);

    // Check storage
    expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBe('true');
    expect(await storage.get(STORAGE_KEYS.ACTIVE_IDENTITY)).toBe('did:dht:connected456');
    expect(await storage.get(STORAGE_KEYS.DELEGATE_DID)).toBe('did:dht:delegate123');
    expect(await storage.get(STORAGE_KEYS.CONNECTED_DID)).toBe('did:dht:connected456');
  });

  test('passes correct options to initClient', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const delegatePortableDid = {
      uri         : 'did:jwk:local-delegate',
      document    : {},
      metadata    : {},
      privateKeys : [],
    };
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => identity,
    });

    let capturedOptions: any;
    initClientStub.onFirstCall().callsFake((...args: any[]): any => {
      capturedOptions = args[0];
      return Promise.resolve(createInitClientResult());
    });

    await walletConnect(
      { userAgent: agent, emitter, storage, defaultSync: '15s' },
      {
        displayName          : 'Test App',
        connectServerUrl     : 'https://relay.example.com',
        permissionRequests   : [],
        onWalletUriReady     : () => {},
        validatePin          : async () => '1234',
        preSupplyDelegateDid : true,
        delegatePortableDid  : delegatePortableDid,
      },
    );

    expect(capturedOptions.displayName).toBe('Test App');
    expect(capturedOptions.connectServerUrl).toBe('https://relay.example.com');
    expect(capturedOptions.walletUri).toBe('enbox://connect');
    expect(capturedOptions.preSupplyDelegateDid).toBe(true);
    expect(capturedOptions.delegatePortableDid).toBe(delegatePortableDid);
  });

  test('uses custom walletUri when provided', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => identity,
    });

    let capturedOptions: any;
    initClientStub.onFirstCall().callsFake((...args: any[]): any => {
      capturedOptions = args[0];
      return Promise.resolve(createInitClientResult());
    });

    await walletConnect(
      { userAgent: agent, emitter, storage, defaultSync: '15s' },
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
        walletUri          : 'custom://wallet',
      },
    );

    expect(capturedOptions.walletUri).toBe('custom://wallet');
  });

  test('live sync mode when no interval specified', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncCalls: any[] = [];
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => identity,
      syncStartSync  : async (params: any) => { syncCalls.push(params); },
    });

    initClientStub.onFirstCall().resolves(createInitClientResult());

    await walletConnect(
      { userAgent: agent, emitter, storage }, // no defaultSync = live mode
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
      },
    );

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].mode).toBe('live');
    expect(syncCalls[0].interval).toBe('5m');
  });

  test('poll sync mode when interval specified', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncCalls: any[] = [];
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => identity,
      syncStartSync  : async (params: any) => { syncCalls.push(params); },
    });

    initClientStub.onFirstCall().resolves(createInitClientResult());

    await walletConnect(
      { userAgent: agent, emitter, storage, defaultSync: '30s' },
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
      },
    );

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].mode).toBe('poll');
    expect(syncCalls[0].interval).toBe('30s');
  });

  test('processes grants with identity import', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const processCalls: any[] = [];
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch       : async () => false,
      identityImport    : async () => identity,
      processDwnRequest : async (params: any) => {
        processCalls.push(params);
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
      },
    });

    const grantData = [buildTestGrant('https://proto.example/chat', 'rec1')];

    initClientStub.onFirstCall().resolves(createInitClientResult(grantData));

    const session = await walletConnect(
      { userAgent: agent, emitter, storage, defaultSync: '15s' },
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : CHAT_PERMISSION_REQUESTS,
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
      },
    );

    expect(session.did).toBe('did:dht:connected456');
    // Grant stored in delegate partition via processDwnRequest.
    // Connected partition goes through dwn.processRawMessage.
    expect(processCalls).toHaveLength(1);
  });

  test('cleans up on identity import failure', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => { throw new Error('import failed'); },
    });

    initClientStub.onFirstCall().resolves(createInitClientResult());

    await expect(
      walletConnect(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
        {
          displayName        : 'Test App',
          connectServerUrl   : 'https://relay.example.com',
          permissionRequests : [],
          onWalletUriReady   : () => {},
          validatePin        : async () => '1234',
        },
      )
    ).rejects.toThrow('Wallet connect failed: import failed');
  });

  test('cleans up identity on post-import failure', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const deletedDids: string[] = [];
    const deletedIdentities: string[] = [];
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch          : async () => false,
      identityImport       : async () => identity,
      didDelete            : async (params: any) => { deletedDids.push(params.didUri); },
      identityDelete       : async (params: any) => { deletedIdentities.push(params.didUri); },
      syncRegisterIdentity : async () => { throw new Error('sync reg failed'); },
    });

    // Provide a grant so connectedProtocols is non-empty and sync registration is attempted.
    const grantData = [buildTestGrant('https://proto.example/chat', 'rec1')];
    initClientStub.onFirstCall().resolves(createInitClientResult(grantData));

    await expect(
      walletConnect(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
        {
          displayName        : 'Test App',
          connectServerUrl   : 'https://relay.example.com',
          permissionRequests : CHAT_PERMISSION_REQUESTS,
          onWalletUriReady   : () => {},
          validatePin        : async () => '1234',
        },
      )
    ).rejects.toThrow('Wallet connect failed');

    expect(deletedDids).toContain('did:dht:delegate123');
    expect(deletedIdentities).toContain('did:dht:delegate123');
  });

  test('cleanup handles DID delete failure gracefully', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch          : async () => false,
      identityImport       : async () => identity,
      didDelete            : async () => { throw new Error('DID delete failed'); },
      identityDelete       : async () => { throw new Error('identity delete failed'); },
      syncRegisterIdentity : async () => { throw new Error('trigger cleanup'); },
    });

    // Provide a Messages.Read grant so sync registration is attempted.
    const grantData = [buildTestGrant('https://proto.example/chat', 'rec1')];
    initClientStub.onFirstCall().resolves(createInitClientResult(grantData));

    // Should not throw from cleanup — only from the original error
    await expect(
      walletConnect(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
        {
          displayName        : 'Test App',
          connectServerUrl   : 'https://relay.example.com',
          permissionRequests : CHAT_PERMISSION_REQUESTS,
          onWalletUriReady   : () => {},
          validatePin        : async () => '1234',
        },
      )
    ).rejects.toThrow('Wallet connect failed: trigger cleanup');
  });

  test('option sync overrides context defaultSync', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncCalls: any[] = [];
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => identity,
      syncStartSync  : async (params: any) => { syncCalls.push(params); },
    });

    initClientStub.onFirstCall().resolves(createInitClientResult());

    await walletConnect(
      { userAgent: agent, emitter, storage, defaultSync: '15s' },
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
        sync               : '45s',
      },
    );

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].interval).toBe('45s');
  });

  test('does not call sync.sync pull after registering identity (deferred to startSync)', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncCalls: string[] = [];
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => identity,
      syncSync       : async (dir: string) => { syncCalls.push(dir); },
    });

    initClientStub.onFirstCall().resolves(createInitClientResult());

    await walletConnect(
      { userAgent: agent, emitter, storage, defaultSync: '15s' },
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
      },
    );

    // sync('pull') is no longer called in importDelegateAndSetupSync —
    // startSyncIfEnabled() handles the initial sync cycle instead.
    expect(syncCalls).not.toContain('pull');
  });

  test('calls registration when registration options are provided', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    initClientStub.resetHistory();
    initClientStub.onFirstCall().resolves(createInitClientResult());

    let registrationSucceeded = false;
    const agent = createMockAgent({
      identityImport: async () => createMockIdentity({
        did      : { uri: 'did:dht:delegate123' },
        metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
      }),
      rpcGetServerInfo: async () => ({
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
      }),
    });

    await walletConnect(
      {
        userAgent    : agent,
        emitter,
        storage,
        defaultSync  : '15s',
        registration : {
          onSuccess : () => { registrationSucceeded = true; },
          onFailure : () => {},
        },
      },
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
      },
    );

    expect(registrationSucceeded).toBe(true);
  });
});
