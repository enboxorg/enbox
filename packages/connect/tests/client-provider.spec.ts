import type { ConnectVerificationSymbol } from '../src/sas.js';
import type { DataEncodedRecordsWriteMessage } from '@enbox/dwn-sdk-js';
import type { Jwk } from '@enbox/crypto';
import type {
  ConnectApproval,
  ConnectRequest,
  ConnectRequestProfile,
  ConnectTransport,
  ReplyDescriptor,
  WalletUriHandoff,
} from '../src/types.js';

import { createConnectVerificationHandshake } from '../src/sas.js';
import { DidJwk } from '@enbox/dids';
import { assertExpectedProviderDid, ConnectProvider } from '../src/provider.js';
import { ConnectClient, randomToken } from '../src/client.js';
import { CryptoUtils, X25519 } from '@enbox/crypto';
import { describe, expect, it } from 'bun:test';

const TEST_GRANTS = [
  { recordId: 'grant-1', encodedData: 'ZW5jb2RlZC1ncmFudC0x' },
  { recordId: 'grant-2', encodedData: 'ZW5jb2RlZC1ncmFudC0y' },
] as unknown as DataEncodedRecordsWriteMessage[];

const TEST_REVOCATIONS = [
  { grantId: 'grant-1', revocationGrantId: 'revocation-1' },
  { grantId: 'grant-2', revocationGrantId: 'revocation-2' },
];

type LoopbackWalletResult = {
  response: string;
  handshakeKey?: Jwk;
  handshakeKeys?: Jwk[];
};

/**
 * In-memory loopback transport: `deliverRequest` hands the sealed request
 * straight to a wallet handler which optionally yields a `handshakeKey`
 * (pre-approval SAS `walletEpk`) and the response ciphertext.
 */
class LoopbackTransport implements ConnectTransport {
  public readonly requiresHandshake: boolean;

  /** Number of best-effort completion signals received from the client. */
  public confirmCompleteCalls = 0;

  private readonly _profileFactory: () => Promise<Omit<ConnectRequestProfile, 'state'>>;
  private readonly _walletHandler: (jwe: string) => Promise<LoopbackWalletResult>;
  private _responsePromise?: Promise<LoopbackWalletResult>;

  constructor({ requiresHandshake, profileFactory, walletHandler }: {
    requiresHandshake: boolean;
    profileFactory: () => Promise<Omit<ConnectRequestProfile, 'state'>>;
    walletHandler: (jwe: string) => Promise<LoopbackWalletResult>;
  }) {
    this.requiresHandshake = requiresHandshake;
    this._profileFactory = profileFactory;
    this._walletHandler = walletHandler;
  }

  public async requestProfile(state: string): Promise<ConnectRequestProfile> {
    const profile = await this._profileFactory();
    return { ...profile, state };
  }

  public async deliverRequest(jwe: string): Promise<void | WalletUriHandoff> {
    this._responsePromise = this._walletHandler(jwe);
  }

  public async awaitResponse(options?: {
    onHandshake?: (walletEpk: Jwk) => Promise<void> | void;
  }): Promise<string> {
    if (this._responsePromise === undefined) {
      throw new Error('LoopbackTransport: no request delivered.');
    }
    const result = await this._responsePromise;
    const keys = result.handshakeKeys ?? (result.handshakeKey === undefined ? [] : [result.handshakeKey]);
    for (const key of keys) {
      await options?.onHandshake?.(key);
    }
    return result.response;
  }

  public async confirmComplete(): Promise<void> {
    this.confirmCompleteCalls += 1;
  }
}

/** Creates a loopback transport carrying the relay (dir + SAS handshake) profile. */
function createRelayLoopback(
  walletHandler: (jwe: string, requestKey: Uint8Array) => Promise<LoopbackWalletResult>,
): LoopbackTransport {
  let requestKey: Uint8Array;
  return new LoopbackTransport({
    requiresHandshake : true,
    profileFactory    : async (): Promise<Omit<ConnectRequestProfile, 'state'>> => {
      requestKey = CryptoUtils.randomBytes(32);
      const reply: ReplyDescriptor = { mode: 'direct_post', callbackUrl: 'https://relay.example/connect/callback' };
      return { encryption: { mode: 'dir', requestKey }, reply };
    },
    walletHandler: (jwe: string): Promise<LoopbackWalletResult> => walletHandler(jwe, requestKey),
  });
}

/** Simulates the wallet-side approval: opens the request, runs SAS handshake, and seals a minted-delegate response. */
async function approveWithMintedDelegate({ jwe, requestKey, providerDid, handshakeKeyOverride }: {
  jwe: string;
  requestKey: Uint8Array;
  providerDid: string;
  handshakeKeyOverride?: Jwk;
}): Promise<{
  responseJwe: string;
  request: ConnectRequest;
  delegateDid: string;
  handshakeKey: Jwk;
  symbols: readonly ConnectVerificationSymbol[];
}> {
  const request = await ConnectProvider.openRequest({ jwe, decryption: { mode: 'dir', requestKey } });
  const handshake = await createConnectVerificationHandshake({ request, requestJwe: jwe });

  const delegate = await DidJwk.create();
  const approval: ConnectApproval = {
    delegateDid         : delegate.uri,
    delegatePortableDid : await delegate.export(),
    delegateGrants      : TEST_GRANTS,
    sessionRevocations  : TEST_REVOCATIONS,
  };

  const responseJwe = await ConnectProvider.sealApprovedResponse({
    request,
    providerDid,
    approval,
    signer       : delegate,
    handshakeKey : handshakeKeyOverride ?? handshake.walletEpk,
  });

  return { responseJwe, request, delegateDid: delegate.uri, handshakeKey: handshake.walletEpk, symbols: handshake.symbols };
}

describe('ConnectClient + ConnectProvider (loopback)', () => {
  it('should snapshot connect and refresh inputs without retaining mutable caller state', async () => {
    const owner = await DidJwk.create();
    const delegate = await DidJwk.create();
    const portable = await delegate.export();
    for (const requestType of ['connect', 'refresh'] as const) {
      const metadata = { origin: 'https://approved.example' };
      const permissionRequests: ConnectRequest['permissionRequests'] = [{
        moduleDefinition : { module: 'https://approved.example/module', published: false, types: {}, structure: {} },
        permissionScopes : [{ interface: 'Records', method: 'Read', module: 'https://approved.example/module' }],
      }];
      const approvedPermissions = structuredClone(permissionRequests);
      const transport = createRelayLoopback(async (jwe, requestKey): Promise<LoopbackWalletResult> => {
        const request = await ConnectProvider.openRequest({ jwe, decryption: { mode: 'dir', requestKey } });
        const handshake = await createConnectVerificationHandshake({ request, requestJwe: jwe });
        expect(request.clientMetadata).toEqual({ origin: 'https://approved.example' });
        expect(request.permissionRequests).toEqual(approvedPermissions);
        expect(request.requestType).toBe(requestType);
        const response = await ConnectProvider.sealApprovedResponse({
          request,
          providerDid  : owner.uri,
          signer       : delegate,
          handshakeKey : handshake.walletEpk,
          approval     : {
            delegateDid        : delegate.uri,
            delegateGrants     : TEST_GRANTS,
            sessionRevocations : [],
            ...(requestType === 'refresh' ? {} : { delegatePortableDid: portable }),
          },
        });
        return { response, handshakeKey: handshake.walletEpk };
      });
      const client = new ConnectClient({ transport, onVerificationReady: (): void => {} });
      const options = {
        appName        : 'Snapshot application',
        requestType,
        clientMetadata : metadata,
        permissionRequests,
        ...(requestType === 'refresh' ? { delegatePortableDid: portable } : {}),
      };
      const pending = client.connect(options);
      metadata.origin = 'https://changed.example';
      permissionRequests[0].permissionScopes[0].module = 'https://changed.example/module';
      expect((await pending)?.connectedDid).toBe(owner.uri);
      expect(transport.confirmCompleteCalls).toBe(1);
    }
  });

  it('should complete a relay-profile handshake with matching pre-approval SAS verification symbols', async () => {
    const provider = await DidJwk.create();
    let observedRequest: ConnectRequest | undefined;
    let mintedDelegateDid: string | undefined;
    let walletSymbols: readonly ConnectVerificationSymbol[] | undefined;
    let appSymbols: readonly ConnectVerificationSymbol[] | undefined;

    const transport = createRelayLoopback(async (jwe, requestKey): Promise<LoopbackWalletResult> => {
      const approved = await approveWithMintedDelegate({ jwe, requestKey, providerDid: provider.uri });
      observedRequest = approved.request;
      mintedDelegateDid = approved.delegateDid;
      walletSymbols = approved.symbols;
      return { response: approved.responseJwe, handshakeKey: approved.handshakeKey };
    });

    const client = new ConnectClient({
      transport,
      onVerificationReady: (symbols): void => { appSymbols = symbols; },
    });

    const result = await client.connect({
      appName                    : 'Loopback App',
      appIcon                    : 'https://app.example/icon.png',
      applicationId              : 'https://app.example',
      clientMetadata             : { origin: 'https://app.example', platform: 'test' },
      permissionRequests         : [],
      requestedSessionTtlSeconds : 3600,
    });

    // Both sides independently derived the exact same 3 SAS symbols.
    expect(appSymbols).toBeDefined();
    expect(appSymbols).toEqual(walletSymbols);

    // The wallet saw the request the client built.
    expect(observedRequest).toBeDefined();
    expect(observedRequest!.appName).toBe('Loopback App');
    expect(observedRequest!.appIcon).toBe('https://app.example/icon.png');
    expect(observedRequest!.applicationId).toBe('https://app.example');
    expect(observedRequest!.clientMetadata).toEqual({ origin: 'https://app.example', platform: 'test' });
    expect(observedRequest!.requestedSessionTtlSeconds).toBe(3600);
    expect(observedRequest!.supportedDidMethods).toEqual(['did:dht', 'did:jwk']);
    expect(observedRequest!.reply).toEqual({ mode: 'direct_post', callbackUrl: 'https://relay.example/connect/callback' });
    expect(observedRequest!.delegateDid).toBeUndefined();

    // The client completed with the wallet-minted delegate credentials.
    expect(result).toBeDefined();
    expect(result!.connectedDid).toBe(provider.uri);
    expect(result!.delegatePortableDid.uri).toBe(mintedDelegateDid!);
    expect(result!.delegateGrants).toEqual(TEST_GRANTS);
    expect(result!.sessionRevocations).toEqual(TEST_REVOCATIONS);

    // The best-effort completion signal fired exactly once after the open.
    expect(transport.confirmCompleteCalls).toBe(1);
  });

  it('should complete a popup-profile handshake without a SAS handshake', async () => {
    const provider = await DidJwk.create();
    const walletOrigin = 'https://wallet.example';
    const walletEphemeral = await X25519.generateKey();
    const walletEpk: Jwk = { kty: 'OKP', crv: 'X25519', x: walletEphemeral.x };

    const transport = new LoopbackTransport({
      requiresHandshake : false,
      profileFactory    : async (): Promise<Omit<ConnectRequestProfile, 'state'>> => ({
        encryption : { mode: 'ecdh-es', walletEpk, walletOrigin },
        reply      : { mode: 'post_message' },
      }),
      walletHandler: async (jwe: string): Promise<LoopbackWalletResult> => {
        const request = await ConnectProvider.openRequest({
          jwe,
          decryption: { mode: 'ecdh-es', recipientPrivateKey: walletEphemeral, walletOrigin },
        });
        expect(request.reply).toEqual({ mode: 'post_message' });

        const delegate = await DidJwk.create();
        const response = await ConnectProvider.sealApprovedResponse({
          request,
          providerDid : provider.uri,
          approval    : {
            delegateDid         : delegate.uri,
            delegatePortableDid : await delegate.export(),
            delegateGrants      : TEST_GRANTS,
            sessionRevocations  : [],
          },
          signer: delegate,
        });
        return { response };
      },
    });

    const client = new ConnectClient({ transport });
    const result = await client.connect({ appName: 'Popup App', permissionRequests: [] });

    expect(result).toBeDefined();
    expect(result!.connectedDid).toBe(provider.uri);
    expect(result!.delegateGrants).toEqual(TEST_GRANTS);
    expect(result!.sessionRevocations).toEqual([]);
  });

  it('should honor a pre-supplied delegate and not expect key material back', async () => {
    const provider = await DidJwk.create();
    const localDelegate = await DidJwk.create();
    const localPortableDid = await localDelegate.export();

    const transport = createRelayLoopback(async (jwe, requestKey): Promise<LoopbackWalletResult> => {
      const request = await ConnectProvider.openRequest({ jwe, decryption: { mode: 'dir', requestKey } });
      const handshake = await createConnectVerificationHandshake({ request, requestJwe: jwe });
      expect(request.delegateDid).toBe(localDelegate.uri);
      expect(request.requestType).toBe('refresh');
      expect(request.expectedProviderDid).toBe(provider.uri);

      const responseSigner = await DidJwk.create();
      const response = await ConnectProvider.sealApprovedResponse({
        request,
        providerDid : provider.uri,
        approval    : {
          delegateDid        : localDelegate.uri,
          delegateGrants     : TEST_GRANTS,
          sessionRevocations : TEST_REVOCATIONS,
        },
        signer       : responseSigner,
        handshakeKey : handshake.walletEpk,
      });
      return { response, handshakeKey: handshake.walletEpk };
    });

    const client = new ConnectClient({ transport, onVerificationReady: (): void => {} });
    const result = await client.connect({
      appName             : 'Pre-supplied App',
      permissionRequests  : [],
      delegatePortableDid : localPortableDid,
      requestType         : 'refresh',
      expectedProviderDid : provider.uri,
    });

    expect(result).toBeDefined();
    expect(result!.delegatePortableDid).toEqual(localPortableDid);
    expect(result!.connectedDid).toBe(provider.uri);
  });

  it('should reject a refresh request without a pre-supplied delegate', async () => {
    const transport = createRelayLoopback(async (): Promise<LoopbackWalletResult> => ({ response: ConnectProvider.denyToken() }));
    const client = new ConnectClient({ transport, onVerificationReady: (): void => {} });

    await expect(client.connect({
      appName            : 'Invalid Refresh App',
      permissionRequests : [],
      requestType        : 'refresh',
    })).rejects.toThrow('refresh requests require an existing `delegatePortableDid`');
  });

  it('should require onVerificationReady when the transport requires a SAS handshake', () => {
    const transport = createRelayLoopback(async (): Promise<LoopbackWalletResult> => ({ response: ConnectProvider.denyToken() }));
    expect(() => new ConnectClient({ transport })).toThrow('onVerificationReady');
  });

  it('should reject a conflicting second handshake key from the transport (write-once)', async () => {
    const provider = await DidJwk.create();
    const rogueKey = await X25519.generateKey();
    const roguePublicKey: Jwk = { kty: 'OKP', crv: 'X25519', x: rogueKey.x };

    const transport = createRelayLoopback(async (jwe, requestKey): Promise<LoopbackWalletResult> => {
      const approved = await approveWithMintedDelegate({ jwe, requestKey, providerDid: provider.uri });
      return { response: approved.responseJwe, handshakeKeys: [approved.handshakeKey, roguePublicKey] };
    });

    const client = new ConnectClient({ transport, onVerificationReady: (): void => {} });
    await expect(client.connect({ appName: 'Conflicting Handshake App', permissionRequests: [] }))
      .rejects.toThrow('conflicting wallet handshake key');
  });

  it('should resolve undefined when the wallet denies the request without a handshake', async () => {
    const transport = createRelayLoopback(async (): Promise<LoopbackWalletResult> => ({ response: ConnectProvider.denyToken() }));

    let verificationFired = false;
    const client = new ConnectClient({
      transport,
      onVerificationReady: (): void => { verificationFired = true; },
    });
    const result = await client.connect({ appName: 'Denied App', permissionRequests: [] });

    expect(result).toBeUndefined();
    expect(verificationFired).toBe(false);
    expect(transport.confirmCompleteCalls).toBe(0);
  });

  it('should fail closed end-to-end when the response apv does not match the handshake walletEpk', async () => {
    const provider = await DidJwk.create();
    const attackerKey = await X25519.generateKey();
    const attackerPublicKey: Jwk = { kty: 'OKP', crv: 'X25519', x: attackerKey.x };

    const transport = createRelayLoopback(async (jwe, requestKey): Promise<LoopbackWalletResult> => {
      const approved = await approveWithMintedDelegate({
        jwe,
        requestKey,
        providerDid          : provider.uri,
        handshakeKeyOverride : attackerPublicKey,
      });
      return { response: approved.responseJwe, handshakeKey: approved.handshakeKey };
    });

    const client = new ConnectClient({ transport, onVerificationReady: (): void => {} });

    await expect(client.connect({ appName: 'Split-View Attack App', permissionRequests: [] })).rejects.toThrow('"apv"');
    expect(transport.confirmCompleteCalls).toBe(0);
  });

  it('should fail closed when a relay response arrives without a verified handshake', async () => {
    const provider = await DidJwk.create();
    const transport = createRelayLoopback(async (jwe, requestKey): Promise<LoopbackWalletResult> => {
      const approved = await approveWithMintedDelegate({ jwe, requestKey, providerDid: provider.uri });
      return { response: approved.responseJwe };
    });

    const client = new ConnectClient({ transport, onVerificationReady: (): void => {} });

    await expect(client.connect({ appName: 'Missing Handshake App', permissionRequests: [] }))
      .rejects.toThrow('without a verified wallet handshake');
    expect(transport.confirmCompleteCalls).toBe(0);
  });

  it('should reject when the wallet grants to a different delegate than requested', async () => {
    const provider = await DidJwk.create();
    const localDelegate = await DidJwk.create();

    const transport = createRelayLoopback(async (jwe, requestKey): Promise<LoopbackWalletResult> => {
      const request = await ConnectProvider.openRequest({ jwe, decryption: { mode: 'dir', requestKey } });
      const handshake = await createConnectVerificationHandshake({ request, requestJwe: jwe });

      // A misbehaving wallet ignores the request-supplied delegate. Bypass the
      // provider's own guard by lying about the request's `delegateDid`.
      const rogueDelegate = await DidJwk.create();
      const response = await ConnectProvider.sealApprovedResponse({
        request      : { ...request, delegateDid: rogueDelegate.uri },
        providerDid  : provider.uri,
        approval     : { delegateDid: rogueDelegate.uri, delegateGrants: TEST_GRANTS, sessionRevocations: [] },
        signer       : rogueDelegate,
        handshakeKey : handshake.walletEpk,
      });
      return { response, handshakeKey: handshake.walletEpk };
    });

    const client = new ConnectClient({ transport, onVerificationReady: (): void => {} });

    await expect(client.connect({
      appName             : 'Delegate Mismatch App',
      permissionRequests  : [],
      delegatePortableDid : await localDelegate.export(),
    })).rejects.toThrow('Revoke the just-approved session');
  });

  it('should reject when a wallet-minted response omits the portable delegate DID', async () => {
    const provider = await DidJwk.create();

    const transport = createRelayLoopback(async (jwe, requestKey): Promise<LoopbackWalletResult> => {
      const request = await ConnectProvider.openRequest({ jwe, decryption: { mode: 'dir', requestKey } });
      const handshake = await createConnectVerificationHandshake({ request, requestJwe: jwe });

      // Bypass the provider guard by pretending the request pre-supplied the delegate.
      const delegate = await DidJwk.create();
      const response = await ConnectProvider.sealApprovedResponse({
        request      : { ...request, delegateDid: delegate.uri },
        providerDid  : provider.uri,
        approval     : { delegateDid: delegate.uri, delegateGrants: TEST_GRANTS, sessionRevocations: [] },
        signer       : delegate,
        handshakeKey : handshake.walletEpk,
      });
      return { response, handshakeKey: handshake.walletEpk };
    });

    const client = new ConnectClient({ transport, onVerificationReady: (): void => {} });

    await expect(client.connect({ appName: 'Missing Portable App', permissionRequests: [] }))
      .rejects.toThrow('omitted `delegatePortableDid`');
  });

  describe('randomToken', () => {
    it('should return distinct 16-byte base64url tokens', () => {
      const first = randomToken();
      const second = randomToken();

      expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(second).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(first).not.toBe(second);
    });
  });

  describe('ConnectProvider approval guards', () => {
    it('should reject authentication and delegation approvals used with the wrong request', async () => {
      const client = await DidJwk.create();
      const owner = await DidJwk.create();
      const delegate = await DidJwk.create();
      const responsePrivateKey = await X25519.generateKey();
      const request: ConnectRequest = {
        clientDid           : client.uri, appName             : 'Authentication guards', permissionRequests  : [], supportedDidMethods : ['did:jwk'],
        nonce               : randomToken(), state               : randomToken(), responseKey         : { kty: 'OKP', crv: 'X25519', x: responsePrivateKey.x },
        reply               : { mode: 'post_message' },
        authentication      : { version: 1, audience: 'https://identity.example', challenge: randomToken() },
      };
      const approval: ConnectApproval = {
        delegateDid: delegate.uri, delegatePortableDid: await delegate.export(), delegateGrants: [], sessionRevocations: [],
      };
      const common = { providerDid: owner.uri, signer: delegate };
      await expect(ConnectProvider.sealApprovedResponse({ ...common, request: { ...request, requestType: 'authenticate' }, approval }))
        .rejects.toThrow('invalid-request');
      await expect(ConnectProvider.sealApprovedResponse({ ...common, request, approval })).rejects.toThrow('invalid-proof');
      await expect(ConnectProvider.sealApprovedResponse({ ...common, request  : { ...request, authentication: undefined },
        approval : { ...approval, authenticationProof: 'unexpected-proof' } })).rejects.toThrow('invalid-proof');

      const authenticationRequest: ConnectRequest = { ...request, requestType: 'authenticate' };
      const invalidApprovals = [
        { authenticationProof: '' },
        ...['delegateDid', 'delegatePortableDid', 'delegateGrants', 'sessionRevocations'].map(key => ({
          authenticationProof: 'proof', [key]: undefined,
        })),
      ];
      for (const invalid of invalidApprovals) {
        await expect(ConnectProvider.sealAuthenticationResponse({ ...common, request: authenticationRequest, approval: invalid }))
          .rejects.toThrow('invalid-proof');
      }
    });

    it('should enforce the expected wallet profile at preflight and seal time', async () => {
      const expectedProvider = await DidJwk.create();
      const selectedProvider = await DidJwk.create();
      const delegate = await DidJwk.create();
      const responsePrivateKey = await X25519.generateKey();
      const request: ConnectRequest = {
        clientDid           : expectedProvider.uri,
        appName             : 'Profile Guard App',
        permissionRequests  : [],
        supportedDidMethods : ['did:jwk'],
        nonce               : 'nonce',
        state               : 'state',
        responseKey         : { kty: 'OKP', crv: 'X25519', x: responsePrivateKey.x },
        reply               : { mode: 'direct_post', callbackUrl: 'https://relay.example/connect/callback' },
        expectedProviderDid : expectedProvider.uri,
      };

      expect(() => assertExpectedProviderDid(request, expectedProvider.uri)).not.toThrow();
      expect(() => assertExpectedProviderDid(request, selectedProvider.uri))
        .toThrow('Connect expected wallet profile');

      await expect(ConnectProvider.sealApprovedResponse({
        request,
        providerDid : selectedProvider.uri,
        approval    : {
          delegateDid         : delegate.uri,
          delegatePortableDid : await delegate.export(),
          delegateGrants      : [],
          sessionRevocations  : [],
        },
        signer: delegate,
      })).rejects.toThrow('Connect expected wallet profile');
    });

    it('should enforce handshakeKey rules for direct_post and post_message channels', async () => {
      const provider = await DidJwk.create();
      const delegate = await DidJwk.create();
      const responsePrivateKey = await X25519.generateKey();
      const handshakePrivateKey = await X25519.generateKey();
      const handshakeKey: Jwk = { kty: 'OKP', crv: 'X25519', x: handshakePrivateKey.x };

      const baseRequest: ConnectRequest = {
        clientDid           : provider.uri,
        appName             : 'Channel Guard App',
        permissionRequests  : [],
        supportedDidMethods : ['did:jwk'],
        nonce               : randomToken(),
        state               : randomToken(),
        responseKey         : { kty: 'OKP', crv: 'X25519', x: responsePrivateKey.x },
        reply               : { mode: 'direct_post', callbackUrl: 'https://relay.example/connect/callback' },
      };
      const approval: ConnectApproval = {
        delegateDid         : delegate.uri,
        delegatePortableDid : await delegate.export(),
        delegateGrants      : [],
        sessionRevocations  : [],
      };
      const authRequest: ConnectRequest = {
        ...baseRequest,
        requestType    : 'authenticate',
        authentication : { version: 1, audience: 'https://identity.example', challenge: randomToken() },
      };

      const sealers = [
        (request: ConnectRequest, key?: Jwk): Promise<string> =>
          ConnectProvider.sealApprovedResponse({ request, providerDid: provider.uri, approval, signer: delegate, handshakeKey: key }),
        (request: ConnectRequest, key?: Jwk): Promise<string> =>
          ConnectProvider.sealAuthenticationResponse({
            request, providerDid: provider.uri, approval: { authenticationProof: 'proof' }, signer: delegate, handshakeKey: key,
          }),
      ];
      for (const [seal, req] of [[sealers[0], baseRequest], [sealers[1], authRequest]] as const) {
        await expect(seal(req, undefined)).rejects.toThrow('`handshakeKey` is required');
        await expect(seal({ ...req, reply: { mode: 'post_message' } }, handshakeKey))
          .rejects.toThrow('`handshakeKey` must not be supplied');
      }
    });

    it('should reject approval output that contradicts a request-supplied delegate', async () => {
      const provider = await DidJwk.create();
      const localDelegate = await DidJwk.create();
      const responsePrivateKey = await X25519.generateKey();
      const handshakePrivateKey = await X25519.generateKey();
      const handshakeKey: Jwk = { kty: 'OKP', crv: 'X25519', x: handshakePrivateKey.x };

      const request: ConnectRequest = {
        clientDid           : provider.uri,
        appName             : 'Guard App',
        permissionRequests  : [],
        supportedDidMethods : ['did:jwk'],
        nonce               : 'nonce',
        state               : 'state',
        responseKey         : { kty: 'OKP', crv: 'X25519', x: responsePrivateKey.x },
        reply               : { mode: 'direct_post', callbackUrl: 'https://relay.example/connect/callback' },
        delegateDid         : localDelegate.uri,
      };

      const otherDelegate = await DidJwk.create();

      await expect(ConnectProvider.sealApprovedResponse({
        request,
        providerDid : provider.uri,
        approval    : { delegateDid: otherDelegate.uri, delegateGrants: [], sessionRevocations: [] },
        signer      : otherDelegate,
        handshakeKey,
      })).rejects.toThrow('does not match the request-supplied');

      await expect(ConnectProvider.sealApprovedResponse({
        request,
        providerDid : provider.uri,
        approval    : {
          delegateDid         : localDelegate.uri,
          delegatePortableDid : await localDelegate.export(),
          delegateGrants      : [],
          sessionRevocations  : [],
        },
        signer: otherDelegate,
        handshakeKey,
      })).rejects.toThrow('must not return delegate key material');

      await expect(ConnectProvider.sealApprovedResponse({
        request     : { ...request, delegateDid: undefined },
        providerDid : provider.uri,
        approval    : { delegateDid: otherDelegate.uri, delegateGrants: [], sessionRevocations: [] },
        signer      : otherDelegate,
        handshakeKey,
      })).rejects.toThrow('must include `delegatePortableDid`');
    });
  });
});
