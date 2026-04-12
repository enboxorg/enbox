import { describe, expect, test } from 'bun:test';

import { Convert } from '@enbox/common';

import { AuthEventEmitter } from '../src/events.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { STORAGE_KEYS } from '../src/types.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';
import { finalizeDelegateSession, importDelegateAndSetupSync, processConnectedGrants } from '../src/connect/lifecycle.js';

// ── Helpers ──────────────────────────────────────────────────────

/** Build a mock unscoped (unrestricted) grant — no protocol in scope. */
function buildUnscopedGrantMessage(grantId: string): any {
  return {
    recordId    : grantId,
    contextId   : grantId,
    encodedData : btoa(JSON.stringify({
      dateExpires : '2040-06-25T16:09:16.693356Z',
      scope       : { interface: 'Messages', method: 'Read' },
      delegated   : true,
    })),
    descriptor: {
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
  return {
    recordId    : grantId,
    contextId   : grantId,
    encodedData : btoa(JSON.stringify({
      dateExpires : '2040-06-25T16:09:16.693356Z',
      scope       : { interface: 'Records', method: 'Read', protocol },
      delegated   : true,
    })),
    descriptor: {
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
  describe('importDelegateDecryptionKeys branch', () => {
    test('imports delegate decryption keys when provided', async () => {
      const importedDecryptionKeys: any[] = [];
      const importedContextKeys: any[] = [];

      const identity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate1' },
        metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected1' },
      });

      const agent = createMockAgent({
        identityImport                  : async () => identity,
        dwnImportDelegateDecryptionKeys : (did: string, keys: any[]) => {
          importedDecryptionKeys.push({ did, keys });
        },
        dwnImportDelegateContextKeys: (did: string, keys: any[], protocols?: string[]) => {
          importedContextKeys.push({ did, keys, protocols });
        },
        dwnProcessRawMessage: async () => ({ status: { code: 202, detail: 'Accepted' } }),
      });

      const grants = [buildGrantMessage('https://proto.a', 'grant-a')];

      const decryptionKeys = [{ algorithm: 'A256GCM', derivationScheme: 'protocolPath', key: {} }];
      const contextKeys = [{ contextId: 'ctx-1', key: {} }];

      const result = await importDelegateAndSetupSync({
        userAgent                   : agent,
        delegatePortableDid         : { uri: 'did:jwk:delegate1', document: {} as any, metadata: {} },
        connectedDid                : 'did:dht:connected1',
        delegateGrants              : grants,
        delegateDecryptionKeys      : decryptionKeys as any,
        delegateContextKeys         : contextKeys as any,
        delegateMultiPartyProtocols : ['https://proto.a'],
        flowName                    : 'test',
      });

      expect(result).toBeDefined();

      // Decryption keys should have been imported (line 452).
      expect(importedDecryptionKeys).toHaveLength(1);
      expect(importedDecryptionKeys[0].did).toBe('did:jwk:delegate1');
      expect(importedDecryptionKeys[0].keys).toEqual(decryptionKeys);

      // Context keys should have been imported (lines 458-463).
      expect(importedContextKeys).toHaveLength(1);
      expect(importedContextKeys[0].did).toBe('did:jwk:delegate1');
    });
  });

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
  });
});

describe('finalizeDelegateSession', () => {
  describe('onDelegateContextKeysChanged callback', () => {
    test('persists updated context keys when callback fires for matching delegate', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();

      const identity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate1' },
        metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected1' },
      });

      const exportedKeys = [{ contextId: 'ctx-1', key: {} }];
      const agent = createMockAgent({
        dwnExportDelegateContextKeys: () => exportedKeys,
      });

      const session = await finalizeDelegateSession({
        userAgent    : agent,
        emitter,
        storage,
        identity     : identity as any,
        connectedDid : 'did:dht:connected1',
        delegateDid  : 'did:jwk:delegate1',
        sync         : '15s',
      });

      expect(session).toBeDefined();

      // The callback should have been wired.
      const callback = (agent.dwn as any).onDelegateContextKeysChanged;
      expect(callback).toBeDefined();

      // Fire the callback with matching delegate DID.
      await callback('did:jwk:delegate1');

      // Context keys should be persisted in the agent's SecretStore.
      const stored = await agent.secrets.get(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS);
      expect(stored).toBeDefined();
      const parsed = JSON.parse(Convert.uint8Array(stored!).toString());
      expect(parsed).toEqual(exportedKeys);
    });

    test('ignores callback when delegate DID does not match', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();

      const identity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate1' },
        metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected1' },
      });

      const agent = createMockAgent();

      await finalizeDelegateSession({
        userAgent    : agent,
        emitter,
        storage,
        identity     : identity as any,
        connectedDid : 'did:dht:connected1',
        delegateDid  : 'did:jwk:delegate1',
        sync         : '15s',
      });

      const callback = (agent.dwn as any).onDelegateContextKeysChanged;
      expect(callback).toBeDefined();

      // Fire with non-matching delegate — should be a no-op.
      await callback('did:jwk:different');

      // No context keys should be stored in SecretStore.
      const stored = await agent.secrets.get(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS);
      expect(stored).toBeUndefined();
    });
  });
});
