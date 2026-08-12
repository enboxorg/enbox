/**
 * Strict client/provider state machines for the Enbox Connect v3 ceremony.
 *
 * Both peers display a code derived from the committed key exchange. A wallet
 * returns a signed approval intent only after its local comparison succeeds,
 * and cannot seal grants until the client confirms the same comparison.
 *
 * @module
 */

import type { BearerDid } from '@enbox/dids';
import type { DataEncodedRecordsWriteMessage } from '@enbox/dwn-sdk-js';
import type {
  ConnectClientMetadata,
  ConnectPermissionRequest,
  ConnectRequestType,
  SessionRevocation,
} from './types.js';
import type {
  ConnectPairingConfirmation,
  ConnectPairingContext,
  ConnectPairingKey,
  ConnectPairingReveal,
  ConnectPairingTranscript,
} from './pairing.js';

import { CompactJwe } from '@enbox/crypto';
import { Did } from '@enbox/dids';
import { canonicalJsonStringify, Convert } from '@enbox/common';

import { assertExpectedProviderDid } from './provider.js';
import {
  CONNECT_PROTOCOL_VERSION,
  createConnectPairingConfirmation,
  createConnectPairingKey,
  deriveConnectVerificationCode,
  hashConnectPairingTranscript,
  hashConnectPayload,
  verifyConnectPairingCommitment,
  verifyConnectPairingConfirmation,
  verifyConnectPairingContext,
} from './pairing.js';
import { signJwt, verifyJwt } from './jwt.js';

/** Lifetime of a signed wallet decision and final response, in seconds. */
export const CONNECT_V3_MESSAGE_TTL_SECONDS = 600;

/** Protected JWE `typ` values for the three encrypted v3 frame types. */
export const CONNECT_V3_REQUEST_JWE_TYP = 'enbox-connect-v3-request';
export const CONNECT_V3_DECISION_JWE_TYP = 'enbox-connect-v3-decision';
export const CONNECT_V3_RESPONSE_JWE_TYP = 'enbox-connect-v3-response';

const MAX_CLOCK_SKEW_SECONDS = 60;

/** Fixed reply mode for all v3 byte-delivery transports. */
export type ConnectReplyV3 = { mode: 'pairing' };

/** Signed request payload bound into the v3 comparison transcript. */
export type ConnectRequestV3 = {
  /** Protocol version. */
  version: typeof CONNECT_PROTOCOL_VERSION;

  /** Request signer and final-response audience; always equals `delegateDid`. */
  clientDid: string;

  /** Requester-owned did:jwk that will receive the grants. */
  delegateDid: string;

  /** Human-readable application name shown in wallet consent. */
  appName: string;

  /** Optional application icon shown in wallet consent. */
  appIcon?: string;

  /** Stable requester identifier shown during wallet approval. */
  applicationId?: string;

  /** Self-reported requester metadata for display only. */
  clientMetadata?: ConnectClientMetadata;

  /** Exact ordered permission requests shown and approved. */
  permissionRequests: ConnectPermissionRequest[];

  /** Canonical SHA-256 digest of `permissionRequests`. */
  permissionDigest: string;

  /** Preferred session lifetime; wallet policy may clamp it. */
  requestedSessionTtlSeconds?: number;

  /** Normal connection or refresh of the requester-owned delegate. */
  requestType?: ConnectRequestType;

  /** Wallet profile DID that a refresh must renew. */
  expectedProviderDid?: string;

  /** Connected identity DID methods supported by the requester. */
  supportedDidMethods: string[];

  /** Anti-replay nonce. */
  nonce: string;

  /** Request/response state correlator. */
  state: string;

  /** Commit-before-reveal key exchange bound to this request. */
  pairing: ConnectPairingContext;

  /** Fixed transport-independent reply mode. */
  reply: ConnectReplyV3;
};

/** Signed wallet decision delivered before grants are minted. */
export type ConnectDecisionV3 = ConnectDecisionBaseV3 & (
  | {
    /** Wallet consented to display the transcript comparison. */
    decision: 'approve';

    /** Selected wallet profile; final authority is verified from its grants. */
    providerDid: string;
  }
  | {
    /** Wallet user denied the request. */
    decision: 'deny';
  }
);

/** Fields shared by approve and deny decisions. */
type ConnectDecisionBaseV3 = {
  /** Protocol version. */
  version: typeof CONNECT_PROTOCOL_VERSION;

  /** Per-pair ephemeral did:jwk that signed this decision. */
  walletDid: string;

  /** Requester-owned delegate and response audience. */
  delegateDid: string;
  aud: string;

  /** Signed decision validity window. */
  iat: number;
  exp: number;

  /** Exact request correlators. */
  nonce: string;
  state: string;
  pairingId: string;

  /** Hashes binding the exact request and permission set. */
  requestHash: string;
  permissionDigest: string;
};

/** Grants minted only after the provider verifies an accept confirmation. */
export type ConnectApprovalV3 = {
  /** Requester-owned delegate receiving every grant. */
  delegateDid: string;

  /** Provider-signed DWN grants for the displayed permission set. */
  delegateGrants: DataEncodedRecordsWriteMessage[];

  /** Session-bound self-revocation mappings. */
  sessionRevocations: SessionRevocation[];
};

/** Signed final response sent after transcript confirmation and grant minting. */
export type ConnectResponseV3 = {
  /** Protocol version. */
  version: typeof CONNECT_PROTOCOL_VERSION;

  /** Same per-pair did:jwk that signed the approval intent. */
  walletDid: string;

  /** Profile selected in the approved decision. */
  providerDid: string;

  /** Requester-owned delegate receiving the grants. */
  delegateDid: string;

  /** Request delegate / signer audience. */
  aud: string;

  /** Signed final-response validity window. */
  iat: number;
  exp: number;

  /** Exact request correlators. */
  nonce: string;
  state: string;
  pairingId: string;

  /** Hash bindings for the request, decision, and displayed transcript. */
  requestHash: string;
  decisionHash: string;
  transcriptHash: string;

  /** Provider-signed grants and their revocation mappings. */
  delegateGrants: DataEncodedRecordsWriteMessage[];
  sessionRevocations: SessionRevocation[];
};

/** Client-visible result of opening the wallet's pre-grant decision. */
export type OpenedConnectDecisionV3 =
  | { decision: Extract<ConnectDecisionV3, { decision: 'deny' }> }
  | {
    decision: Extract<ConnectDecisionV3, { decision: 'approve' }>;
    transcriptHash: string;
  };

/** Wallet-visible sealed decision and, for approval, comparison material. */
export type SealedConnectDecisionV3 =
  | { decision: Extract<ConnectDecisionV3, { decision: 'deny' }>; frame: string }
  | {
    decision: Extract<ConnectDecisionV3, { decision: 'approve' }>;
    frame: string;
    transcriptHash: string;
  };

/** Parameters for the client to sign and seal its exact request. */
export type ConnectClientRequestV3Params = {
  appName: string;
  appIcon?: string;
  applicationId?: string;
  clientMetadata?: ConnectClientMetadata;
  permissionRequests: ConnectPermissionRequest[];
  requestedSessionTtlSeconds?: number;
  requestType?: ConnectRequestType;
  expectedProviderDid?: string;
  supportedDidMethods?: string[];
  nonce: string;
  state: string;
};

type ClientSessionState =
  | 'created'
  | 'wallet-committed'
  | 'client-revealed'
  | 'wallet-revealed'
  | 'request-sealed'
  | 'decision-opened'
  | 'confirmed'
  | 'response-opened'
  | 'denied'
  | 'processing'
  | 'rejected';

type ProviderSessionState =
  | 'created'
  | 'claimed'
  | 'client-revealed'
  | 'wallet-revealed'
  | 'request-opened'
  | 'decision-sealed'
  | 'response-sealed'
  | 'denied'
  | 'processing'
  | 'rejected';

/** Requester-side strict state machine for one v3 pairing attempt. */
export class ConnectClientSession {
  readonly #delegate: BearerDid;
  readonly #pairingKey: ConnectPairingKey;
  private _state: ClientSessionState = 'created';
  private _pairingId?: string;
  private _relayOrigin?: string;
  private _walletOrigin?: string;
  private _walletCommitment?: string;
  private _pairing?: ConnectPairingContext;
  private _request?: ConnectRequestV3;
  private _requestHash?: string;
  private _decision?: Extract<ConnectDecisionV3, { decision: 'approve' }>;
  private _decisionHash?: string;
  private _transcriptHash?: string;
  private _verificationCode?: string;

  private constructor(delegate: BearerDid, pairingKey: ConnectPairingKey) {
    this.#delegate = delegate;
    this.#pairingKey = pairingKey;
  }

  /** Creates a session whose requester-owned delegate also signs the request. */
  public static async create({ delegate }: { delegate: BearerDid }): Promise<ConnectClientSession> {
    assertDidJwk(delegate.uri, 'requester delegate');
    return new ConnectClientSession(delegate, await createConnectPairingKey());
  }

  /** Commitment sent when initializing the relay pairing. */
  public get clientCommitment(): string {
    return this.#pairingKey.commitment;
  }

  /** Current state, exposed for UI progress and deterministic recovery logic. */
  public get state(): ClientSessionState {
    return this._state;
  }

  /** Six-digit public comparison code available after both reveals are fixed. */
  public get verificationCode(): string {
    if (this._verificationCode === undefined) {
      throw new Error('Connect: verification code is not available before both pairing reveals.');
    }
    return this._verificationCode;
  }

  /** Prevents accidental serialization of session metadata and key-adjacent state. */
  public toJSON(): { state: ClientSessionState } {
    return { state: this._state };
  }

  /** Records the relay pairing and wallet commitment before revealing client key material. */
  public acceptWalletCommitment({ pairingId, relayOrigin, walletOrigin, walletCommitment }: {
    pairingId: string;
    relayOrigin: string;
    walletOrigin: string;
    walletCommitment: string;
  }): void {
    this.assertState('created');
    assertNonEmptyString(pairingId, 'pairing ID');
    assertCanonicalHttpsOrigin(relayOrigin, 'relay origin');
    assertCanonicalHttpsOrigin(walletOrigin, 'wallet origin');
    assertHash(walletCommitment, 'wallet commitment');
    this._pairingId = pairingId;
    this._relayOrigin = relayOrigin;
    this._walletOrigin = walletOrigin;
    this._walletCommitment = walletCommitment;
    this._state = 'wallet-committed';
  }

  /** Releases the client reveal only after the wallet commitment is fixed. */
  public revealClient(): ConnectPairingReveal {
    this.assertState('wallet-committed');
    this._state = 'client-revealed';
    return structuredClone(this.#pairingKey.reveal);
  }

  /** Verifies the wallet reveal and fixes the public pairing context. */
  public async acceptWalletReveal(reveal: ConnectPairingReveal): Promise<void> {
    this.beginTransition('client-revealed');
    await verifyConnectPairingCommitment({ commitment: this._walletCommitment!, reveal });
    this._pairing = {
      version          : CONNECT_PROTOCOL_VERSION,
      pairingId        : this._pairingId!,
      relayOrigin      : this._relayOrigin!,
      walletOrigin     : this._walletOrigin!,
      clientCommitment : this.#pairingKey.commitment,
      walletCommitment : this._walletCommitment!,
      clientReveal     : structuredClone(this.#pairingKey.reveal),
      walletReveal     : structuredClone(reveal),
    };
    await verifyConnectPairingContext(this._pairing);
    this._verificationCode = await deriveConnectVerificationCode({
      privateKey  : this.#pairingKey.privateKey,
      peerReveal  : this._pairing.walletReveal,
      pairingHash : await hashConnectPayload(this._pairing),
    });
    this._state = 'wallet-revealed';
  }

  /** Signs and encrypts the request after both committed reveals are validated. */
  public async sealRequest(params: ConnectClientRequestV3Params): Promise<string> {
    this.beginTransition('wallet-revealed');
    if (params.requestType === 'refresh' && this.#delegate.uri.length === 0) {
      throw new Error('Connect: refresh requires a requester-owned delegate.');
    }

    const permissionDigest = await hashConnectPayload(params.permissionRequests);
    const request: ConnectRequestV3 = {
      version                    : CONNECT_PROTOCOL_VERSION,
      clientDid                  : this.#delegate.uri,
      delegateDid                : this.#delegate.uri,
      appName                    : params.appName,
      appIcon                    : params.appIcon,
      applicationId              : params.applicationId,
      clientMetadata             : structuredClone(params.clientMetadata),
      permissionRequests         : structuredClone(params.permissionRequests),
      permissionDigest,
      requestedSessionTtlSeconds : params.requestedSessionTtlSeconds,
      requestType                : params.requestType,
      expectedProviderDid        : params.expectedProviderDid,
      supportedDidMethods        : structuredClone(params.supportedDidMethods ?? ['did:dht', 'did:jwk']),
      nonce                      : params.nonce,
      state                      : params.state,
      pairing                    : structuredClone(this._pairing!),
      reply                      : { mode: 'pairing' },
    };
    assertConnectRequestV3(request);

    const pairingHash = await hashConnectPayload(request.pairing);
    const frame = await sealSignedFrame({
      payload            : request,
      signer             : this.#delegate,
      recipientPublicKey : request.pairing.walletReveal,
      binding            : pairingHash,
      partyU             : request.pairing.pairingId,
      partyV             : request.pairing.walletOrigin,
      typ                : CONNECT_V3_REQUEST_JWE_TYP,
    });

    this._request = request;
    this._requestHash = await hashConnectPayload(request);
    this._state = 'request-sealed';
    return frame;
  }

  /** Opens the authenticated deny or pre-grant approval-intent frame. */
  public async openDecision(frame: string): Promise<OpenedConnectDecisionV3> {
    this.beginTransition('request-sealed');
    const opened = await openSignedFrame({
      frame,
      recipientPrivateKey : this.#pairingKey.privateKey,
      binding             : this._requestHash!,
      partyU              : this._pairing!.walletOrigin,
      partyV              : this._pairing!.relayOrigin,
      typ                 : CONNECT_V3_DECISION_JWE_TYP,
    });
    assertConnectDecisionV3(opened.payload);
    const decision = opened.payload;

    this.assertDecisionBindings(decision, opened.signerDid);
    if (decision.decision === 'deny') {
      this._state = 'denied';
      return { decision: structuredClone(decision) };
    }

    const decisionHash = await hashConnectPayload(decision);
    const transcript = buildTranscript(this._request!, this._requestHash!, decision, decisionHash);
    const transcriptHash = await hashConnectPairingTranscript(transcript);
    this._decision = structuredClone(decision);
    this._decisionHash = decisionHash;
    this._transcriptHash = transcriptHash;
    this._state = 'decision-opened';
    return { decision: structuredClone(decision), transcriptHash };
  }

  /**
   * Creates the authenticated human comparison result.
   *
   * A mismatch terminally rejects the session. An accepted session remains
   * quarantined until the final response is opened and higher layers validate
   * every provider-signed grant.
   */
  public async createConfirmation(matches: boolean): Promise<string> {
    this.beginTransition('decision-opened');
    const frame = await createConnectPairingConfirmation({
      privateKey     : this.#pairingKey.privateKey,
      peerReveal     : this._pairing!.walletReveal,
      pairingId      : this._pairing!.pairingId,
      transcriptHash : this._transcriptHash!,
      accepted       : matches === true,
    });
    this._state = matches === true ? 'confirmed' : 'rejected';
    return canonicalJsonStringify(frame);
  }

  /** Opens the final grant response; no session activation happens here. */
  public async openApprovedResponse(frame: string): Promise<ConnectResponseV3> {
    this.beginTransition('confirmed');
    const opened = await openSignedFrame({
      frame,
      recipientPrivateKey : this.#pairingKey.privateKey,
      binding             : this._transcriptHash!,
      partyU              : this._pairing!.walletOrigin,
      partyV              : this._pairing!.relayOrigin,
      typ                 : CONNECT_V3_RESPONSE_JWE_TYP,
    });
    assertConnectResponseV3(opened.payload);
    const response = opened.payload;
    this.assertResponseBindings(response, opened.signerDid);

    this._state = 'response-opened';
    return structuredClone(response);
  }

  private assertDecisionBindings(decision: ConnectDecisionV3, signerDid: string): void {
    assertFreshWindow(decision.iat, decision.exp, 'decision');
    if (decision.walletDid !== signerDid) {
      throw new Error('Connect: decision signer does not match `walletDid`.');
    }
    if (
      decision.aud !== this._request!.clientDid
      || decision.delegateDid !== this._request!.delegateDid
      || decision.nonce !== this._request!.nonce
      || decision.state !== this._request!.state
      || decision.pairingId !== this._pairing!.pairingId
      || decision.requestHash !== this._requestHash
      || decision.permissionDigest !== this._request!.permissionDigest
    ) {
      throw new Error('Connect: decision does not match the signed request.');
    }
    if (decision.decision === 'approve') {
      assertSupportedProviderDid(decision.providerDid, this._request!.supportedDidMethods);
      assertExpectedProviderDid(this._request!, decision.providerDid);
    }
  }

  private assertResponseBindings(response: ConnectResponseV3, signerDid: string): void {
    assertFreshWindow(response.iat, response.exp, 'response');
    if (response.walletDid !== signerDid || response.walletDid !== this._decision!.walletDid) {
      throw new Error('Connect: final response signer does not match the approval intent.');
    }
    if (
      response.providerDid !== this._decision!.providerDid
      || response.delegateDid !== this._request!.delegateDid
      || response.aud !== this._request!.clientDid
      || response.nonce !== this._request!.nonce
      || response.state !== this._request!.state
      || response.pairingId !== this._pairing!.pairingId
      || response.requestHash !== this._requestHash
      || response.decisionHash !== this._decisionHash
      || response.transcriptHash !== this._transcriptHash
    ) {
      throw new Error('Connect: final response does not match the confirmed transcript.');
    }
  }

  private assertState(expected: ClientSessionState): void {
    if (this._state !== expected) {
      throw new Error(`Connect: client session expected state '${expected}', found '${this._state}'.`);
    }
  }

  private beginTransition(expected: ClientSessionState): void {
    this.assertState(expected);
    this._state = 'processing';
  }
}

/** Wallet-side strict state machine for one v3 pairing attempt. */
export class ConnectProviderSession {
  readonly #walletSigner: BearerDid;
  readonly #pairingKey: ConnectPairingKey;
  private _state: ProviderSessionState = 'created';
  private _pairingId?: string;
  private _relayOrigin?: string;
  private _walletOrigin?: string;
  private _clientCommitment?: string;
  private _pairing?: ConnectPairingContext;
  private _request?: ConnectRequestV3;
  private _requestHash?: string;
  private _decision?: Extract<ConnectDecisionV3, { decision: 'approve' }>;
  private _decisionHash?: string;
  private _transcriptHash?: string;
  private _verificationCode?: string;

  private constructor({ walletSigner, pairingKey }: {
    walletSigner: BearerDid;
    pairingKey: ConnectPairingKey;
  }) {
    this.#walletSigner = walletSigner;
    this.#pairingKey = pairingKey;
  }

  /** Creates the wallet session and its commitment before the relay claim. */
  public static async create({ walletSigner }: {
    walletSigner: BearerDid;
  }): Promise<ConnectProviderSession> {
    assertDidJwk(walletSigner.uri, 'wallet signer');
    return new ConnectProviderSession({
      walletSigner,
      pairingKey: await createConnectPairingKey(),
    });
  }

  /** Commitment used to atomically claim the pairing. */
  public get walletCommitment(): string {
    return this.#pairingKey.commitment;
  }

  /** Current provider state for deterministic UI progress. */
  public get state(): ProviderSessionState {
    return this._state;
  }

  /** Six-digit public comparison code available after both reveals are fixed. */
  public get verificationCode(): string {
    if (this._verificationCode === undefined) {
      throw new Error('Connect: verification code is not available before both pairing reveals.');
    }
    return this._verificationCode;
  }

  /** Prevents accidental serialization of session metadata and key-adjacent state. */
  public toJSON(): { state: ProviderSessionState } {
    return { state: this._state };
  }

  /** Fixes the relay-provided pairing context after the wallet wins the claim. */
  public acceptRelayClaim({ pairingId, relayOrigin, walletOrigin, clientCommitment }: {
    pairingId: string;
    relayOrigin: string;
    walletOrigin: string;
    clientCommitment: string;
  }): void {
    this.assertState('created');
    assertNonEmptyString(pairingId, 'pairing ID');
    assertCanonicalHttpsOrigin(relayOrigin, 'relay origin');
    assertCanonicalHttpsOrigin(walletOrigin, 'wallet origin');
    assertHash(clientCommitment, 'client commitment');
    this._pairingId = pairingId;
    this._relayOrigin = relayOrigin;
    this._walletOrigin = walletOrigin;
    this._clientCommitment = clientCommitment;
    this._state = 'claimed';
  }

  /** Verifies the released client key against the pre-existing commitment. */
  public async acceptClientReveal(reveal: ConnectPairingReveal): Promise<void> {
    this.beginTransition('claimed');
    await verifyConnectPairingCommitment({ commitment: this._clientCommitment!, reveal });
    this._pairing = {
      version          : CONNECT_PROTOCOL_VERSION,
      pairingId        : this._pairingId!,
      relayOrigin      : this._relayOrigin!,
      walletOrigin     : this._walletOrigin!,
      clientCommitment : this._clientCommitment!,
      walletCommitment : this.#pairingKey.commitment,
      clientReveal     : structuredClone(reveal),
      walletReveal     : structuredClone(this.#pairingKey.reveal),
    };
    this._state = 'client-revealed';
  }

  /** Releases the wallet reveal only after the client reveal is verified. */
  public async revealWallet(): Promise<ConnectPairingReveal> {
    this.beginTransition('client-revealed');
    await verifyConnectPairingContext(this._pairing!);
    this._verificationCode = await deriveConnectVerificationCode({
      privateKey  : this.#pairingKey.privateKey,
      peerReveal  : this._pairing!.clientReveal,
      pairingHash : await hashConnectPayload(this._pairing!),
    });
    this._state = 'wallet-revealed';
    return structuredClone(this.#pairingKey.reveal);
  }

  /** Decrypts and verifies the requester-owned delegate's signed request. */
  public async openRequest(frame: string): Promise<ConnectRequestV3> {
    this.beginTransition('wallet-revealed');
    const pairingHash = await hashConnectPayload(this._pairing!);
    const opened = await openSignedFrame({
      frame,
      recipientPrivateKey : this.#pairingKey.privateKey,
      binding             : pairingHash,
      partyU              : this._pairingId!,
      partyV              : this._walletOrigin!,
      typ                 : CONNECT_V3_REQUEST_JWE_TYP,
    });
    assertConnectRequestV3(opened.payload);
    const request = structuredClone(opened.payload);

    if (request.clientDid !== request.delegateDid || opened.signerDid !== request.delegateDid) {
      throw new Error('Connect: v3 request must be signed by its requester-owned delegate.');
    }
    if (await hashConnectPayload(request.pairing) !== pairingHash) {
      throw new Error('Connect: signed request carries a different pairing context.');
    }
    if (request.permissionDigest !== await hashConnectPayload(request.permissionRequests)) {
      throw new Error('Connect: request permission digest does not match its permission list.');
    }

    this._request = structuredClone(request);
    this._requestHash = await hashConnectPayload(request);
    this._state = 'request-opened';
    return structuredClone(request);
  }

  /** Creates an authenticated denial frame and terminally closes the session. */
  public async sealDenial(): Promise<SealedConnectDecisionV3> {
    this.beginTransition('request-opened');
    const decision = this.createDecisionBase('deny');
    const frame = await sealSignedFrame({
      payload            : decision,
      signer             : this.#walletSigner,
      recipientPublicKey : this._pairing!.clientReveal,
      binding            : this._requestHash!,
      partyU             : this._walletOrigin!,
      partyV             : this._relayOrigin!,
      typ                : CONNECT_V3_DECISION_JWE_TYP,
    });
    this._state = 'denied';
    return { decision: structuredClone(decision), frame };
  }

  /**
   * Creates the pre-grant approval intent and wallet comparison code.
   *
   * The returned code is display-only. Grant creation remains structurally
   * gated by {@link confirmAndSealResponse}.
   */
  public async sealApprovalIntent({ providerDid, localMatches }: {
    providerDid: string;
    localMatches: boolean;
  }): Promise<SealedConnectDecisionV3> {
    if (localMatches !== true) {
      return await this.sealDenial();
    }
    assertNonEmptyString(providerDid, 'provider DID');
    assertSupportedProviderDid(providerDid, this._request!.supportedDidMethods);
    assertExpectedProviderDid(this._request!, providerDid);
    this.beginTransition('request-opened');
    const decision: Extract<ConnectDecisionV3, { decision: 'approve' }> = {
      ...this.createDecisionBase('approve'),
      providerDid,
    };
    const frame = await sealSignedFrame({
      payload            : decision,
      signer             : this.#walletSigner,
      recipientPublicKey : this._pairing!.clientReveal,
      binding            : this._requestHash!,
      partyU             : this._walletOrigin!,
      partyV             : this._relayOrigin!,
      typ                : CONNECT_V3_DECISION_JWE_TYP,
    });
    const decisionHash = await hashConnectPayload(decision);
    const transcript = buildTranscript(this._request!, this._requestHash!, decision, decisionHash);
    const transcriptHash = await hashConnectPairingTranscript(transcript);
    this._decision = structuredClone(decision);
    this._decisionHash = decisionHash;
    this._transcriptHash = transcriptHash;
    this._state = 'decision-sealed';
    return { decision: structuredClone(decision), frame, transcriptHash };
  }

  /** Verifies both code-match verdicts, then invokes the grant callback exactly once. */
  public async confirmAndSealResponse({ confirmationFrame, approve }: {
    confirmationFrame: string;
    approve: (request: Readonly<ConnectRequestV3>) => Promise<ConnectApprovalV3>;
  }): Promise<string | undefined> {
    this.beginTransition('decision-sealed');

    try {
      const parsed = parseJsonFrame<ConnectPairingConfirmation>(confirmationFrame, 'confirmation');
      const clientMatches = await verifyConnectPairingConfirmation({
        frame                  : parsed,
        privateKey             : this.#pairingKey.privateKey,
        peerReveal             : this._pairing!.clientReveal,
        expectedPairingId      : this._pairingId!,
        expectedTranscriptHash : this._transcriptHash!,
      });
      if (clientMatches !== true) {
        this._state = 'rejected';
        return undefined;
      }

      assertFreshWindow(this._decision!.iat, this._decision!.exp, 'decision');
      const approval = await approve(deepFreeze(structuredClone(this._request!)));
      if (approval.delegateDid !== this._request!.delegateDid) {
        throw new Error('Connect: approval delegate does not match the requester-owned delegate.');
      }

      const iat = Math.floor(Date.now() / 1000);
      const response: ConnectResponseV3 = {
        version            : CONNECT_PROTOCOL_VERSION,
        walletDid          : this.#walletSigner.uri,
        providerDid        : this._decision!.providerDid,
        delegateDid        : approval.delegateDid,
        aud                : this._request!.clientDid,
        iat,
        exp                : iat + CONNECT_V3_MESSAGE_TTL_SECONDS,
        nonce              : this._request!.nonce,
        state              : this._request!.state,
        pairingId          : this._pairingId!,
        requestHash        : this._requestHash!,
        decisionHash       : this._decisionHash!,
        transcriptHash     : this._transcriptHash!,
        delegateGrants     : structuredClone(approval.delegateGrants),
        sessionRevocations : structuredClone(approval.sessionRevocations),
      };
      assertConnectResponseV3(response);
      const frame = await sealSignedFrame({
        payload            : response,
        signer             : this.#walletSigner,
        recipientPublicKey : this._pairing!.clientReveal,
        binding            : this._transcriptHash!,
        partyU             : this._walletOrigin!,
        partyV             : this._relayOrigin!,
        typ                : CONNECT_V3_RESPONSE_JWE_TYP,
      });

      this._state = 'response-sealed';
      return frame;
    } catch (error) {
      this._state = 'rejected';
      throw error;
    }
  }

  private createDecisionBase<TDecision extends 'approve' | 'deny'>(decision: TDecision): ConnectDecisionBaseV3 & { decision: TDecision } {
    const iat = Math.floor(Date.now() / 1000);
    return {
      version          : CONNECT_PROTOCOL_VERSION,
      decision,
      walletDid        : this.#walletSigner.uri,
      delegateDid      : this._request!.delegateDid,
      aud              : this._request!.clientDid,
      iat,
      exp              : iat + CONNECT_V3_MESSAGE_TTL_SECONDS,
      nonce            : this._request!.nonce,
      state            : this._request!.state,
      pairingId        : this._pairingId!,
      requestHash      : this._requestHash!,
      permissionDigest : this._request!.permissionDigest,
    };
  }

  private assertState(expected: ProviderSessionState): void {
    if (this._state !== expected) {
      throw new Error(`Connect: provider session expected state '${expected}', found '${this._state}'.`);
    }
  }

  private beginTransition(expected: ProviderSessionState): void {
    this.assertState(expected);
    this._state = 'processing';
  }
}

/** Runtime assertion for a verified v3 request payload. */
export function assertConnectRequestV3(value: unknown): asserts value is ConnectRequestV3 {
  const payload = requireObject(value, 'v3 request');
  requireVersion(payload, 'v3 request');
  for (const field of ['clientDid', 'delegateDid', 'appName', 'permissionDigest', 'nonce', 'state']) {
    requireString(payload, field, 'v3 request');
  }
  if (payload.clientDid !== payload.delegateDid) {
    throw new Error('Connect: v3 request `clientDid` must equal `delegateDid`.');
  }
  if (payload.appIcon !== undefined && typeof payload.appIcon !== 'string') {
    throw new Error('Connect: v3 request `appIcon` must be a string when present.');
  }
  if (payload.applicationId !== undefined && typeof payload.applicationId !== 'string') {
    throw new Error('Connect: v3 request `applicationId` must be a string when present.');
  }
  if (payload.expectedProviderDid !== undefined && typeof payload.expectedProviderDid !== 'string') {
    throw new Error('Connect: v3 request `expectedProviderDid` must be a string when present.');
  }
  assertClientMetadata(payload.clientMetadata);
  assertPermissionRequests(payload.permissionRequests);
  if (!Array.isArray(payload.supportedDidMethods) ||
      !payload.supportedDidMethods.every((method): boolean => typeof method === 'string' && method.length > 0)) {
    throw new Error('Connect: v3 request `supportedDidMethods` must be a non-empty-string array.');
  }
  if (payload.requestType !== undefined && payload.requestType !== 'connect' && payload.requestType !== 'refresh') {
    throw new Error('Connect: v3 request has an unsupported request type.');
  }
  if (payload.requestedSessionTtlSeconds !== undefined &&
      (typeof payload.requestedSessionTtlSeconds !== 'number' ||
       !Number.isFinite(payload.requestedSessionTtlSeconds) || payload.requestedSessionTtlSeconds <= 0)) {
    throw new Error('Connect: v3 request session TTL must be a positive finite number.');
  }
  if (payload.reply === null || typeof payload.reply !== 'object' || (payload.reply as Record<string, unknown>).mode !== 'pairing') {
    throw new Error('Connect: v3 request reply mode must be `pairing`.');
  }
  if (payload.pairing === null || typeof payload.pairing !== 'object') {
    throw new Error('Connect: v3 request must include a pairing context.');
  }
  assertHash(payload.permissionDigest as string, 'permission digest');
}

/** Runtime assertion for a verified v3 decision payload. */
export function assertConnectDecisionV3(value: unknown): asserts value is ConnectDecisionV3 {
  const payload = requireObject(value, 'v3 decision');
  requireVersion(payload, 'v3 decision');
  for (const field of [
    'walletDid', 'delegateDid', 'aud', 'nonce', 'state', 'pairingId', 'requestHash', 'permissionDigest',
  ]) {
    requireString(payload, field, 'v3 decision');
  }
  requireNumber(payload, 'iat', 'v3 decision');
  requireNumber(payload, 'exp', 'v3 decision');
  assertHash(payload.requestHash as string, 'request hash');
  assertHash(payload.permissionDigest as string, 'permission digest');
  if (payload.decision !== 'approve' && payload.decision !== 'deny') {
    throw new Error('Connect: v3 decision must be `approve` or `deny`.');
  }
  if (payload.decision === 'approve') {
    requireString(payload, 'providerDid', 'v3 decision');
  } else if (payload.providerDid !== undefined) {
    throw new Error('Connect: denied v3 decision must not select a provider DID.');
  }
}

/** Runtime assertion for a verified v3 final-response payload. */
export function assertConnectResponseV3(value: unknown): asserts value is ConnectResponseV3 {
  const payload = requireObject(value, 'v3 response');
  requireVersion(payload, 'v3 response');
  for (const field of [
    'walletDid', 'providerDid', 'delegateDid', 'aud', 'nonce', 'state', 'pairingId',
    'requestHash', 'decisionHash', 'transcriptHash',
  ]) {
    requireString(payload, field, 'v3 response');
  }
  requireNumber(payload, 'iat', 'v3 response');
  requireNumber(payload, 'exp', 'v3 response');
  if (!Array.isArray(payload.delegateGrants) || payload.delegateGrants.length === 0 ||
      !payload.delegateGrants.every((grant): boolean => isRecord(grant)) ||
      !Array.isArray(payload.sessionRevocations) ||
      !payload.sessionRevocations.every(isSessionRevocation)) {
    throw new Error('Connect: v3 response grants and revocations must be arrays.');
  }
  assertHash(payload.requestHash as string, 'request hash');
  assertHash(payload.decisionHash as string, 'decision hash');
  assertHash(payload.transcriptHash as string, 'transcript hash');
}

function buildTranscript(
  request: ConnectRequestV3,
  requestHash: string,
  decision: Extract<ConnectDecisionV3, { decision: 'approve' }>,
  decisionHash: string,
): ConnectPairingTranscript {
  return {
    version                    : CONNECT_PROTOCOL_VERSION,
    pairing                    : request.pairing,
    requestHash,
    permissionDigest           : request.permissionDigest,
    delegateDid                : request.delegateDid,
    requestedSessionTtlSeconds : request.requestedSessionTtlSeconds,
    reply                      : request.reply,
    decisionHash,
    walletDid                  : decision.walletDid,
    providerDid                : decision.providerDid,
  };
}

async function sealSignedFrame({ payload, signer, recipientPublicKey, binding, partyU, partyV, typ }: {
  payload: object;
  signer: BearerDid;
  recipientPublicKey: ConnectPairingReveal;
  binding: string;
  partyU: string;
  partyV: string;
  typ: string;
}): Promise<string> {
  const jwt = await signJwt({ did: signer, data: payload });
  return await CompactJwe.encrypt({
    plaintext       : Convert.string(jwt).toUint8Array(),
    protectedHeader : {
      alg  : 'ECDH-ES',
      apu  : Convert.string(partyU).toBase64Url(),
      apv  : Convert.string(partyV).toBase64Url(),
      bind : binding,
      cty  : 'JWT',
      enc  : 'XC20P',
      typ,
    },
    key: {
      mode          : 'ecdh-es',
      peerPublicKey : { kty: 'OKP', crv: 'X25519', x: recipientPublicKey.publicKey },
    },
  });
}

async function openSignedFrame({ frame, recipientPrivateKey, binding, partyU, partyV, typ }: {
  frame: string;
  recipientPrivateKey: ConnectPairingKey['privateKey'];
  binding: string;
  partyU: string;
  partyV: string;
  typ: string;
}): Promise<{ payload: Record<string, unknown>; signerDid: string }> {
  const { plaintext, protectedHeader } = await CompactJwe.decrypt({
    jwe     : frame,
    key     : { mode: 'ecdh-es', privateKey: recipientPrivateKey },
    options : { allowedAlgs: ['ECDH-ES'], allowedEncs: ['XC20P'] },
  });
  if (
    protectedHeader.typ !== typ
    || protectedHeader.cty !== 'JWT'
    || protectedHeader.bind !== binding
    || protectedHeader.apu !== Convert.string(partyU).toBase64Url()
    || protectedHeader.apv !== Convert.string(partyV).toBase64Url()
  ) {
    throw new Error('Connect: pairing envelope header does not match its stage and transcript binding.');
  }
  return await verifyJwt({ jwt: Convert.uint8Array(plaintext).toString() });
}

function assertFreshWindow(iat: number, exp: number, label: string): void {
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) {
    throw new Error(`Connect: ${label} timestamps must be safe integers.`);
  }
  if (exp <= iat) {
    throw new Error(`Connect: ${label} expiration must be later than issuance.`);
  }
  if (exp - iat > CONNECT_V3_MESSAGE_TTL_SECONDS) {
    throw new Error(`Connect: ${label} lifetime exceeds the protocol maximum.`);
  }
  if (iat > now + MAX_CLOCK_SKEW_SECONDS) {
    throw new Error(`Connect: ${label} was issued in the future.`);
  }
  if (now >= exp) {
    throw new Error(`Connect: ${label} has expired.`);
  }
}

function parseJsonFrame<T>(frame: string, label: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    throw new Error(`Connect: malformed pairing ${label} frame.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Connect: malformed pairing ${label} frame.`);
  }
  return parsed as T;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Connect: ${label} payload must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertClientMetadata(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new Error('Connect: v3 request `clientMetadata` must be an object when present.');
  }

  const stringFields = new Set(['origin', 'userAgent', 'platform', 'language', 'timezone']);
  for (const [key, field] of Object.entries(value)) {
    if (key === 'languages') {
      if (!Array.isArray(field) || !field.every((language): boolean => typeof language === 'string')) {
        throw new Error('Connect: v3 request `clientMetadata.languages` must be a string array.');
      }
    } else if (!stringFields.has(key) || typeof field !== 'string') {
      throw new Error(`Connect: v3 request has an invalid client metadata field '${key}'.`);
    }
  }
}

function assertPermissionRequests(value: unknown): void {
  if (!Array.isArray(value) || !value.every((request): boolean =>
    isRecord(request) && isRecord(request.protocolDefinition) && Array.isArray(request.permissionScopes) &&
    request.permissionScopes.every((scope): boolean => isRecord(scope)))) {
    throw new Error('Connect: v3 request `permissionRequests` must contain protocol definitions and permission scope arrays.');
  }
  if (value.reduce((count, request): number => count + request.permissionScopes.length, 0) === 0) {
    throw new Error('Connect: v3 requests must include at least one permission scope.');
  }
}

function assertSupportedProviderDid(providerDid: string, supportedDidMethods: string[]): void {
  const parsed = Did.parse(providerDid);
  if (parsed === null || parsed.uri !== providerDid || !supportedDidMethods.includes(`did:${parsed.method}`)) {
    throw new Error('Connect: selected provider DID method is not supported by the requester.');
  }
}

function isSessionRevocation(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.grantId === 'string' && value.grantId.length > 0 &&
    typeof value.revocationGrantId === 'string' && value.revocationGrantId.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireVersion(payload: Record<string, unknown>, label: string): void {
  if (payload.version !== CONNECT_PROTOCOL_VERSION) {
    throw new Error(`Connect: ${label} uses an unsupported protocol version.`);
  }
}

function requireString(payload: Record<string, unknown>, field: string, label: string): void {
  if (typeof payload[field] !== 'string' || payload[field].length === 0) {
    throw new Error(`Connect: ${label} \`${field}\` must be a non-empty string.`);
  }
}

function requireNumber(payload: Record<string, unknown>, field: string, label: string): void {
  if (typeof payload[field] !== 'number' || !Number.isFinite(payload[field])) {
    throw new Error(`Connect: ${label} \`${field}\` must be a finite number.`);
  }
}

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Connect: ${label} must be a non-empty string.`);
  }
}

function assertDidJwk(value: string, label: string): void {
  if (!value.startsWith('did:jwk:')) {
    throw new Error(`Connect: ${label} must be a did:jwk identifier.`);
  }
}

function assertHash(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error(`Connect: ${label} must be a canonical SHA-256 base64url value.`);
  }
}

function assertCanonicalHttpsOrigin(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Connect: ${label} must be a canonical HTTPS origin.`);
  }
  const isLoopbackHttp = url.protocol === 'http:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if ((url.protocol !== 'https:' && !isLoopbackHttp) || url.origin !== value) {
    throw new Error(`Connect: ${label} must be a canonical HTTPS origin or an HTTP loopback origin.`);
  }
}
