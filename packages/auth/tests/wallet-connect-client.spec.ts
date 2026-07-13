/**
 * Tests for `WalletConnect.initClient()` and `WalletConnect.createPermissionRequestForProtocol()`.
 *
 * `initClient` rides the `@enbox/connect` kernel (`ConnectClient` over
 * `RelayClientTransport`), so these tests run the full sealed-envelope
 * handshake against a stubbed relay: the fetch stub plays the relay's
 * `par`/`token` routes and the wallet side opens the sealed request and seals
 * a real response with `ConnectProvider`.
 */

import type { DwnProtocolDefinition } from '@enbox/agent';
import type { ConnectRequest, ConnectResponse } from '@enbox/connect';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { DidJwk } from '@enbox/dids';
import { Ed25519 } from '@enbox/crypto';
import { WalletConnect } from '../src/wallet-connect-client.js';
import { CONNECT_DENIED_TOKEN, ConnectProvider, parseWalletConnectUri, sealResponse } from '@enbox/connect';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

const providerDid = 'did:dht:provider789';
const connectServerUrl = 'https://relay.test/connect';
const walletUri = 'https://wallet.test/connect/app';
const relayRequestUri = 'https://relay.test/connect/authorize/req-1.jwt';
const pin = '1234';

const delegateGrants = [{ recordId: 'grant-1' }] as any;

/** Wallet-side behavior: receives the opened request, returns the relay `id_token` body. */
type WalletBehavior = (request: ConnectRequest) => Promise<string>;

type StubRelay = {
  /** Sealed request JWEs pushed to the relay `par` route. */
  parRequests: string[];
  /** Wallet URIs handed to `onWalletUriReady`. */
  walletUris: string[];
  /** Requests the wallet side successfully opened. */
  openedRequests: ConnectRequest[];
  /** The `onWalletUriReady` callback wired to the wallet behavior. */
  onWalletUriReady: (uri: string) => Promise<void>;
};

/**
 * Stubs `globalThis.fetch` with an in-memory relay (`par` + `token` routes)
 * and returns an `onWalletUriReady` callback that runs the wallet side:
 * parse the fragment, open the sealed request, and post the wallet
 * behavior's `id_token` for the client's token poll to collect.
 */
function stubRelay(wallet: WalletBehavior): StubRelay {
  const parRequests: string[] = [];
  const walletUris: string[] = [];
  const openedRequests: ConnectRequest[] = [];
  let tokenBody: string | undefined;

  sinon.stub(globalThis, 'fetch').callsFake(async (input: any, init?: any): Promise<Response> => {
    const url = String(input);

    if (url === `${connectServerUrl}/par` && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as { request: string };
      parRequests.push(body.request);
      return new Response(
        JSON.stringify({ request_uri: relayRequestUri, expires_in: 600 }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.startsWith(`${connectServerUrl}/token/`)) {
      if (tokenBody === undefined) {
        return new Response('pending', { status: 404 });
      }
      return new Response(tokenBody, { status: 200 });
    }

    throw new Error(`unexpected fetch in stubbed relay: ${url}`);
  });

  const onWalletUriReady = async (uri: string): Promise<void> => {
    walletUris.push(uri);
    const parsed = parseWalletConnectUri(uri);
    if (parsed === undefined) {
      throw new Error('wallet URI did not carry connect fragment params');
    }

    const request = await ConnectProvider.openRequest({
      jwe        : parRequests[parRequests.length - 1],
      decryption : { mode: 'dir', requestKey: parsed.encryptionKey },
    });
    openedRequests.push(request);
    tokenBody = await wallet(request);
  };

  return { parRequests, walletUris, openedRequests, onWalletUriReady };
}

/** Wallet behavior: approve with a wallet-minted delegate DID. */
function approveWithWalletMintedDelegate(
  options: { responsePin?: string } = {},
): { wallet: WalletBehavior; delegateUri: () => string } {
  let mintedDelegateUri = '';

  const wallet: WalletBehavior = async (request) => {
    const delegate = await DidJwk.create();
    mintedDelegateUri = delegate.uri;
    return await ConnectProvider.sealApprovedResponse({
      request,
      providerDid,
      approval: {
        delegateDid         : delegate.uri,
        delegatePortableDid : await delegate.export(),
        delegateGrants,
        sessionRevocations  : [{ grantId: 'grant-1', revocationGrantId: 'revoke-1' }],
      },
      signer : delegate,
      pin    : options.responsePin ?? pin,
    });
  };

  return { wallet, delegateUri: (): string => mintedDelegateUri };
}

/** Wallet behavior: approve grants to the request's pre-supplied delegate DID. */
const approveWithPreSuppliedDelegate: WalletBehavior = async (request) => {
  return await ConnectProvider.sealApprovedResponse({
    request,
    providerDid,
    approval: {
      delegateDid        : request.delegateDid!,
      delegateGrants,
      sessionRevocations : [],
    },
    signer: await DidJwk.create(),
    pin,
  });
};

/** Wallet behavior: seal a hand-built (guard-bypassing) response payload. */
function sealRawResponse(build: (request: ConnectRequest) => Partial<ConnectResponse>): WalletBehavior {
  return async (request) => {
    const iat = Math.floor(Date.now() / 1000);
    const response: ConnectResponse = {
      providerDid,
      delegateDid        : 'did:jwk:wallet-delegate',
      aud                : request.clientDid,
      iat,
      exp                : iat + 600,
      nonce              : request.nonce,
      state              : request.state,
      delegateGrants,
      sessionRevocations : [],
      ...build(request),
    };
    return await sealResponse({
      response,
      signer      : await DidJwk.create(),
      responseKey : request.responseKey,
      pin,
    });
  };
}

describe('WalletConnect', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('initClient — relay flow', () => {
    it('should complete the full relay flow and return delegate info', async () => {
      const minted = approveWithWalletMintedDelegate();
      const relay = stubRelay(minted.wallet);
      const pinPrompts: number[] = [];

      const result = await WalletConnect.initClient({
        displayName                : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests         : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady           : relay.onWalletUriReady,
        validatePin                : async (): Promise<string> => { pinPrompts.push(1); return pin; },
        requestedSessionTtlSeconds : 2_592_000,
        pollIntervalMs             : 1,
      });

      // Verify result shape.
      expect(result).toBeDefined();
      expect(result!.connectedDid).toBe(providerDid);
      expect(result!.delegatePortableDid.uri).toBe(minted.delegateUri());
      expect(result!.delegateGrants).toHaveLength(1);
      expect(result!.sessionRevocations).toEqual([{ grantId: 'grant-1', revocationGrantId: 'revoke-1' }]);
      expect(pinPrompts).toHaveLength(1);

      // The wallet-side request carried the client fields.
      expect(relay.openedRequests).toHaveLength(1);
      const request = relay.openedRequests[0];
      expect(request.appName).toBe('Sample App');
      expect(request.requestedSessionTtlSeconds).toBe(2_592_000);
      expect(request.delegateDid).toBeUndefined();
      expect(request.reply).toEqual({ mode: 'direct_post', callbackUrl: `${connectServerUrl}/callback` });
      expect(request.responseKey.crv).toBe('X25519');

      // The relay saw ciphertext only: the pushed request is a 5-segment
      // Compact JWE, and the fragment key never rides in a query string.
      expect(relay.parRequests[0].split('.')).toHaveLength(5);
      expect(relay.walletUris).toHaveLength(1);
      const uri = new URL(relay.walletUris[0]);
      expect(uri.search).toBe('');
      const parsed = parseWalletConnectUri(relay.walletUris[0]);
      expect(parsed?.requestUri).toBe(relayRequestUri);
      expect(parsed?.encryptionKey).toHaveLength(32);
    });

    it('should request grants to a locally generated delegate DID when pre-supply is enabled', async () => {
      const relay = stubRelay(approveWithPreSuppliedDelegate);

      const result = await WalletConnect.initClient({
        displayName          : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests   : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady     : relay.onWalletUriReady,
        validatePin          : async (): Promise<string> => pin,
        preSupplyDelegateDid : true,
        pollIntervalMs       : 1,
      });

      const requestedDelegateDid = relay.openedRequests[0].delegateDid;
      expect(requestedDelegateDid?.startsWith('did:jwk:')).toBe(true);
      expect(result?.delegatePortableDid.uri).toBe(requestedDelegateDid!);
      expect(result?.delegatePortableDid.privateKeys?.some((key) => key.crv === 'X25519')).toBe(true);
    });

    it('should reject refresh before generating a new delegate DID', async () => {
      const createDelegate = sinon.stub(DidJwk, 'create');

      await expect(WalletConnect.initClient({
        displayName          : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests   : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady     : (): void => {},
        validatePin          : async (): Promise<string> => pin,
        preSupplyDelegateDid : true,
        requestType          : 'refresh',
      })).rejects.toThrow('refresh requests require an existing `delegatePortableDid`');

      expect(createDelegate.called).toBe(false);
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
      sinon.stub(Ed25519, 'convertPrivateKeyToX25519').callsFake(async ({ privateKey }: any): Promise<any> => {
        expect(privateKey.crv).toBe('Ed25519');
        return { kty: 'OKP', crv: 'X25519', d: 'x-private', x: 'x-public' };
      });
      const relay = stubRelay(approveWithPreSuppliedDelegate);

      const result = await WalletConnect.initClient({
        displayName        : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady   : relay.onWalletUriReady,
        validatePin        : async (): Promise<string> => pin,
        delegatePortableDid,
        requestType        : 'refresh',
        pollIntervalMs     : 1,
      });

      expect(relay.openedRequests[0].delegateDid).toBe('did:jwk:local-delegate');
      expect(relay.openedRequests[0].requestType).toBe('refresh');
      expect(result?.delegatePortableDid.privateKeys?.map((key) => key.crv)).toEqual(['P-256', 'Ed25519', 'X25519']);
    });

    it('should reject a caller-supplied delegate DID without an Ed25519 private key', async () => {
      await expect(WalletConnect.initClient({
        displayName         : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests  : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady    : (): void => {},
        validatePin         : async (): Promise<string> => pin,
        delegatePortableDid : {
          uri         : 'did:jwk:local-delegate',
          document    : {},
          metadata    : {},
          privateKeys : [{ kty: 'EC', crv: 'P-256', d: 'p256-private', x: 'p256-x', y: 'p256-y' }],
        },
      })).rejects.toThrow('Delegate portable DID must include an Ed25519 private key.');
    });

    it('should reject a wallet response for a different delegate DID when pre-supply is enabled', async () => {
      const relay = stubRelay(sealRawResponse(() => ({ delegateDid: 'did:jwk:other-delegate' })));

      await expect(WalletConnect.initClient({
        displayName          : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests   : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady     : relay.onWalletUriReady,
        validatePin          : async (): Promise<string> => pin,
        preSupplyDelegateDid : true,
        pollIntervalMs       : 1,
      })).rejects.toThrow('wallet returned delegate DID \'did:jwk:other-delegate\'');
      expect(relay.openedRequests[0].delegateDid?.startsWith('did:jwk:')).toBe(true);
    });

    it('should reject a wallet-minted response that omits delegatePortableDid', async () => {
      const relay = stubRelay(sealRawResponse(() => ({})));

      await expect(WalletConnect.initClient({
        displayName        : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady   : relay.onWalletUriReady,
        validatePin        : async (): Promise<string> => pin,
        pollIntervalMs     : 1,
      })).rejects.toThrow('Connect: wallet response omitted `delegatePortableDid`.');
    });

    it('should fail closed when the user enters the wrong PIN', async () => {
      // The response is sealed with the wallet's PIN; a different PIN on the
      // client derives a different CEK and the AEAD tag check fails — the
      // PIN itself never transits the relay.
      const minted = approveWithWalletMintedDelegate({ responsePin: '9999' });
      const relay = stubRelay(minted.wallet);

      await expect(WalletConnect.initClient({
        displayName        : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady   : relay.onWalletUriReady,
        validatePin        : async (): Promise<string> => pin,
        pollIntervalMs     : 1,
      })).rejects.toThrow();
    });

    it('should return undefined without prompting for a PIN when the wallet explicitly denies access', async () => {
      const relay = stubRelay(async (): Promise<string> => CONNECT_DENIED_TOKEN);
      const validatePin = sinon.stub<[], Promise<string>>().resolves(pin);

      const result = await WalletConnect.initClient({
        displayName        : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady   : relay.onWalletUriReady,
        validatePin,
        pollIntervalMs     : 1,
      });

      expect(result).toBeUndefined();
      expect(validatePin.called).toBe(false);
    });

    it('should await wallet URI handling before polling for the response', async () => {
      let callbackComplete = false;
      const relay = stubRelay(async (): Promise<string> => {
        await new Promise((resolve): void => { setTimeout(resolve, 0); });
        callbackComplete = true;
        return CONNECT_DENIED_TOKEN;
      });

      const result = await WalletConnect.initClient({
        displayName        : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady   : relay.onWalletUriReady,
        validatePin        : async (): Promise<string> => pin,
        pollIntervalMs     : 1,
      });

      // The wallet behavior (running inside `onWalletUriReady`) finished
      // before the first token poll could observe a response.
      expect(callbackComplete).toBe(true);
      expect(result).toBeUndefined();
    });

    it('should reject when polling exceeds the custom timeout', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onFirstCall().resolves(
        new Response(JSON.stringify({ request_uri: relayRequestUri, expires_in: 600 }), {
          status  : 201,
          headers : { 'Content-Type': 'application/json' },
        })
      );
      fetchStub.callsFake(async (): Promise<Response> => new Response('Not Found', { status: 404 }));

      await expect(WalletConnect.initClient({
        displayName        : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady   : (): void => {},
        validatePin        : async (): Promise<string> => pin,
        timeoutMs          : 5,
        pollIntervalMs     : 1,
      })).rejects.toThrow('timed out');
      expect(fetchStub.callCount).toBeGreaterThan(1);
    });

    it('should throw when the pushed authorization request is rejected', async () => {
      sinon.stub(globalThis, 'fetch').resolves(
        new Response('Bad Request', { status: 400, statusText: 'Bad Request' })
      );

      await expect(WalletConnect.initClient({
        displayName        : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests : [{ protocolDefinition: {} as any, permissionScopes: [] as any }],
        onWalletUriReady   : (): void => {},
        validatePin        : async (): Promise<string> => pin,
      })).rejects.toThrow('Connect: pushed authorization request failed with HTTP 400.');
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
      expect(permissionRequests.permissionScopes).toHaveLength(2);
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
      expect(permissionRequests.permissionScopes).toHaveLength(4);
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
