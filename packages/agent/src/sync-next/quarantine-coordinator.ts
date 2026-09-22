import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncNextQuarantineEntry } from './types.js';
import type { SyncNextQuarantineRetry } from './quarantine-retry.js';
import type { SyncTarget } from '../sync-target-resolver.js';

import { runSerializedByKey } from '@enbox/common';

const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

export type SyncNextQuarantineAttempt = {
  kind: 'aborted' | 'deferred' | 'empty' | 'pending' | 'settled';
  nextDelay?: number;
  remaining: number;
};

type LogicalRetryState = {
  index: number;
  notBefore: Map<string, number>;
};

/** Serializes and backs off quarantine attempts across every binding for one logical target. */
export class SyncNextQuarantineCoordinator {
  private readonly _pending = new Map<string, Promise<void>>();
  private readonly _states = new Map<string, LogicalRetryState>();

  public constructor(
    private readonly _ledger: SyncNextLedgerStore,
    private readonly _retry: SyncNextQuarantineRetry,
  ) {}

  public retryOne(
    target: SyncTarget,
    shouldContinue: () => boolean = (): boolean => true,
    signal?: AbortSignal,
  ): Promise<SyncNextQuarantineAttempt> {
    const logicalTargetId = SyncNextQuarantineCoordinator.logicalTargetId(target);
    return runSerializedByKey(this._pending, logicalTargetId, async (): Promise<SyncNextQuarantineAttempt> => {
      if (!shouldContinue()) {
        return { kind: 'aborted', remaining: 0 };
      }
      const entries = await this._ledger.getQuarantineForLogicalTarget(logicalTargetId);
      if (entries.length === 0) {
        this._states.delete(logicalTargetId);
        return { kind: 'empty', remaining: 0 };
      }

      const state = this.state(logicalTargetId);
      const selected = SyncNextQuarantineCoordinator.selectEligible(entries, state);
      if (selected === undefined) {
        return {
          kind      : 'deferred',
          nextDelay : SyncNextQuarantineCoordinator.nextEligibilityDelay(entries, state.notBefore),
          remaining : entries.length,
        };
      }

      const entry = entries[selected];
      state.index = (selected + 1) % entries.length;
      try {
        const result = await this._retry.retry(target, entry, shouldContinue, signal);
        if (result.kind === 'aborted') {
          return { kind: 'aborted', remaining: entries.length };
        }
        if (result.kind === 'pending') {
          state.notBefore.set(
            SyncNextQuarantineCoordinator.receiptKey(entry),
            Date.now() + SyncNextQuarantineCoordinator.retryDelay(entry.attempts),
          );
        } else {
          state.notBefore.delete(SyncNextQuarantineCoordinator.receiptKey(entry));
        }
        const remaining = (await this._ledger.getQuarantineForLogicalTarget(logicalTargetId)).length;
        if (remaining === 0) {
          this._states.delete(logicalTargetId);
        }
        return {
          kind: result.kind,
          ...(remaining === 0
            ? {}
            : { nextDelay: SyncNextQuarantineCoordinator.nextEligibilityDelay(entries, state.notBefore) }),
          remaining,
        };
      } catch (error: unknown) {
        state.notBefore.set(
          SyncNextQuarantineCoordinator.receiptKey(entry),
          Date.now() + SyncNextQuarantineCoordinator.retryDelay(entry.attempts),
        );
        throw error;
      }
    });
  }

  public clearBackoff(target: SyncTarget): void {
    this._states.delete(SyncNextQuarantineCoordinator.logicalTargetId(target));
  }

  private state(logicalTargetId: string): LogicalRetryState {
    let state = this._states.get(logicalTargetId);
    if (state === undefined) {
      state = { index: 0, notBefore: new Map() };
      this._states.set(logicalTargetId, state);
    }
    return state;
  }

  private static selectEligible(
    entries: readonly SyncNextQuarantineEntry[],
    state: LogicalRetryState,
  ): number | undefined {
    const now = Date.now();
    for (let offset = 0; offset < entries.length; offset++) {
      const index = (state.index + offset) % entries.length;
      if ((state.notBefore.get(SyncNextQuarantineCoordinator.receiptKey(entries[index])) ?? 0) <= now) {
        return index;
      }
    }
  }

  private static nextEligibilityDelay(
    entries: readonly SyncNextQuarantineEntry[],
    notBefore: ReadonlyMap<string, number>,
  ): number {
    const now = Date.now();
    const next = Math.min(...entries.map(entry =>
      notBefore.get(SyncNextQuarantineCoordinator.receiptKey(entry)) ?? now
    ));
    return Math.max(0, next - now);
  }

  private static retryDelay(attempts: number): number {
    const exponent = Math.min(Math.max(0, attempts - 1), 6);
    return Math.min(RETRY_DELAY_MS * (2 ** exponent), MAX_RETRY_DELAY_MS);
  }

  private static receiptKey(entry: SyncNextQuarantineEntry): string {
    const identity = [
      entry.tenantDid,
      entry.remoteEndpoint,
      entry.projectionId,
      entry.authorizationEpoch,
      entry.source.streamId,
      entry.source.epoch,
      entry.source.position,
      entry.messageCid,
    ];
    return JSON.stringify(identity);
  }

  private static logicalTargetId(target: SyncTarget): string {
    return `${target.did}^${target.projectionId}`;
  }
}
