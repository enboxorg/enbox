import type { ConnectPairingRuntimeOptions } from './pairing-client.js';
import type { ConnectApprovalV3, ConnectRequestV3 } from './pairing-session.js';

import { DidJwk } from '@enbox/dids';

import { ConnectProviderSession } from './pairing-session.js';
import { RelayPairingWalletTransport } from './relay-pairing-transport.js';

/** Wallet-side result of a Connect v3 pairing attempt. */
export type ConnectPairingProviderResult = 'approved' | 'denied' | 'rejected';

/** Profile selected after the wallet displays the request and comparison code. */
export type ConnectPairingProviderDecision = {
  providerDid: string;
};

/** Options for handling one wallet-side Connect v3 pairing. */
export type ConnectPairingProviderOptions = {
  /** Public pairing URL received by the wallet. */
  pairingUri: string;

  /** Canonical origin of the trusted wallet UI. */
  walletOrigin: string;

  /**
   * Displays the request and comparison code in trusted wallet UI.
   * Return a profile only after the user approves and confirms the code.
   */
  decide: (
    request: Readonly<ConnectRequestV3>,
    verificationCode: string,
  ) => Promise<ConnectPairingProviderDecision | undefined> | ConnectPairingProviderDecision | undefined;

  /** Creates grants after both the wallet and requester confirm the code. */
  approve: (
    request: Readonly<ConnectRequestV3>,
    providerDid: string,
  ) => Promise<ConnectApprovalV3>;

  /** Optional relay runtime overrides and cancellation signal. */
  transportOptions?: ConnectPairingRuntimeOptions;
};

/** Drives the wallet side of a Connect v3 relay pairing. */
export class ConnectPairingProvider {
  public static async handle(options: ConnectPairingProviderOptions): Promise<ConnectPairingProviderResult> {
    const session = await ConnectProviderSession.create({ walletSigner: await DidJwk.create() });
    const transport = await RelayPairingWalletTransport.claim({
      ...options.transportOptions,
      pairingUri       : options.pairingUri,
      walletCommitment : session.walletCommitment,
      walletOrigin     : options.walletOrigin,
    });

    session.acceptRelayClaim({
      pairingId        : transport.pairingId,
      relayOrigin      : transport.relayOrigin,
      walletOrigin     : transport.walletOrigin,
      clientCommitment : transport.clientCommitment,
    });
    await session.acceptClientReveal(await transport.awaitClientReveal());
    await transport.publishWalletReveal(await session.revealWallet());

    const request = await session.openRequest(await transport.awaitRequest());
    const decision = await options.decide(request, session.verificationCode);
    if (decision === undefined) {
      await transport.sendDecision((await session.sealDenial()).frame);
      return 'denied';
    }
    const providerDid = decision.providerDid;

    const intent = await session.sealApprovalIntent({
      providerDid,
      localMatches: true,
    });
    await transport.sendDecision(intent.frame);

    const response = await session.confirmAndSealResponse({
      confirmationFrame : await transport.awaitConfirmation(),
      approve           : async (approvedRequest): Promise<ConnectApprovalV3> =>
        await options.approve(approvedRequest, providerDid),
    });
    if (response === undefined) {
      return 'rejected';
    }

    await transport.sendResponse(response);
    return 'approved';
  }
}
