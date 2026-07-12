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

import { ConnectProvider } from '../src/provider.js';
import { DidJwk } from '@enbox/dids';
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

/**
 * In-memory loopback transport: `deliverRequest` hands the sealed request
 * straight to a wallet handler which produces the response ciphertext that
 * `awaitResponse` resolves with. Supports both channel profiles.
 */
class LoopbackTransport implements ConnectTransport {
  public readonly requiresPin: boolean;

  /** Number of best-effort completion signals received from the client. */
  public confirmCompleteCalls = 0;

  private readonly _profileFactory: () => Promise<Omit<ConnectRequestProfile, 'state'>>;
  private readonly _walletHandler: (jwe: string) => Promise<string>;
  private _responsePromise?: Promise<string>;

  constructor({ requiresPin, profileFactory, walletHandler }: {
    requiresPin: boolean;
    profileFactory: () => Promise<Omit<ConnectRequestProfile, 'state'>>;
    walletHandler: (jwe: string) => Promise<string>;
  }) {
    this.requiresPin = requiresPin;
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

  public async awaitResponse(): Promise<string> {
    if (this._responsePromise === undefined) {
      throw new Error('LoopbackTransport: no request delivered.');
    }
    return await this._responsePromise;
  }

  public async confirmComplete(): Promise<void> {
    this.confirmCompleteCalls += 1;
  }
}

/** Creates a loopback transport carrying the relay (dir + PIN) profile. */
function createRelayLoopback(walletHandler: (jwe: string, requestKey: Uint8Array) => Promise<string>): LoopbackTransport {
  let requestKey: Uint8Array;
  return new LoopbackTransport({
    requiresPin    : true,
    profileFactory : async (): Promise<Omit<ConnectRequestProfile, 'state'>> => {
      requestKey = CryptoUtils.randomBytes(32);
      const reply: ReplyDescriptor = { mode: 'direct_post', callbackUrl: 'https://relay.example/connect/callback' };
      return { encryption: { mode: 'dir', requestKey }, reply };
    },
    walletHandler: (jwe: string): Promise<string> => walletHandler(jwe, requestKey),
  });
}

/** Simulates the wallet-side approval: opens the request and seals a minted-delegate response. */
async function approveWithMintedDelegate({ jwe, requestKey, providerDid, pin }: {
  jwe: string;
  requestKey: Uint8Array;
  providerDid: string;
  pin?: string;
}): Promise<{ responseJwe: string; request: ConnectRequest; delegateDid: string }> {
  const request = await ConnectProvider.openRequest({ jwe, decryption: { mode: 'dir', requestKey } });

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
    signer: delegate,
    pin,
  });

  return { responseJwe, request, delegateDid: delegate.uri };
}

describe('ConnectClient + ConnectProvider (loopback)', () => {
  it('should complete a relay-profile handshake with a PIN', async () => {
    const provider = await DidJwk.create();
    const pin = '482913';
    let observedRequest: ConnectRequest | undefined;
    let mintedDelegateDid: string | undefined;

    const transport = createRelayLoopback(async (jwe, requestKey): Promise<string> => {
      const approved = await approveWithMintedDelegate({ jwe, requestKey, providerDid: provider.uri, pin });
      observedRequest = approved.request;
      mintedDelegateDid = approved.delegateDid;
      return approved.responseJwe;
    });

    const client = new ConnectClient({
      transport,
      requestPin: async (): Promise<string> => pin,
    });

    const result = await client.connect({
      appName                    : 'Loopback App',
      appIcon                    : 'https://app.example/icon.png',
      clientMetadata             : { origin: 'https://app.example', platform: 'test' },
      permissionRequests         : [],
      requestedSessionTtlSeconds : 3600,
    });

    // The wallet saw the request the client built.
    expect(observedRequest).toBeDefined();
    expect(observedRequest!.appName).toBe('Loopback App');
    expect(observedRequest!.appIcon).toBe('https://app.example/icon.png');
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

  it('should complete a popup-profile handshake without a PIN', async () => {
    const provider = await DidJwk.create();
    const walletOrigin = 'https://wallet.example';
    const walletEphemeral = await X25519.generateKey();
    const walletEpk: Jwk = { kty: 'OKP', crv: 'X25519', x: walletEphemeral.x };

    const transport = new LoopbackTransport({
      requiresPin    : false,
      profileFactory : async (): Promise<Omit<ConnectRequestProfile, 'state'>> => ({
        encryption : { mode: 'ecdh-es', walletEpk, walletOrigin },
        reply      : { mode: 'post_message' },
      }),
      walletHandler: async (jwe: string): Promise<string> => {
        const request = await ConnectProvider.openRequest({
          jwe,
          decryption: { mode: 'ecdh-es', recipientPrivateKey: walletEphemeral, walletOrigin },
        });
        expect(request.reply).toEqual({ mode: 'post_message' });

        const delegate = await DidJwk.create();
        return await ConnectProvider.sealApprovedResponse({
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
    const pin = '073114';

    const transport = createRelayLoopback(async (jwe, requestKey): Promise<string> => {
      const request = await ConnectProvider.openRequest({ jwe, decryption: { mode: 'dir', requestKey } });
      expect(request.delegateDid).toBe(localDelegate.uri);

      const responseSigner = await DidJwk.create();
      return await ConnectProvider.sealApprovedResponse({
        request,
        providerDid : provider.uri,
        approval    : {
          delegateDid        : localDelegate.uri,
          delegateGrants     : TEST_GRANTS,
          sessionRevocations : TEST_REVOCATIONS,
        },
        signer: responseSigner,
        pin,
      });
    });

    const client = new ConnectClient({ transport, requestPin: async (): Promise<string> => pin });
    const result = await client.connect({
      appName             : 'Pre-supplied App',
      permissionRequests  : [],
      delegatePortableDid : localPortableDid,
    });

    expect(result).toBeDefined();
    expect(result!.delegatePortableDid).toBe(localPortableDid);
    expect(result!.connectedDid).toBe(provider.uri);
  });

  it('should resolve undefined when the wallet denies the request', async () => {
    const transport = createRelayLoopback(async (): Promise<string> => ConnectProvider.denyToken());

    const client = new ConnectClient({
      transport,
      requestPin: async (): Promise<string> => { throw new Error('PIN must not be requested on denial'); },
    });
    const result = await client.connect({ appName: 'Denied App', permissionRequests: [] });

    expect(result).toBeUndefined();
    expect(transport.confirmCompleteCalls).toBe(0);
  });

  it('should fail closed end-to-end when the user enters the wrong PIN', async () => {
    const provider = await DidJwk.create();

    const transport = createRelayLoopback(async (jwe, requestKey): Promise<string> => {
      const approved = await approveWithMintedDelegate({
        jwe,
        requestKey,
        providerDid : provider.uri,
        pin         : '482913',
      });
      return approved.responseJwe;
    });

    const client = new ConnectClient({ transport, requestPin: async (): Promise<string> => '000000' });

    await expect(client.connect({ appName: 'Wrong PIN App', permissionRequests: [] })).rejects.toThrow();
    expect(transport.confirmCompleteCalls).toBe(0);
  });

  it('should reject when the transport requires a PIN but no requestPin callback exists', async () => {
    const provider = await DidJwk.create();
    const transport = createRelayLoopback(async (jwe, requestKey): Promise<string> => {
      const approved = await approveWithMintedDelegate({ jwe, requestKey, providerDid: provider.uri, pin: '1234' });
      return approved.responseJwe;
    });

    const client = new ConnectClient({ transport });

    await expect(client.connect({ appName: 'No PIN Callback App', permissionRequests: [] }))
      .rejects.toThrow('no `requestPin` callback');
  });

  it('should reject when the wallet grants to a different delegate than requested', async () => {
    const provider = await DidJwk.create();
    const localDelegate = await DidJwk.create();
    const pin = '556677';

    const transport = createRelayLoopback(async (jwe, requestKey): Promise<string> => {
      const request = await ConnectProvider.openRequest({ jwe, decryption: { mode: 'dir', requestKey } });

      // A misbehaving wallet ignores the request-supplied delegate. Bypass the
      // provider's own guard by lying about the request's `delegateDid`.
      const rogueDelegate = await DidJwk.create();
      return await ConnectProvider.sealApprovedResponse({
        request     : { ...request, delegateDid: rogueDelegate.uri },
        providerDid : provider.uri,
        approval    : { delegateDid: rogueDelegate.uri, delegateGrants: TEST_GRANTS, sessionRevocations: [] },
        signer      : rogueDelegate,
        pin,
      });
    });

    const client = new ConnectClient({ transport, requestPin: async (): Promise<string> => pin });

    await expect(client.connect({
      appName             : 'Delegate Mismatch App',
      permissionRequests  : [],
      delegatePortableDid : await localDelegate.export(),
    })).rejects.toThrow('Revoke the just-approved session');
  });

  it('should reject when a wallet-minted response omits the portable delegate DID', async () => {
    const provider = await DidJwk.create();
    const pin = '998877';

    const transport = createRelayLoopback(async (jwe, requestKey): Promise<string> => {
      const request = await ConnectProvider.openRequest({ jwe, decryption: { mode: 'dir', requestKey } });

      // Bypass the provider guard by pretending the request pre-supplied the delegate.
      const delegate = await DidJwk.create();
      return await ConnectProvider.sealApprovedResponse({
        request     : { ...request, delegateDid: delegate.uri },
        providerDid : provider.uri,
        approval    : { delegateDid: delegate.uri, delegateGrants: TEST_GRANTS, sessionRevocations: [] },
        signer      : delegate,
        pin,
      });
    });

    const client = new ConnectClient({ transport, requestPin: async (): Promise<string> => pin });

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
    it('should reject approval output that contradicts a request-supplied delegate', async () => {
      const provider = await DidJwk.create();
      const localDelegate = await DidJwk.create();
      const responsePrivateKey = await X25519.generateKey();

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
      })).rejects.toThrow('must not return delegate key material');

      await expect(ConnectProvider.sealApprovedResponse({
        request     : { ...request, delegateDid: undefined },
        providerDid : provider.uri,
        approval    : { delegateDid: otherDelegate.uri, delegateGrants: [], sessionRevocations: [] },
        signer      : otherDelegate,
      })).rejects.toThrow('must include `delegatePortableDid`');
    });
  });
});
