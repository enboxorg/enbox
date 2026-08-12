import type { ConnectClientConnectParams } from './client.js';
import type { ConnectResult } from './types.js';
import type { PortableDid } from '@enbox/dids';
import type { RelayPairingTransportOptions } from './relay-pairing-transport.js';

import { ConnectClientSession } from './pairing-session.js';
import { DidJwk } from '@enbox/dids';
import { randomToken } from './client.js';
import { RelayPairingClientTransport } from './relay-pairing-transport.js';

const PAIRING_URI_PARAMETER = 'pairing_uri';

/** Public data a requester displays as a URL or QR code. */
export type ConnectPairingHandoff = {
  interactionUrl: string;
  pairingUri: string;
  expiresInSeconds: number;
};

/** Public comparison data shown by the trusted requester UI. */
export type ConnectPairingVerification = {
  verificationCode: string;
  walletOrigin: string;
};

/** Runtime controls shared by the requester and wallet relay clients. */
export type ConnectPairingRuntimeOptions = Pick<
  RelayPairingTransportOptions,
  'fetchFn' | 'httpTimeoutMs' | 'pollIntervalMs' | 'pollTimeoutMs' | 'signal'
>;

/** Options for one reusable v3 relay-pairing client. */
export type ConnectPairingClientOptions = {
  relayOrigin: string;
  pairingUiUrl: string;
  onPairingReady: (handoff: ConnectPairingHandoff) => Promise<void> | void;
  confirmVerificationCode: (
    verification: ConnectPairingVerification,
    signal: AbortSignal,
  ) => Promise<boolean> | boolean;
  transportOptions?: ConnectPairingRuntimeOptions;
};

/** V3 requests always use a requester-owned did:jwk delegate. */
export type ConnectPairingClientConnectParams = Omit<ConnectClientConnectParams, 'delegatePortableDid'> & {
  delegatePortableDid: PortableDid;
};

/** Drives the requester side of a transcript-confirmed v3 relay pairing. */
export class ConnectPairingClient {
  private readonly _relayOrigin: string;
  private readonly _pairingUiUrl: string;
  private readonly _onPairingReady: ConnectPairingClientOptions['onPairingReady'];
  private readonly _confirmVerificationCode: ConnectPairingClientOptions['confirmVerificationCode'];
  private readonly _transportOptions: ConnectPairingRuntimeOptions;

  public constructor(options: ConnectPairingClientOptions) {
    this._relayOrigin = requirePublicOrigin(options.relayOrigin, 'relay origin');
    this._pairingUiUrl = requirePairingUiUrl(options.pairingUiUrl);
    this._onPairingReady = options.onPairingReady;
    this._confirmVerificationCode = options.confirmVerificationCode;
    this._transportOptions = options.transportOptions ?? {};
  }

  /**
   * Returns a transcript-verified response. The caller must still process and
   * validate the provider-signed grants before activating the session.
   */
  public async connect(params: ConnectPairingClientConnectParams): Promise<ConnectResult | undefined> {
    const delegatePortableDid = structuredClone(params.delegatePortableDid);
    const delegate = await DidJwk.import({ portableDid: delegatePortableDid });
    const session = await ConnectClientSession.create({ delegate });
    const transport = await RelayPairingClientTransport.create({
      ...this._transportOptions,
      clientCommitment : session.clientCommitment,
      relayOrigin      : this._relayOrigin,
    });
    const interactionUrl = buildConnectPairingInteractionUrl({
      pairingUiUrl : this._pairingUiUrl,
      pairingUri   : transport.pairingUri,
    });
    await this._onPairingReady({
      interactionUrl,
      pairingUri       : transport.pairingUri,
      expiresInSeconds : transport.expiresInSeconds,
    });

    const walletClaim = await transport.awaitWalletClaim();
    session.acceptWalletCommitment(walletClaim);
    await transport.publishClientReveal(session.revealClient());
    await session.acceptWalletReveal(await transport.awaitWalletReveal());
    await transport.sendRequest(await session.sealRequest({
      appName                    : params.appName,
      appIcon                    : params.appIcon,
      applicationId              : params.applicationId,
      clientMetadata             : params.clientMetadata,
      permissionRequests         : params.permissionRequests,
      requestedSessionTtlSeconds : params.requestedSessionTtlSeconds,
      requestType                : params.requestType,
      expectedProviderDid        : params.expectedProviderDid,
      supportedDidMethods        : params.supportedDidMethods,
      nonce                      : randomToken(),
      state                      : randomToken(),
    }));

    const verificationController = new AbortController();
    const verification = Promise.resolve()
      .then(async (): Promise<boolean> => await this._confirmVerificationCode({
        verificationCode : session.verificationCode,
        walletOrigin     : walletClaim.walletOrigin,
      }, verificationController.signal))
      .then(
        (matches): { matches: boolean } => ({ matches }),
        (error: unknown): { error: unknown } => ({ error }),
      );

    let openedDecision: Awaited<ReturnType<ConnectClientSession['openDecision']>>;
    try {
      openedDecision = await session.openDecision(await transport.awaitDecision());
    } catch (error) {
      verificationController.abort();
      throw error;
    }
    if (openedDecision.decision.decision === 'deny') {
      verificationController.abort();
      return undefined;
    }

    const verificationResult = await verification;
    if ('error' in verificationResult) {
      await transport.sendConfirmation(await session.createConfirmation(false));
      throw verificationResult.error;
    }
    const matches = verificationResult.matches;
    await transport.sendConfirmation(await session.createConfirmation(matches === true));
    if (matches !== true) {
      return undefined;
    }

    const response = await session.openApprovedResponse(await transport.awaitResponse());
    return {
      delegatePortableDid,
      delegateGrants     : response.delegateGrants,
      connectedDid       : response.providerDid,
      sessionRevocations : response.sessionRevocations,
    };
  }
}

/** Builds a selector URL whose only query value is the public pairing locator. */
export function buildConnectPairingInteractionUrl({ pairingUiUrl, pairingUri }: {
  pairingUiUrl: string;
  pairingUri: string;
}): string {
  requirePublicPairingUri(pairingUri);
  const url = new URL(requirePairingUiUrl(pairingUiUrl));
  url.searchParams.set(PAIRING_URI_PARAMETER, pairingUri);
  return url.toString();
}

function requirePairingUiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Connect: pairing UI URL must be a public HTTPS URL.');
  }
  requirePublicOrigin(url.origin, 'pairing UI origin');
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('Connect: pairing UI URL must not contain credentials, query parameters, or a fragment.');
  }
  return url.toString();
}

function requirePublicPairingUri(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Connect: pairing URI must be a public relay URL.');
  }
  requirePublicOrigin(url.origin, 'pairing relay origin');
  const pairingId = /^\/connect\/v3\/pairings\/([0-9a-f-]+)$/.exec(url.pathname)?.[1];
  if (
    pairingId === undefined
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pairingId)
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
    || url.toString() !== value
  ) {
    throw new Error('Connect: pairing URI must be a public relay URL.');
  }
}

function requirePublicOrigin(value: string, label: string): string {
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
  return value;
}
