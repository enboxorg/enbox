import type { EnboxPlatformAgent } from '../types/agent.js';
import type { SyncNextDeliveryObligation } from './types.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncTarget } from '../sync-target-resolver.js';

import { RemoteApplyPushContext } from '../sync-messages.js';
import { SyncNextPushPage } from './push-page.js';

export type SyncNextDeliveryRetryResult = {
  aborted?: true;
  kind: 'aborted' | 'pending' | 'settled';
};

/** Retries one exact outbound obligation from the authoritative local feed. */
export class SyncNextDeliveryRetry {
  public constructor(
    private readonly _agent: EnboxPlatformAgent,
    private readonly _ledger: SyncNextLedgerStore,
  ) {}

  public async retry(
    target: SyncTarget,
    obligation: SyncNextDeliveryObligation,
    shouldContinue: () => boolean = (): boolean => true,
    signal?: AbortSignal,
  ): Promise<SyncNextDeliveryRetryResult> {
    if (target.authorization.kind === 'role' || !shouldContinue()) {
      return { aborted: true, kind: 'aborted' };
    }
    if (
      obligation.tenantDid !== target.did ||
      obligation.remoteEndpoint !== target.dwnUrl ||
      obligation.projectionId !== target.projectionId ||
      obligation.authorizationEpoch !== target.authorizationEpoch
    ) {
      throw new Error('SyncNextDeliveryRetry: target does not own this delivery obligation.');
    }
    const context = new RemoteApplyPushContext({
      agent              : this._agent,
      did                : target.did,
      dwnUrl             : target.dwnUrl,
      delegateDid        : target.delegateDid,
      permissionGrantIds : target.permissionGrantIds,
      permissionsApi     : this._agent.permissions,
      signal,
    });
    const result = await context.push([obligation.messageCid]);
    if (!shouldContinue()) {
      return { aborted: true, kind: 'aborted' };
    }

    const failure = result.failed.find(({ cid }): boolean => cid === obligation.messageCid);
    if (failure === undefined) {
      await this._ledger.settleDelivery(obligation, obligation);
      return { kind: 'settled' };
    }

    await this._ledger.updateDelivery(obligation, SyncNextPushPage.deliveryOutcome(failure));
    return { kind: 'pending' };
  }
}
