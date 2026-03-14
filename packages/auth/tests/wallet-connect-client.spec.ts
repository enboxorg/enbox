/**
 * Tests for `WalletConnect.initClient()` and `WalletConnect.createPermissionRequestForProtocol()`.
 *
 * Moved from `@enbox/agent/tests/connect.spec.ts` when the WalletConnect
 * client code was relocated to `@enbox/auth`.
 */

import type { DwnProtocolDefinition } from '@enbox/agent';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { EnboxConnectProtocol } from '@enbox/agent';
import { WalletConnect } from '../src/wallet-connect-client.js';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

describe('WalletConnect', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('initClient — error paths', () => {
    it('should throw when signJwt returns undefined', async () => {
      sinon.stub(EnboxConnectProtocol, 'signJwt').resolves(undefined as any);

      await expect(
        WalletConnect.initClient({
          displayName        : 'Sample App',
          walletUri          : 'http://localhost:3000/',
          connectServerUrl   : 'http://localhost:3000/connect',
          permissionRequests : [{ protocolDefinition: {} as any, permissionScopes: {} as any }],
          onWalletUriReady   : () => {},
          validatePin        : async () => '1234',
        })
      ).rejects.toThrow('Unable to sign requestObject');
    });

    it('should throw when PAR response is not ok', async () => {
      sinon.stub(EnboxConnectProtocol, 'signJwt').resolves('signed.jwt.value');
      sinon.stub(EnboxConnectProtocol, 'encryptRequest').resolves('encrypted-jwe');
      sinon.stub(globalThis, 'fetch').resolves(
        new Response('Bad Request', { status: 400, statusText: 'Bad Request' })
      );

      await expect(
        WalletConnect.initClient({
          displayName        : 'Sample App',
          walletUri          : 'http://localhost:3000/',
          connectServerUrl   : 'http://localhost:3000/connect',
          permissionRequests : [{ protocolDefinition: {} as any, permissionScopes: {} as any }],
          onWalletUriReady   : () => {},
          validatePin        : async () => '1234',
        })
      ).rejects.toThrow('400: Bad Request');
    });
  });

  describe('initClient — happy path', () => {
    it('should complete the full relay flow and return delegate info', async () => {
      // Stub EnboxConnectProtocol methods used by initClient.
      sinon.stub(EnboxConnectProtocol, 'createConnectRequest').resolves({
        clientDid           : 'did:jwk:test',
        callbackUrl         : 'http://localhost:3000/connect/callback',
        permissionRequests  : [],
        appName             : 'Sample App',
        nonce               : 'test-nonce',
        responseMode        : 'direct_post',
        state               : 'test-state',
        supportedDidMethods : ['did:dht', 'did:jwk'],
      } as any);
      sinon.stub(EnboxConnectProtocol, 'signJwt').resolves('signed.jwt.value');
      sinon.stub(EnboxConnectProtocol, 'encryptRequest').resolves('encrypted-jwe');
      sinon.stub(EnboxConnectProtocol, 'decryptResponse').resolves('decrypted.jwt.value');
      sinon.stub(EnboxConnectProtocol, 'verifyJwt').resolves({
        providerDid         : 'did:dht:provider789',
        delegateGrants      : [{ recordId: 'grant1' }],
        delegatePortableDid : { uri: 'did:dht:delegate123', document: {}, metadata: {} },
      } as any);

      // Stub fetch: first call = PAR response, second call = poll token response.
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onFirstCall().resolves(
        new Response(JSON.stringify({ request_uri: 'http://localhost:3000/connect/authorize/req.jwt' }), {
          status  : 200,
          headers : { 'Content-Type': 'application/json' },
        })
      );
      fetchStub.onSecondCall().resolves(
        new Response('encrypted-response-jwe', { status: 200 })
      );

      const walletUris: string[] = [];

      const result = await WalletConnect.initClient({
        displayName        : 'Sample App',
        walletUri          : 'http://localhost:3000/',
        connectServerUrl   : 'http://localhost:3000/connect',
        permissionRequests : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady   : (uri: string): void => { walletUris.push(uri); },
        validatePin        : async (): Promise<string> => '1234',
      });

      // Verify result shape.
      expect(result).toBeDefined();
      expect(result!.connectedDid).toBe('did:dht:provider789');
      expect(result!.delegatePortableDid.uri).toBe('did:dht:delegate123');
      expect(result!.delegateGrants).toHaveLength(1);

      // Verify onWalletUriReady was called with the correct URI.
      expect(walletUris).toHaveLength(1);
      const uri = new URL(walletUris[0]);
      expect(uri.searchParams.get('request_uri')).toBe('http://localhost:3000/connect/authorize/req.jwt');
      expect(uri.searchParams.get('encryption_key')).toBeDefined();

      // Verify fetch was called for PAR and poll.
      expect(fetchStub.callCount).toBeGreaterThanOrEqual(2);
    });

  });

  describe('createPermissionRequestForProtocol', () => {
    it('should add sync permissions to all requests', async () => {
      const protocol: DwnProtocolDefinition = {
        published : true,
        protocol  : 'https://exmaple.org/protocols/social',
        types     : {
          note: {
            schema      : 'https://example.org/schemas/note',
            dataFormats : ['application/json', 'text/plain'],
          }
        },
        structure: {
          note: {}
        }
      };

      const permissionRequests = WalletConnect.createPermissionRequestForProtocol({
        definition  : protocol,
        permissions : [],
      });

      expect(permissionRequests.protocolDefinition).toEqual(protocol);
      // Messages.Read (unified: covers Read, Subscribe, Sync) + Protocols.Query
      expect(permissionRequests.permissionScopes.length).toBe(2);
      const scopes = permissionRequests.permissionScopes;
      expect(scopes.find(
        (scope) => scope.interface === DwnInterfaceName.Messages && scope.method === DwnMethodName.Read
      )).toBeDefined();
      expect(scopes.find(
        (scope) => scope.interface === DwnInterfaceName.Protocols && scope.method === DwnMethodName.Query
      )).toBeDefined();
    });

    it('should add requested permissions to the request', async () => {
      const protocol: DwnProtocolDefinition = {
        published : true,
        protocol  : 'https://exmaple.org/protocols/social',
        types     : {
          note: {
            schema      : 'https://example.org/schemas/note',
            dataFormats : ['application/json', 'text/plain'],
          }
        },
        structure: {
          note: {}
        }
      };

      const permissionRequests = WalletConnect.createPermissionRequestForProtocol({
        definition  : protocol,
        permissions : ['write', 'read'],
      });

      expect(permissionRequests.protocolDefinition).toEqual(protocol);

      // Messages.Read (unified) + 2 requested Records permissions + Protocols.Query
      expect(permissionRequests.permissionScopes.length).toBe(4);
      expect(permissionRequests.permissionScopes.find(
        (scope) => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Read
      )).toBeDefined();
      expect(permissionRequests.permissionScopes.find(
        (scope) => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Write
      )).toBeDefined();
    });

    it('supports requesting `read`, `write`, `delete`, `query`, `subscribe` and `configure` permissions', async () => {
      const protocol: DwnProtocolDefinition = {
        published : true,
        protocol  : 'https://exmaple.org/protocols/social',
        types     : {
          note: {
            schema      : 'https://example.org/schemas/note',
            dataFormats : ['application/json', 'text/plain'],
          }
        },
        structure: {
          note: {}
        }
      };

      const permissionRequests = WalletConnect.createPermissionRequestForProtocol({
        definition  : protocol,
        permissions : ['write', 'read', 'delete', 'query', 'subscribe', 'configure'],
      });

      expect(permissionRequests.protocolDefinition).toEqual(protocol);

      // Messages.Read (unified) + 5 requested Records permissions + Protocols.Query + Protocols.Configure
      expect(permissionRequests.permissionScopes.length).toBe(8);
      const ps = permissionRequests.permissionScopes;
      expect(ps.find(
        (scope) => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Read
      )).toBeDefined();
      expect(ps.find(
        (scope) => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Write
      )).toBeDefined();
      expect(ps.find(
        (scope) => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Delete
      )).toBeDefined();
      expect(ps.find(
        (scope) => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Query
      )).toBeDefined();
      expect(ps.find(
        (scope) => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Subscribe
      )).toBeDefined();
      expect(ps.find(
        (scope) => scope.interface === DwnInterfaceName.Protocols && scope.method === DwnMethodName.Query
      )).toBeDefined();
      expect(ps.find(
        (scope) => scope.interface === DwnInterfaceName.Protocols && scope.method === DwnMethodName.Configure
      )).toBeDefined();
    });
  });
});
