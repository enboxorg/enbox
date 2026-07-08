/**
 * Tests for `WalletConnect.initClient()` and `WalletConnect.createPermissionRequestForProtocol()`.
 *
 * Moved from `@enbox/agent/tests/connect.spec.ts` when the WalletConnect
 * client code was relocated to `@enbox/auth`.
 */

import type { DwnProtocolDefinition } from '@enbox/agent';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { Ed25519 } from '@enbox/crypto';
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
      sinon.stub(EnboxConnectProtocol, 'createConnectRequest').callsFake(async (options: any): Promise<any> => ({
        clientDid                  : 'did:jwk:test',
        callbackUrl                : 'http://localhost:3000/connect/callback',
        permissionRequests         : [],
        appName                    : 'Sample App',
        requestedSessionTtlSeconds : options.requestedSessionTtlSeconds,
        nonce                      : 'test-nonce',
        responseMode               : 'direct_post',
        state                      : 'test-state',
        supportedDidMethods        : ['did:dht', 'did:jwk'],
      }));
      sinon.stub(EnboxConnectProtocol, 'signJwt').resolves('signed.jwt.value');
      sinon.stub(EnboxConnectProtocol, 'encryptRequest').resolves('encrypted-jwe');
      sinon.stub(EnboxConnectProtocol, 'decryptResponse').resolves('decrypted.jwt.value');
      // Verified-JWT payload must satisfy `assertConnectResponse` in
      // @enbox/agent. The required fields are providerDid / delegateDid /
      // aud / iat / exp / delegateGrants / delegatePortableDid.
      sinon.stub(EnboxConnectProtocol, 'verifyJwt').resolves({
        providerDid         : 'did:dht:provider789',
        delegateDid         : 'did:dht:delegate123',
        aud                 : 'did:jwk:test',
        iat                 : Math.floor(Date.now() / 1000),
        exp                 : Math.floor(Date.now() / 1000) + 3600,
        delegateGrants      : [{ recordId: 'grant1' }],
        delegatePortableDid : { uri: 'did:dht:delegate123', document: {}, metadata: {} },
      });

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
        displayName                : 'Sample App',
        walletUri                  : 'http://localhost:3000/',
        connectServerUrl           : 'http://localhost:3000/connect',
        permissionRequests         : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady           : (uri: string): void => { walletUris.push(uri); },
        validatePin                : async (): Promise<string> => '1234',
        requestedSessionTtlSeconds : 2_592_000,
      });

      // Verify result shape.
      expect(result).toBeDefined();
      expect(result!.connectedDid).toBe('did:dht:provider789');
      expect(result!.delegatePortableDid.uri).toBe('did:dht:delegate123');
      expect(result!.delegateGrants).toHaveLength(1);
      expect((EnboxConnectProtocol.createConnectRequest as sinon.SinonStub).firstCall.args[0].requestedSessionTtlSeconds).toBe(2_592_000);

      // Verify onWalletUriReady was called with the correct URI. The relay
      // pointer and encryption key ride in the fragment, never the query string.
      expect(walletUris).toHaveLength(1);
      const uri = new URL(walletUris[0]);
      expect(uri.search).toBe('');
      const parsed = EnboxConnectProtocol.parseWalletConnectUri(walletUris[0]);
      expect(parsed?.requestUri).toBe('http://localhost:3000/connect/authorize/req.jwt');
      expect(parsed?.encryptionKeyBase64Url).toBeDefined();

      // Verify fetch was called for PAR and poll.
      expect(fetchStub.callCount).toBeGreaterThanOrEqual(2);
    });

    it('should request grants to a locally generated delegate DID when pre-supply is enabled', async () => {
      let requestedDelegateDid = '';
      sinon.stub(EnboxConnectProtocol, 'createConnectRequest').callsFake(async (options: any): Promise<any> => {
        requestedDelegateDid = options.delegateDid;
        return {
          clientDid           : 'did:jwk:test',
          callbackUrl         : 'http://localhost:3000/connect/callback',
          permissionRequests  : [],
          appName             : 'Sample App',
          delegateDid         : options.delegateDid,
          nonce               : 'test-nonce',
          responseMode        : 'direct_post',
          state               : 'test-state',
          supportedDidMethods : ['did:dht', 'did:jwk'],
        };
      });
      sinon.stub(EnboxConnectProtocol, 'signJwt').resolves('signed.jwt.value');
      sinon.stub(EnboxConnectProtocol, 'encryptRequest').resolves('encrypted-jwe');
      sinon.stub(EnboxConnectProtocol, 'decryptResponse').resolves('decrypted.jwt.value');
      sinon.stub(EnboxConnectProtocol, 'verifyJwt').callsFake(async (): Promise<any> => ({
        providerDid    : 'did:dht:provider789',
        delegateDid    : requestedDelegateDid,
        aud            : 'did:jwk:test',
        iat            : Math.floor(Date.now() / 1000),
        exp            : Math.floor(Date.now() / 1000) + 3600,
        delegateGrants : [{ recordId: 'grant1' }],
      }));

      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onFirstCall().resolves(
        new Response(JSON.stringify({ request_uri: 'http://localhost:3000/connect/authorize/req.jwt' }), {
          status  : 200,
          headers : { 'Content-Type': 'application/json' },
        })
      );
      fetchStub.onSecondCall().resolves(new Response('encrypted-response-jwe', { status: 200 }));

      const result = await WalletConnect.initClient({
        displayName          : 'Sample App',
        walletUri            : 'http://localhost:3000/',
        connectServerUrl     : 'http://localhost:3000/connect',
        permissionRequests   : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady     : (): void => {},
        validatePin          : async (): Promise<string> => '1234',
        preSupplyDelegateDid : true,
      });

      expect(requestedDelegateDid.startsWith('did:jwk:')).toBe(true);
      expect(result?.delegatePortableDid.uri).toBe(requestedDelegateDid);
      expect(result?.delegatePortableDid.privateKeys?.some((key) => key.crv === 'X25519')).toBe(true);
    });

    it('should derive X25519 from the Ed25519 key in a caller-supplied delegate DID regardless of key order', async () => {
      const delegatePortableDid = {
        uri         : 'did:jwk:local-delegate',
        document    : {},
        metadata    : {},
        privateKeys : [
          { kty: 'EC', crv: 'P-256', d: 'p256-private', x: 'p256-x', y: 'p256-y' },
          { kty: 'OKP', crv: 'Ed25519', d: 'ed-private', x: 'ed-public' },
        ],
      };
      let requestedDelegateDid = '';
      sinon.stub(Ed25519, 'convertPrivateKeyToX25519').callsFake(async ({ privateKey }: any): Promise<any> => {
        expect(privateKey.crv).toBe('Ed25519');
        return { kty: 'OKP', crv: 'X25519', d: 'x-private', x: 'x-public' };
      });
      sinon.stub(EnboxConnectProtocol, 'createConnectRequest').callsFake(async (options: any): Promise<any> => {
        requestedDelegateDid = options.delegateDid;
        return {
          clientDid           : 'did:jwk:test',
          callbackUrl         : 'http://localhost:3000/connect/callback',
          permissionRequests  : [],
          appName             : 'Sample App',
          delegateDid         : options.delegateDid,
          nonce               : 'test-nonce',
          responseMode        : 'direct_post',
          state               : 'test-state',
          supportedDidMethods : ['did:dht', 'did:jwk'],
        };
      });
      sinon.stub(EnboxConnectProtocol, 'signJwt').resolves('signed.jwt.value');
      sinon.stub(EnboxConnectProtocol, 'encryptRequest').resolves('encrypted-jwe');
      sinon.stub(EnboxConnectProtocol, 'decryptResponse').resolves('decrypted.jwt.value');
      sinon.stub(EnboxConnectProtocol, 'verifyJwt').callsFake(async (): Promise<any> => ({
        providerDid    : 'did:dht:provider789',
        delegateDid    : requestedDelegateDid,
        aud            : 'did:jwk:test',
        iat            : Math.floor(Date.now() / 1000),
        exp            : Math.floor(Date.now() / 1000) + 3600,
        delegateGrants : [{ recordId: 'grant1' }],
      }));

      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onFirstCall().resolves(
        new Response(JSON.stringify({ request_uri: 'http://localhost:3000/connect/authorize/req.jwt' }), {
          status  : 200,
          headers : { 'Content-Type': 'application/json' },
        })
      );
      fetchStub.onSecondCall().resolves(new Response('encrypted-response-jwe', { status: 200 }));

      const result = await WalletConnect.initClient({
        displayName        : 'Sample App',
        walletUri          : 'http://localhost:3000/',
        connectServerUrl   : 'http://localhost:3000/connect',
        permissionRequests : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady   : (): void => {},
        validatePin        : async (): Promise<string> => '1234',
        delegatePortableDid,
      });

      expect(requestedDelegateDid).toBe('did:jwk:local-delegate');
      expect(result?.delegatePortableDid.privateKeys?.map((key) => key.crv)).toEqual(['P-256', 'Ed25519', 'X25519']);
    });

    it('should reject a caller-supplied delegate DID without an Ed25519 private key', async () => {
      await expect(WalletConnect.initClient({
        displayName         : 'Sample App',
        walletUri           : 'http://localhost:3000/',
        connectServerUrl    : 'http://localhost:3000/connect',
        permissionRequests  : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady    : (): void => {},
        validatePin         : async (): Promise<string> => '1234',
        delegatePortableDid : {
          uri         : 'did:jwk:local-delegate',
          document    : {},
          metadata    : {},
          privateKeys : [{ kty: 'EC', crv: 'P-256', d: 'p256-private', x: 'p256-x', y: 'p256-y' }],
        },
      })).rejects.toThrow('WalletConnect: delegatePortableDid must include an Ed25519 private key.');
    });

    it('should reject a wallet response for a different delegate DID when pre-supply is enabled', async () => {
      let requestedDelegateDid = '';
      sinon.stub(EnboxConnectProtocol, 'createConnectRequest').callsFake(async (options: any): Promise<any> => {
        requestedDelegateDid = options.delegateDid;
        return {
          clientDid           : 'did:jwk:test',
          callbackUrl         : 'http://localhost:3000/connect/callback',
          permissionRequests  : [],
          appName             : 'Sample App',
          delegateDid         : options.delegateDid,
          nonce               : 'test-nonce',
          responseMode        : 'direct_post',
          state               : 'test-state',
          supportedDidMethods : ['did:dht', 'did:jwk'],
        };
      });
      sinon.stub(EnboxConnectProtocol, 'signJwt').resolves('signed.jwt.value');
      sinon.stub(EnboxConnectProtocol, 'encryptRequest').resolves('encrypted-jwe');
      sinon.stub(EnboxConnectProtocol, 'decryptResponse').resolves('decrypted.jwt.value');
      sinon.stub(EnboxConnectProtocol, 'verifyJwt').resolves({
        providerDid    : 'did:dht:provider789',
        delegateDid    : 'did:jwk:other-delegate',
        aud            : 'did:jwk:test',
        iat            : Math.floor(Date.now() / 1000),
        exp            : Math.floor(Date.now() / 1000) + 3600,
        delegateGrants : [{ recordId: 'grant1' }],
      });

      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onFirstCall().resolves(
        new Response(JSON.stringify({ request_uri: 'http://localhost:3000/connect/authorize/req.jwt' }), {
          status  : 200,
          headers : { 'Content-Type': 'application/json' },
        })
      );
      fetchStub.onSecondCall().resolves(new Response('encrypted-response-jwe', { status: 200 }));

      await expect(WalletConnect.initClient({
        displayName          : 'Sample App',
        walletUri            : 'http://localhost:3000/',
        connectServerUrl     : 'http://localhost:3000/connect',
        permissionRequests   : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady     : (): void => {},
        validatePin          : async (): Promise<string> => '1234',
        preSupplyDelegateDid : true,
      })).rejects.toThrow('wallet returned delegate DID \'did:jwk:other-delegate\'');
      expect(requestedDelegateDid.startsWith('did:jwk:')).toBe(true);
    });

    it('should reject a wallet-minted response that omits delegatePortableDid', async () => {
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
        providerDid    : 'did:dht:provider789',
        delegateDid    : 'did:jwk:wallet-delegate',
        aud            : 'did:jwk:test',
        iat            : Math.floor(Date.now() / 1000),
        exp            : Math.floor(Date.now() / 1000) + 3600,
        delegateGrants : [{ recordId: 'grant1' }],
      });

      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onFirstCall().resolves(
        new Response(JSON.stringify({ request_uri: 'http://localhost:3000/connect/authorize/req.jwt' }), {
          status  : 200,
          headers : { 'Content-Type': 'application/json' },
        })
      );
      fetchStub.onSecondCall().resolves(new Response('encrypted-response-jwe', { status: 200 }));

      await expect(WalletConnect.initClient({
        displayName        : 'Sample App',
        walletUri          : 'http://localhost:3000/',
        connectServerUrl   : 'http://localhost:3000/connect',
        permissionRequests : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady   : (): void => {},
        validatePin        : async (): Promise<string> => '1234',
      })).rejects.toThrow('WalletConnect: wallet response omitted delegatePortableDid.');
    });

    it('should return undefined when the wallet explicitly denies access', async () => {
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
      const decryptResponse = sinon.stub(EnboxConnectProtocol, 'decryptResponse').resolves('decrypted.jwt.value');

      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onFirstCall().resolves(
        new Response(JSON.stringify({ request_uri: 'http://localhost:3000/connect/authorize/req.jwt' }), {
          status  : 200,
          headers : { 'Content-Type': 'application/json' },
        })
      );
      fetchStub.onSecondCall().resolves(
        new Response('DENIED', { status: 200 })
      );

      const result = await WalletConnect.initClient({
        displayName        : 'Sample App',
        walletUri          : 'http://localhost:3000/',
        connectServerUrl   : 'http://localhost:3000/connect',
        permissionRequests : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady   : (): void => {},
        validatePin        : async (): Promise<string> => '1234',
      });

      expect(result).toBeUndefined();
      expect(decryptResponse.called).toBe(false);
    });

    it('should await wallet URI handling before polling for the response', async () => {
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

      let callbackComplete = false;
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onFirstCall().resolves(
        new Response(JSON.stringify({ request_uri: 'http://localhost:3000/connect/authorize/req.jwt' }), {
          status  : 200,
          headers : { 'Content-Type': 'application/json' },
        })
      );
      fetchStub.onSecondCall().callsFake(async (): Promise<Response> => {
        expect(callbackComplete).toBe(true);
        return new Response('DENIED', { status: 200 });
      });

      const result = await WalletConnect.initClient({
        displayName        : 'Sample App',
        walletUri          : 'http://localhost:3000/',
        connectServerUrl   : 'http://localhost:3000/connect',
        permissionRequests : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady   : async (): Promise<void> => {
          await new Promise((resolve): void => { setTimeout(resolve, 0); });
          callbackComplete = true;
        },
        validatePin: async (): Promise<string> => '1234',
      });

      expect(result).toBeUndefined();
    });

    it('should stop polling after a custom timeout', async () => {
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

      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onFirstCall().resolves(
        new Response(JSON.stringify({ request_uri: 'http://localhost:3000/connect/authorize/req.jwt' }), {
          status  : 200,
          headers : { 'Content-Type': 'application/json' },
        })
      );
      fetchStub.callsFake(async (): Promise<Response> => new Response('Not Found', { status: 404 }));

      const result = await WalletConnect.initClient({
        displayName        : 'Sample App',
        walletUri          : 'http://localhost:3000/',
        connectServerUrl   : 'http://localhost:3000/connect',
        permissionRequests : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady   : (): void => {},
        validatePin        : async (): Promise<string> => '1234',
        timeoutMs          : 5,
        pollIntervalMs     : 1,
      });

      expect(result).toBeUndefined();
      expect(fetchStub.callCount).toBeGreaterThan(1);
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
      // Messages.Read (unified: covers Read, Query, Subscribe) + Protocols.Query
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

    it('supports requesting `read`, `write`, and `delete` permissions', async () => {
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
        permissions : ['write', 'read', 'delete'],
      });

      expect(permissionRequests.protocolDefinition).toEqual(protocol);

      // Messages.Read (unified) + 3 requested Records permissions + Protocols.Query
      expect(permissionRequests.permissionScopes).toHaveLength(5);
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
        (scope) => scope.interface === DwnInterfaceName.Protocols && scope.method === DwnMethodName.Query
      )).toBeDefined();
      expect(ps.find(
        (scope) => scope.interface === DwnInterfaceName.Protocols && scope.method === DwnMethodName.Configure
      )).toBeUndefined();
      expect(ps.find(
        (scope) => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Query
      )).toBeUndefined();
      expect(ps.find(
        (scope) => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Subscribe
      )).toBeUndefined();
    });

    it('rejects unsupported runtime permission names', () => {
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

      for (const permission of ['query', 'subscribe', 'configure']) {
        expect(() => WalletConnect.createPermissionRequestForProtocol({
          definition  : protocol,
          permissions : [permission] as any,
        })).toThrow('Supported permissions: read, write, delete');
      }
    });
  });
});
