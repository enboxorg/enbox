import type { ConnectPermissionRequest } from '../src/types.js';
import type { DataEncodedRecordsWriteMessage } from '@enbox/dwn-sdk-js';
import type { FetchFn } from '../src/relay-transport.js';
import type {
  ConnectPairingHandoff,
  ConnectPairingRuntimeOptions,
  ConnectPairingVerification,
} from '../src/pairing-client.js';

import { ConnectPairingProvider } from '../src/pairing-provider.js';
import { DidJwk } from '@enbox/dids';
import { buildConnectPairingInteractionUrl, ConnectPairingClient } from '../src/pairing-client.js';
import { describe, expect, it } from 'bun:test';

const RELAY_ORIGIN = 'https://relay.example';
const WALLET_ORIGIN = 'https://wallet.example';
const PAIRING_UI_URL = 'https://connect.example/pair';
const PAIRING_ID = '123e4567-e89b-42d3-a456-426614174000';
const PAIRING_URI = `${RELAY_ORIGIN}/connect/v3/pairings/${PAIRING_ID}`;
const CLIENT_CAPABILITY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TEST_PERMISSION_REQUESTS: ConnectPermissionRequest[] = [{
  protocolDefinition: {
    protocol  : 'https://example.com/notes',
    published : true,
    types     : {},
    structure : {},
  },
  permissionScopes: [{
    interface : 'Records',
    method    : 'Read',
    protocol  : 'https://example.com/notes',
  }],
}];
const TEST_GRANTS = [{ recordId: 'grant-1' }] as unknown as DataEncodedRecordsWriteMessage[];
const TEST_REVOCATIONS = [{ grantId: 'grant-1', revocationGrantId: 'revocation-1' }];

async function yieldPoll(): Promise<void> {
  await new Promise<void>((resolve): void => { setTimeout(resolve, 0); });
}

function testRuntime(relay: MockPairingRelay): ConnectPairingRuntimeOptions {
  return {
    fetchFn : relay.fetchFn,
    sleep   : yieldPoll,
  } as ConnectPairingRuntimeOptions;
}

class MockPairingRelay {
  public readonly fetchFn: FetchFn;
  private readonly _reveals = new Map<string, Record<string, string>>();
  private readonly _frames = new Map<string, Record<string, string>>();
  private _clientCommitment = '';
  private _walletCommitment = '';

  public constructor() {
    this.fetchFn = async (input, init): Promise<Response> => await this.fetch(input, init);
  }

  private async fetch(input: string, init?: RequestInit): Promise<Response> {
    const url = new URL(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, string> : undefined;

    if (url.pathname === '/connect/v3/pairings' && init?.method === 'POST') {
      this._clientCommitment = body!.client_key_commitment;
      return Response.json({
        client_capability : CLIENT_CAPABILITY,
        expires_in        : 600,
        interval          : 1,
        pair_uri          : PAIRING_URI,
        pairing_id        : PAIRING_ID,
        relay_origin      : RELAY_ORIGIN,
        version           : '3',
      }, { status: 201 });
    }

    if (url.pathname === `${new URL(PAIRING_URI).pathname}/claim` && init?.method === 'POST') {
      this._walletCommitment = body!.wallet_key_commitment;
      return Response.json({
        client_key_commitment : this._clientCommitment,
        relay_origin          : RELAY_ORIGIN,
        version               : '3',
        wallet_origin         : WALLET_ORIGIN,
      }, { status: 201 });
    }

    if (url.pathname.endsWith('/claim') && init?.method === 'GET') {
      if (this._walletCommitment === '') {
        return new Response(null, { status: 204 });
      }
      return Response.json({
        relay_origin          : RELAY_ORIGIN,
        version               : '3',
        wallet_key_commitment : this._walletCommitment,
        wallet_origin         : WALLET_ORIGIN,
      });
    }

    const revealMatch = /^\/connect\/v3\/pairings\/[^/]+\/reveals\/(client|wallet)$/.exec(url.pathname);
    const frameMatch = /^\/connect\/v3\/pairings\/[^/]+\/(client|wallet)$/.exec(url.pathname);
    if (revealMatch !== null) {
      if (init?.method === 'PUT') {
        this._reveals.set(revealMatch[1], body!);
        return new Response(null, { status: 204 });
      }
      const reveal = this._reveals.get(revealMatch[1]);
      return reveal === undefined ? new Response(null, { status: 204 }) : Response.json({
        key_commitment : revealMatch[1] === 'client' ? this._clientCommitment : this._walletCommitment,
        nonce          : reveal.nonce,
        public_key     : reveal.public_key,
        relay_origin   : RELAY_ORIGIN,
        version        : '3',
        wallet_origin  : WALLET_ORIGIN,
      });
    }

    if (frameMatch !== null) {
      const stage = init?.method === 'PUT' ? body!.stage : url.searchParams.get('stage')!;
      if (init?.method === 'PUT') {
        this._frames.set(`${frameMatch[1]}:${stage}`, body!);
        return new Response(null, { status: 204 });
      }
      const frame = this._frames.get(`${frameMatch[1]}:${stage}`);
      return frame === undefined ? new Response(null, { status: 204 }) : Response.json(frame);
    }

    return Response.json({ error: 'not-found' }, { status: 404 });
  }
}

async function runWallet({ pairingUri, relay, approvalCalls, decision = 'approve' }: {
  pairingUri: string;
  relay: MockPairingRelay;
  approvalCalls: { value: number };
  decision?: 'approve' | 'deny';
}): Promise<{
  result: Awaited<ReturnType<typeof ConnectPairingProvider.handle>>;
  verificationCode: string;
  applicationId?: string;
  expectedProviderDid?: string;
}> {
  let verificationCode = '';
  let applicationId: string | undefined;
  let expectedProviderDid: string | undefined;
  const result = await ConnectPairingProvider.handle({
    pairingUri,
    walletOrigin : WALLET_ORIGIN,
    decide       : (request, code) => {
      verificationCode = code;
      applicationId = request.applicationId;
      expectedProviderDid = request.expectedProviderDid;
      return decision === 'deny' ? undefined : { providerDid: 'did:dht:profile' };
    },
    approve: async (request) => {
      approvalCalls.value++;
      return {
        delegateDid        : request.delegateDid,
        delegateGrants     : TEST_GRANTS,
        sessionRevocations : TEST_REVOCATIONS,
      };
    },
    transportOptions: testRuntime(relay),
  });
  return { result, verificationCode, applicationId, expectedProviderDid };
}

describe('ConnectPairingClient', () => {
  it('should return transcript-verified credentials without exposing pairing secrets', async () => {
    const relay = new MockPairingRelay();
    const delegatePortableDid = await (await DidJwk.create()).export();
    const expectedDelegatePortableDid = structuredClone(delegatePortableDid);
    const approvalCalls = { value: 0 };
    let handoff!: ConnectPairingHandoff;
    let wallet!: Promise<Awaited<ReturnType<typeof runWallet>>>;
    let verification!: ConnectPairingVerification;
    const client = new ConnectPairingClient({
      relayOrigin    : RELAY_ORIGIN,
      pairingUiUrl   : PAIRING_UI_URL,
      onPairingReady : (value): void => {
        handoff = value;
        wallet = runWallet({ pairingUri: value.pairingUri, relay, approvalCalls });
        delegatePortableDid.uri = 'did:jwk:mutated-after-connect-started';
      },
      confirmVerificationCode: (value): boolean => {
        verification = value;
        return true;
      },
      transportOptions: testRuntime(relay),
    });

    const result = await client.connect({
      appName             : 'Notes',
      applicationId       : 'dev.enbox.notes',
      permissionRequests  : TEST_PERMISSION_REQUESTS,
      delegatePortableDid,
      expectedProviderDid : 'did:dht:profile',
    });
    expect(result).toEqual({
      delegatePortableDid : expectedDelegatePortableDid,
      delegateGrants      : TEST_GRANTS,
      connectedDid        : 'did:dht:profile',
      sessionRevocations  : TEST_REVOCATIONS,
    });
    expect(approvalCalls.value).toBe(1);
    expect(verification.walletOrigin).toBe(WALLET_ORIGIN);
    expect(verification.verificationCode).toMatch(/^\d{6}$/);
    expect(Object.keys(verification).sort()).toEqual(['verificationCode', 'walletOrigin']);
    const walletResult = await wallet;
    expect(walletResult.result).toBe('approved');
    expect(walletResult.verificationCode).toBe(verification.verificationCode);
    expect(walletResult.applicationId).toBe('dev.enbox.notes');
    expect(walletResult.expectedProviderDid).toBe('did:dht:profile');

    const interaction = new URL(handoff.interactionUrl);
    expect([...interaction.searchParams.keys()]).toEqual(['pairing_uri']);
    expect(interaction.searchParams.get('pairing_uri')).toBe(PAIRING_URI);
    expect(handoff).toEqual({
      interactionUrl   : handoff.interactionUrl,
      pairingUri       : PAIRING_URI,
      expiresInSeconds : 600,
    });
    expect(decodeURIComponent(handoff.interactionUrl)).not.toContain(expectedDelegatePortableDid.uri);
    expect(handoff.interactionUrl).not.toContain(CLIENT_CAPABILITY);
    expect(JSON.stringify(handoff)).not.toContain(expectedDelegatePortableDid.privateKeys![0].d!);
    expect(JSON.stringify(client)).not.toContain(expectedDelegatePortableDid.privateKeys![0].d!);
  });

  it('should authenticate a requester mismatch without minting grants', async () => {
    const relay = new MockPairingRelay();
    const approvalCalls = { value: 0 };
    let wallet!: Promise<Awaited<ReturnType<typeof runWallet>>>;
    const client = new ConnectPairingClient({
      relayOrigin    : RELAY_ORIGIN,
      pairingUiUrl   : PAIRING_UI_URL,
      onPairingReady : ({ pairingUri }): void => {
        wallet = runWallet({ pairingUri, relay, approvalCalls });
      },
      confirmVerificationCode : (): boolean => false,
      transportOptions        : testRuntime(relay),
    });

    expect(await client.connect({
      appName             : 'Notes',
      permissionRequests  : TEST_PERMISSION_REQUESTS,
      delegatePortableDid : await (await DidJwk.create()).export(),
    })).toBeUndefined();
    expect((await wallet).result).toBe('rejected');
    expect(approvalCalls.value).toBe(0);
  });

  it('should cancel the comparison prompt when the wallet denies', async () => {
    const relay = new MockPairingRelay();
    const approvalCalls = { value: 0 };
    let promptAborted = false;
    let wallet!: Promise<Awaited<ReturnType<typeof runWallet>>>;
    const client = new ConnectPairingClient({
      relayOrigin    : RELAY_ORIGIN,
      pairingUiUrl   : PAIRING_UI_URL,
      onPairingReady : ({ pairingUri }): void => {
        wallet = runWallet({ pairingUri, relay, approvalCalls, decision: 'deny' });
      },
      confirmVerificationCode: async (_verification, signal): Promise<boolean> => await new Promise<boolean>((resolve): void => {
        signal.addEventListener('abort', (): void => {
          promptAborted = true;
          resolve(false);
        }, { once: true });
      }),
      transportOptions: testRuntime(relay),
    });

    expect(await client.connect({
      appName             : 'Notes',
      permissionRequests  : TEST_PERMISSION_REQUESTS,
      delegatePortableDid : await (await DidJwk.create()).export(),
    })).toBeUndefined();
    expect((await wallet).result).toBe('denied');
    expect(promptAborted).toBe(true);
    expect(approvalCalls.value).toBe(0);
  });

  it('should authenticate a failed requester prompt as a mismatch', async () => {
    const relay = new MockPairingRelay();
    const approvalCalls = { value: 0 };
    let wallet!: Promise<Awaited<ReturnType<typeof runWallet>>>;
    const client = new ConnectPairingClient({
      relayOrigin    : RELAY_ORIGIN,
      pairingUiUrl   : PAIRING_UI_URL,
      onPairingReady : ({ pairingUri }): void => {
        wallet = runWallet({ pairingUri, relay, approvalCalls });
      },
      confirmVerificationCode : (): never => { throw new Error('prompt failed'); },
      transportOptions        : testRuntime(relay),
    });

    await expect(client.connect({
      appName             : 'Notes',
      permissionRequests  : TEST_PERMISSION_REQUESTS,
      delegatePortableDid : await (await DidJwk.create()).export(),
    })).rejects.toThrow('prompt failed');
    expect((await wallet).result).toBe('rejected');
    expect(approvalCalls.value).toBe(0);
  });

  it('should reject non-public data on selector and pairing URLs', () => {
    expect(buildConnectPairingInteractionUrl({ pairingUiUrl: PAIRING_UI_URL, pairingUri: PAIRING_URI }))
      .toBe(`${PAIRING_UI_URL}?pairing_uri=${encodeURIComponent(PAIRING_URI)}`);
    expect(() => buildConnectPairingInteractionUrl({
      pairingUiUrl: `${PAIRING_UI_URL}?token=secret`, pairingUri: PAIRING_URI,
    })).toThrow('must not contain credentials, query parameters, or a fragment');
    expect(() => buildConnectPairingInteractionUrl({
      pairingUiUrl: PAIRING_UI_URL, pairingUri: `${PAIRING_URI}?capability=${CLIENT_CAPABILITY}`,
    })).toThrow('pairing URI must be a public relay URL');
  });
});
