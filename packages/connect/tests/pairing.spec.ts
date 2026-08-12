import type { ConnectPermissionRequest } from '../src/types.js';
import type { DataEncodedRecordsWriteMessage } from '@enbox/dwn-sdk-js';
import type { ConnectPairingContext, ConnectPairingReveal, ConnectPairingTranscript } from '../src/pairing.js';

import { Convert } from '@enbox/common';
import { DidJwk } from '@enbox/dids';
import { X25519 } from '@enbox/crypto';
import {
  assertConnectRequestV3,
  assertConnectResponseV3,
  ConnectClientSession,
  ConnectProviderSession,
} from '../src/pairing-session.js';
import {
  computeConnectPairingCommitment,
  CONNECT_PROTOCOL_VERSION,
  createConnectPairingConfirmation,
  createConnectPairingKey,
  deriveConnectPairingKey,
  deriveConnectVerificationCode,
  hashConnectPairingTranscript,
  hashConnectPayload,
  verifyConnectPairingCommitment,
  verifyConnectPairingConfirmation,
  verifyConnectPairingContext,
} from '../src/pairing.js';
import { describe, expect, it } from 'bun:test';

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

async function createPairing(): Promise<{
  client: Awaited<ReturnType<typeof createConnectPairingKey>>;
  wallet: Awaited<ReturnType<typeof createConnectPairingKey>>;
  context: ConnectPairingContext;
}> {
  const client = await createConnectPairingKey();
  const wallet = await createConnectPairingKey();
  const context: ConnectPairingContext = {
    version          : CONNECT_PROTOCOL_VERSION,
    pairingId        : 'pairing-123',
    relayOrigin      : 'https://relay.example',
    walletOrigin     : 'https://wallet.example',
    clientCommitment : client.commitment,
    walletCommitment : wallet.commitment,
    clientReveal     : client.reveal,
    walletReveal     : wallet.reveal,
  };
  return { client, wallet, context };
}

function buildTranscript(context: ConnectPairingContext, overrides: Partial<ConnectPairingTranscript> = {}): ConnectPairingTranscript {
  return {
    version                    : CONNECT_PROTOCOL_VERSION,
    pairing                    : context,
    requestHash                : Convert.uint8Array(new Uint8Array(32).fill(1)).toBase64Url(),
    permissionDigest           : Convert.uint8Array(new Uint8Array(32).fill(2)).toBase64Url(),
    delegateDid                : 'did:jwk:delegate',
    requestedSessionTtlSeconds : 3600,
    reply                      : { mode: 'pairing' },
    decisionHash               : Convert.uint8Array(new Uint8Array(32).fill(3)).toBase64Url(),
    walletDid                  : 'did:jwk:wallet',
    providerDid                : 'did:dht:provider',
    ...overrides,
  };
}

async function prepareApproval(pairingId: string): Promise<{
  client: ConnectClientSession;
  provider: ConnectProviderSession;
  request: Awaited<ReturnType<ConnectProviderSession['openRequest']>>;
  transcriptHash: string;
}> {
  const { client, provider, request } = await prepareRequest(pairingId);
  const providerDecision = await provider.sealApprovalIntent({
    providerDid  : 'did:dht:profile',
    localMatches : true,
  });
  const clientDecision = await client.openDecision(providerDecision.frame);
  if (providerDecision.decision.decision !== 'approve' || clientDecision.decision.decision !== 'approve') {
    throw new Error('Expected approval intents.');
  }
  return { client, provider, request, transcriptHash: clientDecision.transcriptHash };
}

async function prepareRequest(
  pairingId: string,
  supportedDidMethods?: string[],
  expectedProviderDid?: string,
): Promise<{
  client: ConnectClientSession;
  provider: ConnectProviderSession;
  request: Awaited<ReturnType<ConnectProviderSession['openRequest']>>;
}> {
  const client = await ConnectClientSession.create({ delegate: await DidJwk.create() });
  const provider = await ConnectProviderSession.create({ walletSigner: await DidJwk.create() });
  provider.acceptRelayClaim({
    pairingId,
    relayOrigin      : 'https://relay.example',
    walletOrigin     : 'https://wallet.example',
    clientCommitment : client.clientCommitment,
  });
  client.acceptWalletCommitment({
    pairingId,
    relayOrigin      : 'https://relay.example',
    walletOrigin     : 'https://wallet.example',
    walletCommitment : provider.walletCommitment,
  });
  await provider.acceptClientReveal(client.revealClient());
  await client.acceptWalletReveal(await provider.revealWallet());
  const request = await provider.openRequest(await client.sealRequest({
    appName: 'Notes', permissionRequests: TEST_PERMISSION_REQUESTS, nonce: 'nonce', state: 'state',
    supportedDidMethods, expectedProviderDid,
  }));
  expect(client.verificationCode).toBe(provider.verificationCode);
  return { client, provider, request };
}

describe('Connect v3 pairing', () => {
  it('should produce and verify canonical commit-before-reveal values', async () => {
    const key = await createConnectPairingKey();

    expect(key.reveal.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key.reveal.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key.commitment).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await computeConnectPairingCommitment(key.reveal)).toBe(key.commitment);
    await expect(verifyConnectPairingCommitment({ commitment: key.commitment, reveal: key.reveal })).resolves.toBeUndefined();
  });

  it('should use the documented commitment preimage', async () => {
    const reveal: ConnectPairingReveal = {
      publicKey : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      nonce     : '__________________________________________8',
    };

    expect(await computeConnectPairingCommitment(reveal)).toBe('dHsifoINpJTsDquTwQTeVZPHPTCykyEs2rVUJ8acBzw');
  });

  it('should reject a reveal changed after commitment', async () => {
    const committed = await createConnectPairingKey();
    const replacement = await createConnectPairingKey();

    await expect(verifyConnectPairingCommitment({
      commitment : committed.commitment,
      reveal     : replacement.reveal,
    })).rejects.toThrow('does not match its commitment');
  });

  it('should reject non-canonical and wrong-sized reveal values', async () => {
    const reveal = (await createConnectPairingKey()).reveal;

    await expect(computeConnectPairingCommitment({ ...reveal, nonce: `${reveal.nonce}=` }))
      .rejects.toThrow('canonical base64url');
    await expect(computeConnectPairingCommitment({ ...reveal, publicKey: 'abc' }))
      .rejects.toThrow('exactly 32 bytes');
  });

  it('should validate both commitments in the complete context', async () => {
    const { context, wallet } = await createPairing();
    await expect(verifyConnectPairingContext(context)).resolves.toBeUndefined();

    await expect(verifyConnectPairingContext({
      ...context,
      walletReveal: { ...wallet.reveal, nonce: context.clientReveal.nonce },
    })).rejects.toThrow('does not match its commitment');
  });

  it('should derive the same purpose-separated MAC keys on both peers', async () => {
    const { client, wallet, context } = await createPairing();
    const bindingHash = await hashConnectPayload(context);

    const clientConfirmationKey = await deriveConnectPairingKey({
      privateKey : client.privateKey,
      peerReveal : wallet.reveal,
      bindingHash,
      purpose    : 'confirmation-mac',
    });
    const walletConfirmationKey = await deriveConnectPairingKey({
      privateKey : wallet.privateKey,
      peerReveal : client.reveal,
      bindingHash,
      purpose    : 'confirmation-mac',
    });
    const clientVerificationKey = await deriveConnectPairingKey({
      privateKey : client.privateKey,
      peerReveal : wallet.reveal,
      bindingHash,
      purpose    : 'verification-code',
    });

    expect(clientConfirmationKey).toEqual(walletConfirmationKey);
    expect(clientVerificationKey).not.toEqual(clientConfirmationKey);
  });

  it('should derive identical six-digit codes from the committed pairing context', async () => {
    const { client, wallet, context } = await createPairing();
    const pairingHash = await hashConnectPayload(context);

    const clientCode = await deriveConnectVerificationCode({
      privateKey: client.privateKey, peerReveal: wallet.reveal, pairingHash,
    });
    const walletCode = await deriveConnectVerificationCode({
      privateKey: wallet.privateKey, peerReveal: client.reveal, pairingHash,
    });

    expect(clientCode).toMatch(/^\d{6}$/);
    expect(walletCode).toBe(clientCode);
  });

  it('should keep post-reveal approval fields out of the comparison code', async () => {
    const { client, wallet, context } = await createPairing();
    const originalHash = await hashConnectPairingTranscript(buildTranscript(context));
    const changedHash = await hashConnectPairingTranscript(buildTranscript(context, { providerDid: 'did:dht:other' }));

    expect(changedHash).not.toBe(originalHash);

    const pairingHash = await hashConnectPayload(context);
    const originalCode = await deriveConnectVerificationCode({
      privateKey: client.privateKey, peerReveal: wallet.reveal, pairingHash,
    });
    const changedCode = await deriveConnectVerificationCode({
      privateKey: client.privateKey, peerReveal: wallet.reveal, pairingHash,
    });
    expect(changedCode).toBe(originalCode);
  });

  it('should authenticate accept and reject confirmations', async () => {
    const { client, wallet, context } = await createPairing();
    const transcriptHash = await hashConnectPairingTranscript(buildTranscript(context));

    for (const accepted of [true, false]) {
      const frame = await createConnectPairingConfirmation({
        privateKey : client.privateKey,
        peerReveal : wallet.reveal,
        pairingId  : context.pairingId,
        transcriptHash,
        accepted,
      });
      await expect(verifyConnectPairingConfirmation({
        frame,
        privateKey             : wallet.privateKey,
        peerReveal             : client.reveal,
        expectedPairingId      : context.pairingId,
        expectedTranscriptHash : transcriptHash,
      })).resolves.toBe(accepted);
    }
  });

  it('should reject tampered or replayed confirmations', async () => {
    const { client, wallet, context } = await createPairing();
    const transcriptHash = await hashConnectPairingTranscript(buildTranscript(context));
    const frame = await createConnectPairingConfirmation({
      privateKey: client.privateKey, peerReveal: wallet.reveal, pairingId: context.pairingId, transcriptHash, accepted: true,
    });

    await expect(verifyConnectPairingConfirmation({
      frame                  : { ...frame, accepted: false },
      privateKey             : wallet.privateKey,
      peerReveal             : client.reveal,
      expectedPairingId      : context.pairingId,
      expectedTranscriptHash : transcriptHash,
    })).rejects.toThrow('authentication failed');

    await expect(verifyConnectPairingConfirmation({
      frame,
      privateKey             : wallet.privateKey,
      peerReveal             : client.reveal,
      expectedPairingId      : 'another-pairing',
      expectedTranscriptHash : transcriptHash,
    })).rejects.toThrow('does not match this transcript');
  });

  it('should reject a low-order peer key that yields an all-zero secret', async () => {
    const privateKey = await X25519.generateKey();
    const bindingHash = await hashConnectPayload({ binding: true });

    await expect(deriveConnectPairingKey({
      privateKey,
      peerReveal: {
        publicKey : Convert.uint8Array(new Uint8Array(32)).toBase64Url(),
        nonce     : Convert.uint8Array(new Uint8Array(32).fill(1)).toBase64Url(),
      },
      bindingHash,
      purpose: 'confirmation-mac',
    })).rejects.toThrow();
  });

  it('should gate the final grants behind transcript confirmation', async () => {
    const { client, provider, request, transcriptHash } = await prepareApproval('pairing-session');
    expect(request.clientDid).toBe(request.delegateDid);

    let approvalCalls = 0;
    const responseFrame = await provider.confirmAndSealResponse({
      confirmationFrame : await client.createConfirmation(true),
      approve           : async (approvedRequest) => {
        approvalCalls++;
        expect(Object.isFrozen(approvedRequest)).toBe(true);
        expect(Object.isFrozen(approvedRequest.permissionRequests)).toBe(true);
        return {
          delegateDid        : request.delegateDid,
          delegateGrants     : TEST_GRANTS,
          sessionRevocations : TEST_REVOCATIONS,
        };
      },
    });
    expect(approvalCalls).toBe(1);
    if (responseFrame === undefined) {
      throw new Error('Expected an approved response frame.');
    }
    const response = await client.openApprovedResponse(responseFrame);
    expect(response.transcriptHash).toBe(transcriptHash);
    expect(client.state).toBe('response-opened');
    expect(provider.state).toBe('response-sealed');
  });

  it('should require both requester and wallet code-match verdicts', async () => {
    const walletMismatch = await prepareRequest('pairing-wallet-reject');
    const denial = await walletMismatch.provider.sealApprovalIntent({
      providerDid  : 'did:dht:profile',
      localMatches : false,
    });
    expect(denial.decision.decision).toBe('deny');
    expect((await walletMismatch.client.openDecision(denial.frame)).decision.decision).toBe('deny');
    expect(walletMismatch.provider.state).toBe('denied');

    const { client, provider, request } = await prepareApproval('pairing-client-reject');
    let approvalCalls = 0;
    expect(await provider.confirmAndSealResponse({
      confirmationFrame : await client.createConfirmation(false),
      approve           : async () => {
        approvalCalls++;
        return {
          delegateDid        : request.delegateDid,
          delegateGrants     : TEST_GRANTS,
          sessionRevocations : TEST_REVOCATIONS,
        };
      },
    })).toBeUndefined();
    expect(approvalCalls).toBe(0);
    expect(provider.state).toBe('rejected');
  });

  it('should invoke the approval callback at most once', async () => {
    const { client, provider, request } = await prepareApproval('pairing-single-approval');
    const confirmationFrame = await client.createConfirmation(true);
    let releaseApproval: () => void = (): void => {};
    const approvalBlocked = new Promise<void>((resolve): void => { releaseApproval = resolve; });
    let approvalCalls = 0;
    const first = provider.confirmAndSealResponse({
      confirmationFrame,
      approve: async () => {
        approvalCalls++;
        await approvalBlocked;
        return {
          delegateDid        : request.delegateDid,
          delegateGrants     : TEST_GRANTS,
          sessionRevocations : TEST_REVOCATIONS,
        };
      },
    });

    await Promise.resolve();
    await expect(provider.confirmAndSealResponse({
      confirmationFrame,
      approve: async () => ({
        delegateDid        : request.delegateDid,
        delegateGrants     : TEST_GRANTS,
        sessionRevocations : TEST_REVOCATIONS,
      }),
    })).rejects.toThrow('expected state \'decision-sealed\', found \'processing\'');
    releaseApproval();
    expect(typeof await first).toBe('string');
    expect(approvalCalls).toBe(1);
  });

  it('should reject a non-boolean wallet verdict before an approval intent', async () => {
    const { client, provider } = await prepareRequest('pairing-invalid-wallet-verdict');
    const decision = await provider.sealApprovalIntent({
      providerDid  : 'did:dht:profile',
      localMatches : 'false' as unknown as boolean,
    });

    expect(decision.decision.decision).toBe('deny');
    expect((await client.openDecision(decision.frame)).decision.decision).toBe('deny');
    expect(provider.state).toBe('denied');
  });

  it('should reject a selected profile DID method the requester does not support', async () => {
    const { provider } = await prepareRequest('pairing-unsupported-did', ['did:jwk']);

    await expect(provider.sealApprovalIntent({
      providerDid  : 'did:dht:profile',
      localMatches : true,
    })).rejects.toThrow('provider DID method is not supported');
  });

  it('should reject a selected profile that does not match a refresh request', async () => {
    const { provider } = await prepareRequest(
      'pairing-unexpected-profile',
      ['did:dht'],
      'did:dht:expected-profile',
    );

    await expect(provider.sealApprovalIntent({
      providerDid  : 'did:dht:other-profile',
      localMatches : true,
    })).rejects.toThrow('expected wallet profile');
  });

  it('should reject an expired approval intent before creating grants', async () => {
    const realNow = Date.now;
    const { client, provider } = await prepareApproval('pairing-expired-decision');
    const confirmationFrame = await client.createConfirmation(true);
    let approvalCalls = 0;

    try {
      Date.now = (): number => realNow() + 601_000;
      await expect(provider.confirmAndSealResponse({
        confirmationFrame,
        approve: async () => {
          approvalCalls++;
          throw new Error('Approval must not run.');
        },
      })).rejects.toThrow('decision has expired');
    } finally {
      Date.now = realNow;
    }
    expect(approvalCalls).toBe(0);
    expect(provider.state).toBe('rejected');
  });

  it('should reject malformed nested request and response fields', () => {
    const request = {
      version             : CONNECT_PROTOCOL_VERSION,
      clientDid           : 'did:jwk:delegate',
      delegateDid         : 'did:jwk:delegate',
      appName             : 'Notes',
      permissionRequests  : [{ protocolDefinition: {}, permissionScopes: [{}] }],
      permissionDigest    : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      supportedDidMethods : ['did:jwk'],
      nonce               : 'nonce',
      state               : 'state',
      pairing             : {},
      reply               : { mode: 'pairing' },
    };
    expect(() => assertConnectRequestV3({
      ...request,
      clientMetadata: { languages: [123] },
    })).toThrow('clientMetadata.languages');
    expect(() => assertConnectRequestV3({
      ...request,
      permissionRequests: [{ protocolDefinition: {}, permissionScopes: [null] }],
    })).toThrow('permissionRequests');
    expect(() => assertConnectRequestV3({
      ...request,
      requestedSessionTtlSeconds: Number.POSITIVE_INFINITY,
    })).toThrow('positive finite number');
    expect(() => assertConnectRequestV3({
      ...request,
      permissionRequests: [],
    })).toThrow('at least one permission scope');

    expect(() => assertConnectResponseV3({
      version            : CONNECT_PROTOCOL_VERSION,
      walletDid          : 'did:jwk:wallet',
      providerDid        : 'did:dht:profile',
      delegateDid        : 'did:jwk:delegate',
      aud                : 'did:jwk:delegate',
      iat                : 1,
      exp                : 2,
      nonce              : 'nonce',
      state              : 'state',
      pairingId          : 'pairing',
      requestHash        : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      decisionHash       : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      transcriptHash     : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      delegateGrants     : TEST_GRANTS,
      sessionRevocations : [{}],
    })).toThrow('grants and revocations');

    expect(() => assertConnectResponseV3({
      version            : CONNECT_PROTOCOL_VERSION,
      walletDid          : 'did:jwk:wallet',
      providerDid        : 'did:dht:profile',
      delegateDid        : 'did:jwk:delegate',
      aud                : 'did:jwk:delegate',
      iat                : 1,
      exp                : 2,
      nonce              : 'nonce',
      state              : 'state',
      pairingId          : 'pairing',
      requestHash        : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      decisionHash       : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      transcriptHash     : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      delegateGrants     : [],
      sessionRevocations : [],
    })).toThrow('grants and revocations');
  });

  it('should not serialize session keys or request metadata', async () => {
    const client = await ConnectClientSession.create({ delegate: await DidJwk.create() });
    const provider = await ConnectProviderSession.create({ walletSigner: await DidJwk.create() });

    expect(JSON.stringify(client)).toBe('{"state":"created"}');
    expect(JSON.stringify(provider)).toBe('{"state":"created"}');
  });
});
