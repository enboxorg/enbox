/**
 * Tests for `WalletConnect.initClient()` and `WalletConnect.createPermissionRequestForModule()`.
 *
 * `initClient` rides the `@enbox/connect` kernel (`ConnectClient` over
 * `RelayClientTransport`), so these tests run the full sealed-envelope
 * handshake against a stubbed relay: the fetch stub plays the relay's
 * `par`/`token` routes and the wallet side opens the sealed request and seals
 * a real response with `ConnectProvider`.
 */

import type { DwnModuleDefinition } from '@enbox/agent';
import type { Jwk } from '@enbox/crypto';
import type { WalletConnectClientOptions } from '../src/wallet-connect-client.js';
import type { ConnectRequest, ConnectResponse, ConnectVerificationSymbol } from '@enbox/connect';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { DidJwk } from '@enbox/dids';
import { WalletConnect } from '../src/wallet-connect-client.js';
import {
  CONNECT_DENIED_TOKEN,
  ConnectProvider,
  createConnectVerificationHandshake,
  createOwnerAuthenticationProof,
  parseWalletConnectUri,
  randomToken,
  sealResponse,
} from '@enbox/connect';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';
import { Ed25519, X25519 } from '@enbox/crypto';

const providerDid = 'did:dht:provider789';
const connectServerUrl = 'https://relay.test/connect';
const walletUri = 'https://wallet.test/connect/app';
const relayRequestUri = 'https://relay.test/connect/authorize/req-1.jwt';

const TestModuleDefinition = {
  module    : 'https://example.com/modules/wallet-connect-test',
  published : false,
  types     : {},
  structure : {},
} satisfies DwnModuleDefinition;

const delegateGrants = [{ recordId: 'grant-1' }] as any;

type WalletOutcome = {
  idToken: string;
  handshakeKey?: Jwk;
  symbols?: readonly ConnectVerificationSymbol[];
};

/** Wallet-side behavior: receives the opened request + raw JWE, returns the relay token and optional SAS handshake key. */
type WalletBehavior = (request: ConnectRequest, requestJwe: string) => Promise<WalletOutcome>;

type StubRelay = {
  /** Sealed request JWEs pushed to the relay `par` route. */
  parRequests: string[];
  /** Wallet URIs handed to `onWalletUriReady`. */
  walletUris: string[];
  /** Requests the wallet side successfully opened. */
  openedRequests: ConnectRequest[];
  /** Verification symbols derived on the wallet side, when a SAS handshake ran. */
  walletSymbols: () => readonly ConnectVerificationSymbol[] | undefined;
  /** The `onWalletUriReady` callback wired to the wallet behavior. */
  onWalletUriReady: (uri: string) => Promise<void>;
};

/**
 * Stubs `globalThis.fetch` with an in-memory relay (`par` + `handshake` + `token` routes)
 * and returns an `onWalletUriReady` callback that runs the wallet side:
 * parse the fragment, open the sealed request, publish the SAS handshake key,
 * and post the wallet behavior's `id_token` for the client's token poll to collect.
 */
function stubRelay(wallet: WalletBehavior): StubRelay {
  const parRequests: string[] = [];
  const walletUris: string[] = [];
  const openedRequests: ConnectRequest[] = [];
  let tokenBody: string | undefined;
  let handshakeKey: Jwk | undefined;
  let derivedSymbols: readonly ConnectVerificationSymbol[] | undefined;

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

    if (url.startsWith(`${connectServerUrl}/handshake/`)) {
      if (handshakeKey === undefined) {
        return new Response(JSON.stringify({ ready: false }), {
          status  : 200,
          headers : { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ready: true, walletEpk: handshakeKey }), {
        status  : 200,
        headers : { 'Content-Type': 'application/json' },
      });
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

    const requestJwe = parRequests[parRequests.length - 1];
    const request = await ConnectProvider.openRequest({
      jwe        : requestJwe,
      decryption : { mode: 'dir', requestKey: parsed.encryptionKey },
    });
    openedRequests.push(request);
    const outcome = await wallet(request, requestJwe);
    handshakeKey = outcome.handshakeKey;
    derivedSymbols = outcome.symbols;
    tokenBody = outcome.idToken;
  };

  return {
    parRequests,
    walletUris,
    openedRequests,
    walletSymbols: (): readonly ConnectVerificationSymbol[] | undefined => derivedSymbols,
    onWalletUriReady,
  };
}

/** Wallet behavior: approve with a wallet-minted delegate DID. */
function approveWithWalletMintedDelegate(
  options: { responseHandshakeKey?: Jwk } = {},
): { wallet: WalletBehavior; delegateUri: () => string } {
  let mintedDelegateUri = '';

  const wallet: WalletBehavior = async (request, requestJwe) => {
    const handshake = await createConnectVerificationHandshake({ request, requestJwe });
    const delegate = await DidJwk.create();
    mintedDelegateUri = delegate.uri;
    const idToken = await ConnectProvider.sealApprovedResponse({
      request,
      providerDid,
      approval: {
        delegateDid         : delegate.uri,
        delegatePortableDid : await delegate.export(),
        delegateGrants,
        sessionRevocations  : [{ grantId: 'grant-1', revocationGrantId: 'revoke-1' }],
      },
      signer       : delegate,
      handshakeKey : options.responseHandshakeKey ?? handshake.walletEpk,
    });
    return { idToken, handshakeKey: handshake.walletEpk, symbols: handshake.symbols };
  };

  return { wallet, delegateUri: (): string => mintedDelegateUri };
}

/** Wallet behavior: approve grants to the request's pre-supplied delegate DID. */
const approveWithPreSuppliedDelegate: WalletBehavior = async (request, requestJwe) => {
  const handshake = await createConnectVerificationHandshake({ request, requestJwe });
  const idToken = await ConnectProvider.sealApprovedResponse({
    request,
    providerDid,
    approval: {
      delegateDid        : request.delegateDid!,
      delegateGrants,
      sessionRevocations : [],
    },
    signer       : await DidJwk.create(),
    handshakeKey : handshake.walletEpk,
  });
  return { idToken, handshakeKey: handshake.walletEpk, symbols: handshake.symbols };
};

/** Wallet behavior: seal a hand-built (guard-bypassing) response payload. */
function sealRawResponse(build: (request: ConnectRequest) => Partial<ConnectResponse>): WalletBehavior {
  return async (request, requestJwe) => {
    const handshake = await createConnectVerificationHandshake({ request, requestJwe });
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
    const idToken = await sealResponse({
      response,
      signer       : await DidJwk.create(),
      responseKey  : request.responseKey,
      handshakeKey : handshake.walletEpk,
    });
    return { idToken, handshakeKey: handshake.walletEpk, symbols: handshake.symbols };
  };
}

describe('WalletConnect', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('owner authentication', () => {
    it('returns verified identity-only completion without delegate credentials or requested modules', async () => {
      const owner = await DidJwk.create();
      const authentication = { version: 1 as const, audience: 'https://login.example/', challenge: randomToken() };
      const relay = stubRelay(async (request, requestJwe) => {
        const handshake = await createConnectVerificationHandshake({ request, requestJwe });
        const idToken = await ConnectProvider.sealAuthenticationResponse({
          request, providerDid  : owner.uri,
          approval     : { authenticationProof: await createOwnerAuthenticationProof({ request, owner }) },
          signer       : await DidJwk.create(), handshakeKey : handshake.walletEpk,
        });
        return { idToken, handshakeKey: handshake.walletEpk, symbols: handshake.symbols };
      });
      let registered: Readonly<ConnectRequest> | undefined;
      const result = await WalletConnect.initAuthentication({
        displayName             : 'OAuth sign-in', walletUri, connectServerUrl, authentication,
        expectedProviderDid     : owner.uri, onWalletUriReady        : relay.onWalletUriReady,
        onVerificationReady     : (): void => {},
        pollIntervalMs          : 1,
        onAuthenticationRequest : async (request): Promise<void> => {
          expect(relay.parRequests).toHaveLength(0);
          registered = request;
        },
      });
      expect(result?.connectedDid).toBe(owner.uri);
      expect(result?.authentication.subject).toBe(owner.uri);
      expect(result?.authentication.challenge).toBe(authentication.challenge);
      expect(Object.keys(result!).sort()).toEqual(['authentication', 'connectedDid']);
      expect(relay.openedRequests[0].requestType).toBe('authenticate');
      expect(relay.openedRequests[0].permissionRequests).toEqual([]);
      expect(relay.openedRequests[0].delegateDid).toBeUndefined();
      expect(relay.openedRequests[0].requestedSessionTtlSeconds).toBeUndefined();
      expect(JSON.parse(JSON.stringify(registered))).toEqual(relay.openedRequests[0]);
    });

    it('does not deliver an authentication request when durable service registration fails', async () => {
      const relay = stubRelay(async () => { throw new Error('The wallet must not receive an unregistered request'); });
      await expect(WalletConnect.initAuthentication({
        displayName             : 'OAuth sign-in', walletUri, connectServerUrl,
        authentication          : { version: 1, audience: 'https://login.example/', challenge: randomToken() },
        onWalletUriReady        : relay.onWalletUriReady,
        onVerificationReady     : (): void => {},
        onAuthenticationRequest : async (): Promise<void> => { throw new Error('Registration unavailable'); },
      })).rejects.toThrow('Registration unavailable');
      expect(relay.parRequests).toHaveLength(0);
      expect(relay.openedRequests).toHaveLength(0);
    });

    it('retains verified owner authentication alongside approved data grants', async () => {
      const owner = await DidJwk.create();
      const authentication = { version: 1 as const, audience: 'https://login.example/', challenge: randomToken() };
      const relay = stubRelay(async (request, requestJwe) => {
        const handshake = await createConnectVerificationHandshake({ request, requestJwe });
        const delegate = await DidJwk.create();
        const idToken = await ConnectProvider.sealApprovedResponse({
          request, providerDid  : owner.uri, signer       : delegate, handshakeKey : handshake.walletEpk,
          approval     : {
            delegateDid         : delegate.uri, delegatePortableDid : await delegate.export(), delegateGrants, sessionRevocations  : [],
            authenticationProof : await createOwnerAuthenticationProof({ request, owner }),
          },
        });
        return { idToken, handshakeKey: handshake.walletEpk, symbols: handshake.symbols };
      });
      const result = await WalletConnect.initClient({
        displayName         : 'OAuth and data', walletUri, connectServerUrl, authentication,
        permissionRequests  : [{ moduleDefinition: TestModuleDefinition, permissionScopes: [] }],
        onWalletUriReady    : relay.onWalletUriReady,
        onVerificationReady : (): void => {},
        pollIntervalMs      : 1,
      });
      expect(result?.authentication?.subject).toBe(owner.uri);
      expect(result?.authentication?.proof.split('.')).toHaveLength(3);
      expect(result?.delegateGrants).toHaveLength(1);
    });

    it('fails closed when an old wallet omits the requested owner proof', async () => {
      const legacy = approveWithWalletMintedDelegate();
      const relay = stubRelay(async (request, requestJwe) => legacy.wallet({ ...request, authentication: undefined }, requestJwe));
      await expect(WalletConnect.initClient({
        displayName         : 'OAuth and data', walletUri, connectServerUrl,
        authentication      : { version: 1, audience: 'https://login.example/', challenge: randomToken() },
        permissionRequests  : [{ moduleDefinition: TestModuleDefinition, permissionScopes: [] }],
        onWalletUriReady    : relay.onWalletUriReady,
        onVerificationReady : (): void => {},
        pollIntervalMs      : 1,
      })).rejects.toThrow();
    });

    it('handles wallet denial and rejects identity-only requests through the data adapter', async () => {
      const relay = stubRelay(async () => ({ idToken: CONNECT_DENIED_TOKEN }));
      const common = {
        displayName         : 'OAuth sign-in', walletUri, connectServerUrl,
        authentication      : { version: 1 as const, audience: 'https://login.example/', challenge: randomToken() },
        onWalletUriReady    : relay.onWalletUriReady,
        onVerificationReady : (): void => {},
        pollIntervalMs      : 1,
      };
      expect(await WalletConnect.initAuthentication(common)).toBeUndefined();
      const before = relay.parRequests.length;
      await expect(WalletConnect.initClient({ ...common, requestType: 'authenticate', permissionRequests: [] } as WalletConnectClientOptions))
        .rejects.toThrow('initAuthentication');
      expect(relay.parRequests).toHaveLength(before);
    });
  });

  describe('initClient — relay flow', () => {
    it('should complete the full relay flow and surface matching SAS verification symbols', async () => {
      const minted = approveWithWalletMintedDelegate();
      const relay = stubRelay(minted.wallet);
      const observedSymbols: Array<readonly ConnectVerificationSymbol[]> = [];

      const result = await WalletConnect.initClient({
        displayName                : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests         : [{ moduleDefinition: TestModuleDefinition, permissionScopes: [] }],
        onWalletUriReady           : relay.onWalletUriReady,
        onVerificationReady        : (symbols): void => { observedSymbols.push(symbols); },
        applicationId              : 'com.example.test',
        requestedSessionTtlSeconds : 2_592_000,
        pollIntervalMs             : 1,
      });

      // Verify result shape.
      expect(result).toBeDefined();
      expect(result!.connectedDid).toBe(providerDid);
      expect(result!.delegatePortableDid.uri).toBe(minted.delegateUri());
      expect(result!.delegateGrants).toHaveLength(1);
      expect(result!.sessionRevocations).toEqual([{ grantId: 'grant-1', revocationGrantId: 'revoke-1' }]);
      expect(observedSymbols).toHaveLength(1);
      expect(observedSymbols[0]).toEqual(relay.walletSymbols()!);

      // The wallet-side request carried the client fields.
      expect(relay.openedRequests).toHaveLength(1);
      const request = relay.openedRequests[0];
      expect(request.appName).toBe('Sample App');
      expect(request.requestedSessionTtlSeconds).toBe(2_592_000);
      expect(request.applicationId).toBe('com.example.test');
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
        permissionRequests   : [{ moduleDefinition: TestModuleDefinition, permissionScopes: [] }],
        onWalletUriReady     : relay.onWalletUriReady,
        onVerificationReady  : (): void => {},
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
        permissionRequests   : [{ moduleDefinition: TestModuleDefinition, permissionScopes: [] }],
        onWalletUriReady     : (): void => {},
        onVerificationReady  : (): void => {},
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
        displayName         : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests  : [{ moduleDefinition: TestModuleDefinition, permissionScopes: [] }],
        onWalletUriReady    : relay.onWalletUriReady,
        onVerificationReady : (): void => {},
        delegatePortableDid,
        requestType         : 'refresh',
        expectedProviderDid : providerDid,
        pollIntervalMs      : 1,
      });

      expect(relay.openedRequests[0].delegateDid).toBe('did:jwk:local-delegate');
      expect(relay.openedRequests[0].requestType).toBe('refresh');
      expect(relay.openedRequests[0].expectedProviderDid).toBe(providerDid);
      expect(result?.delegatePortableDid.privateKeys?.map((key) => key.crv)).toEqual(['P-256', 'Ed25519', 'X25519']);
    });

    it('should reject a caller-supplied delegate DID without an Ed25519 private key', async () => {
      await expect(WalletConnect.initClient({
        displayName         : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests  : [{ moduleDefinition: TestModuleDefinition, permissionScopes: [] }],
        onWalletUriReady    : (): void => {},
        onVerificationReady : (): void => {},
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
        permissionRequests   : [{ moduleDefinition: TestModuleDefinition, permissionScopes: [] }],
        onWalletUriReady     : relay.onWalletUriReady,
        onVerificationReady  : (): void => {},
        preSupplyDelegateDid : true,
        pollIntervalMs       : 1,
      })).rejects.toThrow('wallet returned delegate DID \'did:jwk:other-delegate\'');
      expect(relay.openedRequests[0].delegateDid?.startsWith('did:jwk:')).toBe(true);
    });

    it('should reject a wallet-minted response that omits delegatePortableDid', async () => {
      const relay = stubRelay(sealRawResponse(() => ({})));

      await expect(WalletConnect.initClient({
        displayName         : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests  : [{ moduleDefinition: TestModuleDefinition, permissionScopes: [] }],
        onWalletUriReady    : relay.onWalletUriReady,
        onVerificationReady : (): void => {},
        pollIntervalMs      : 1,
      })).rejects.toThrow('Connect: wallet response omitted `delegatePortableDid`.');
    });

    it('should fail closed when the response apv does not match the handshake key', async () => {
      const rogueKey = await X25519.generateKey();
      const minted = approveWithWalletMintedDelegate({
        responseHandshakeKey: { kty: 'OKP', crv: 'X25519', x: rogueKey.x },
      });
      const relay = stubRelay(minted.wallet);

      await expect(WalletConnect.initClient({
        displayName         : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests  : [{ moduleDefinition: TestModuleDefinition, permissionScopes: [] }],
        onWalletUriReady    : relay.onWalletUriReady,
        onVerificationReady : (): void => {},
        pollIntervalMs      : 1,
      })).rejects.toThrow('"apv"');
    });

    it('should return undefined without surfacing verification symbols when the wallet explicitly denies access', async () => {
      const relay = stubRelay(async (): Promise<WalletOutcome> => ({ idToken: CONNECT_DENIED_TOKEN }));
      const onVerificationReady = sinon.stub();

      const result = await WalletConnect.initClient({
        displayName        : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests : [{ moduleDefinition: TestModuleDefinition, permissionScopes: [] }],
        onWalletUriReady   : relay.onWalletUriReady,
        onVerificationReady,
        pollIntervalMs     : 1,
      });

      expect(result).toBeUndefined();
      expect(onVerificationReady.called).toBe(false);
    });

    it('should await wallet URI handling before polling for the response', async () => {
      let callbackComplete = false;
      const relay = stubRelay(async (): Promise<WalletOutcome> => {
        await new Promise((resolve): void => { setTimeout(resolve, 0); });
        callbackComplete = true;
        return { idToken: CONNECT_DENIED_TOKEN };
      });

      const result = await WalletConnect.initClient({
        displayName         : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests  : [{ moduleDefinition: TestModuleDefinition, permissionScopes: [] }],
        onWalletUriReady    : relay.onWalletUriReady,
        onVerificationReady : (): void => {},
        pollIntervalMs      : 1,
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
      fetchStub.callsFake(async (input: any): Promise<Response> => {
        if (String(input).includes('/handshake/')) {
          return new Response(JSON.stringify({ ready: false }), { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      });

      await expect(WalletConnect.initClient({
        displayName         : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests  : [{ moduleDefinition: TestModuleDefinition, permissionScopes: [] }],
        onWalletUriReady    : (): void => {},
        onVerificationReady : (): void => {},
        timeoutMs           : 5,
        pollIntervalMs      : 1,
      })).rejects.toThrow('timed out');
      expect(fetchStub.callCount).toBeGreaterThan(1);
    });

    it('should throw when the pushed authorization request is rejected', async () => {
      sinon.stub(globalThis, 'fetch').resolves(
        new Response('Bad Request', { status: 400, statusText: 'Bad Request' })
      );

      await expect(WalletConnect.initClient({
        displayName         : 'Sample App',
        walletUri,
        connectServerUrl,
        permissionRequests  : [{ moduleDefinition: TestModuleDefinition, permissionScopes: [] }],
        onWalletUriReady    : (): void => {},
        onVerificationReady : (): void => {},
      })).rejects.toThrow('Connect: pushed authorization request failed with HTTP 400.');
    });
  });

  describe('createPermissionRequestForModule', () => {
    it('should add sync permissions to all requests', async () => {
      const module: DwnModuleDefinition = {
        published : true,
        module    : 'https://exmaple.org/modules/social',
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

      const permissionRequests = WalletConnect.createPermissionRequestForModule({
        definition  : module,
        permissions : [],
      });

      expect(permissionRequests.moduleDefinition).toEqual(module);
      // Messages.Read (unified: covers Read, Query, Subscribe) + Modules.Query
      expect(permissionRequests.permissionScopes).toHaveLength(2);
      const scopes = permissionRequests.permissionScopes;
      expect(scopes.find(
        (scope) => scope.interface === DwnInterfaceName.Messages && scope.method === DwnMethodName.Read
      )).toBeDefined();
      expect(scopes.find(
        (scope) => scope.interface === DwnInterfaceName.Modules && scope.method === DwnMethodName.Query
      )).toBeDefined();
    });

    it('should add requested permissions to the request', async () => {
      const module: DwnModuleDefinition = {
        published : true,
        module    : 'https://exmaple.org/modules/social',
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

      const permissionRequests = WalletConnect.createPermissionRequestForModule({
        definition  : module,
        permissions : ['write', 'read'],
      });

      expect(permissionRequests.moduleDefinition).toEqual(module);

      // Messages.Read (unified) + 2 requested Records permissions + Modules.Query
      expect(permissionRequests.permissionScopes).toHaveLength(4);
      expect(permissionRequests.permissionScopes.find(
        (scope) => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Read
      )).toBeDefined();
      expect(permissionRequests.permissionScopes.find(
        (scope) => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Write
      )).toBeDefined();
    });

    it('supports requesting `read`, `write`, and `delete` permissions', async () => {
      const module: DwnModuleDefinition = {
        published : true,
        module    : 'https://exmaple.org/modules/social',
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

      const permissionRequests = WalletConnect.createPermissionRequestForModule({
        definition  : module,
        permissions : ['write', 'read', 'delete'],
      });

      expect(permissionRequests.moduleDefinition).toEqual(module);

      // Messages.Read (unified) + 3 requested Records permissions + Modules.Query
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
        (scope) => scope.interface === DwnInterfaceName.Modules && scope.method === DwnMethodName.Query
      )).toBeDefined();
      expect(ps.find(
        (scope) => scope.interface === DwnInterfaceName.Modules && scope.method === DwnMethodName.Configure
      )).toBeUndefined();
      expect(ps.find(
        (scope) => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Query
      )).toBeUndefined();
      expect(ps.find(
        (scope) => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Subscribe
      )).toBeUndefined();
    });

    it('rejects unsupported runtime permission names', () => {
      const module: DwnModuleDefinition = {
        published : true,
        module    : 'https://exmaple.org/modules/social',
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
        expect(() => WalletConnect.createPermissionRequestForModule({
          definition  : module,
          permissions : [permission] as any,
        })).toThrow('Supported permissions: read, write, delete');
      }
    });
  });
});
