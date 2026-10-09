import type { EnboxPlatformAgent } from '../types/agent.js';
import type { SyncDirection } from '../types/sync.js';
import type { SyncNextDeliveryRetryResult } from './delivery-retry.js';
import type { SyncNextProgressStore } from './progress-store.js';
import type { SyncNextPullPageResult } from './pull-page.js';
import type { SyncNextPushPageResult } from './push-page.js';
import type { SyncNextQuarantineRetryResult } from './quarantine-retry.js';
import type { SyncRemoteRequestRunner } from '../sync-request-runner.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type {
  SyncNextDeliveryObligation,
  SyncNextLinkIdentity,
  SyncNextQuarantineEntry,
} from './types.js';

import { runWithCrossContextLock } from '@enbox/common';
import { DwnRpcError, isQuotaExceededError } from '@enbox/dwn-clients';

import { retryOneDeliveryObligation } from './delivery-retry.js';
import { retryOneQuarantinedRoot } from './quarantine-retry.js';
import { syncErrorMessage } from '../sync-runtime-errors.js';
import { SyncNextFeedQueryError } from './feed-page.js';
import { SyncNextPullPage } from './pull-page.js';
import { SyncNextPushPage } from './push-page.js';
import { SyncWorkInterruptedError } from '../sync-messages.js';
import { compareSyncNextRetryOrder, syncNextLinkIdentity, syncNextLinkKey } from './progress-key.js';

type SyncNextWorkKind = 'delivery' | 'pullPage' | 'pushPage' | 'quarantine';

export type SyncNextWorkFailure = {
  message: string;
  target: SyncNextLinkIdentity;
  work: SyncNextWorkKind;
};

export type SyncNextRunResult = {
  failures: SyncNextWorkFailure[];
  remoteRequests: number;
  workRemaining: boolean;
};

type SyncNextWorkOperation<TResult> = (
  target: SyncTarget,
  shouldContinue: () => boolean,
  runRemoteRequest: SyncRemoteRequestRunner,
) => Promise<TResult>;

export type SyncNextRunnerOperations = {
  deliveryRetry: SyncNextWorkOperation<SyncNextDeliveryRetryResult>;
  pullPage: SyncNextWorkOperation<SyncNextPullPageResult>;
  pushPage: SyncNextWorkOperation<SyncNextPushPageResult>;
  quarantineRetry: SyncNextWorkOperation<SyncNextQuarantineRetryResult>;
};

type TargetState = {
  feedDrained: boolean;
  failures: SyncNextWorkFailure[];
  identity: SyncNextLinkIdentity;
  target: SyncTarget;
};

type RecoveryCandidate = {
  entry: SyncNextDeliveryObligation | SyncNextQuarantineEntry;
  state: TargetState;
};

type RequestBudget = {
  limit: number;
  requests: number;
  signal: AbortSignal | undefined;
};

const DEFAULT_MAX_REMOTE_REQUESTS = 32;

/** Executes one request-bounded sync-next run for already-resolved targets. */
export class SyncNextRunner {
  public constructor(
    private readonly _agent: EnboxPlatformAgent,
    private readonly _progressStore: SyncNextProgressStore,
    private readonly _operations: Partial<SyncNextRunnerOperations> = {},
  ) {}

  /** Run one direction. Durable checkpoints and pending rows carry unfinished work to the next run. */
  public async run(
    targets: readonly SyncTarget[],
    direction: SyncDirection,
    options: { maxRemoteRequests?: number; signal?: AbortSignal } = {},
  ): Promise<SyncNextRunResult> {
    const maxRequests = options.maxRemoteRequests ?? DEFAULT_MAX_REMOTE_REQUESTS;
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 3) {
      throw new RangeError('SyncNextRunner: request budget must be an integer of at least 3.');
    }
    const budget: RequestBudget = {
      limit    : maxRequests,
      requests : 0,
      signal   : options.signal,
    };
    const states = this.createStates(targets, direction);
    await Promise.all(states.map(state => this.ensureLink(state)));
    const blockedEndpoints = new Set<string>();
    const page = direction === 'pull' ? 'pullPage' : 'pushPage';
    const retry = direction === 'pull' ? 'quarantine' : 'delivery';
    const pendingRecovery = await this.getRecoveryCandidates(states, direction);
    const recoveryReserve = pendingRecovery.reduce(
      (reserve, candidate) => Math.max(reserve, this.minimumRecoveryRequests(candidate, retry)),
      0,
    );
    // Preserve capacity for existing pending work without slowing the common queue-empty path.
    budget.limit = recoveryReserve > 0
      ? Math.min(Math.ceil(maxRequests / 2), maxRequests - recoveryReserve)
      : maxRequests;
    await this.runPhase(states, page, budget, blockedEndpoints);
    budget.limit = maxRequests;
    const recovery = await this.getRecoveryCandidates(states, direction);
    await this.runRecoveryPhase(recovery, retry, budget, blockedEndpoints);

    return this.buildResult(states, budget, direction);
  }

  private createStates(targets: readonly SyncTarget[], direction: SyncDirection): TargetState[] {
    const states = new Map<string, TargetState>();
    for (const target of targets) {
      if (direction === 'push' && target.authorization.kind === 'role') {
        continue;
      }
      const identity = syncNextLinkIdentity(target);
      const key = syncNextLinkKey(identity);
      if (states.has(key)) {
        continue;
      }
      const state: TargetState = {
        feedDrained : false,
        failures    : [],
        identity,
        target,
      };
      states.set(key, state);
    }
    return [...states.values()];
  }

  private async ensureLink(state: TargetState): Promise<void> {
    await this._progressStore.getOrCreateLink({
      ...state.identity,
      authorization : state.target.authorization,
      scope         : state.target.scope,
    });
  }

  private async runPhase(
    states: TargetState[],
    kind: SyncNextWorkKind,
    budget: RequestBudget,
    blockedEndpoints: Set<string>,
  ): Promise<void> {
    if (budget.signal?.aborted === true || budget.requests >= budget.limit) {
      return;
    }
    await Promise.all(states.map(state => // NOSONAR
      this.runWork(state, kind, budget, blockedEndpoints)
    ));
  }

  /** Run pending recovery oldest-first without starting a partial role attempt. */
  private async runRecoveryPhase(
    candidates: RecoveryCandidate[],
    kind: SyncNextWorkKind,
    budget: RequestBudget,
    blockedEndpoints: Set<string>,
  ): Promise<void> {
    for (const candidate of candidates) {
      if (budget.signal?.aborted === true || budget.requests >= budget.limit) {
        return;
      }
      if (budget.limit - budget.requests < this.minimumRecoveryRequests(candidate, kind)) {
        continue;
      }
      await this.runWork(candidate.state, kind, budget, blockedEndpoints); // NOSONAR: S9382 - recovery must remain oldest-first.
    }
  }

  private async getRecoveryCandidates(
    states: TargetState[],
    direction: SyncDirection,
  ): Promise<RecoveryCandidate[]> {
    const pending = await Promise.all(states.map(async (state) => {
      const entries = direction === 'pull'
        ? await this._progressStore.getQuarantineForProjection(state.identity.tenantDid, state.identity.projectionId)
        : await this._progressStore.getDeliveryForLink(state.identity);
      entries.sort(compareSyncNextRetryOrder);
      return { entry: entries[0], state };
    }));
    return pending
      .flatMap(({ entry, state }) => entry === undefined ? [] : [{ entry, state }])
      .sort((left, right) => compareSyncNextRetryOrder(left.entry, right.entry));
  }

  private minimumRecoveryRequests(candidate: RecoveryCandidate, kind: SyncNextWorkKind): number {
    return kind === 'quarantine' && candidate.state.target.authorization.kind === 'role' ? 2 : 1;
  }

  private async runWork(
    state: TargetState,
    kind: SyncNextWorkKind,
    budget: RequestBudget,
    blockedEndpoints: Set<string>,
  ): Promise<void> {
    const endpoint = state.identity.remoteEndpoint;
    const shouldContinue = (): boolean => budget.signal?.aborted !== true;
    const runRemoteRequest = this.requestRunner(endpoint, budget, blockedEndpoints);
    try {
      switch (kind) {
        case 'pullPage':
          await this.runPullPage(state, shouldContinue, runRemoteRequest);
          break;
        case 'quarantine':
          await this.runQuarantine(state, shouldContinue, runRemoteRequest);
          break;
        case 'pushPage':
          await this.runPushPage(state, shouldContinue, runRemoteRequest, blockedEndpoints);
          break;
        case 'delivery':
          await this.runDelivery(state, shouldContinue, runRemoteRequest, blockedEndpoints);
          break;
      }
    } catch (error: unknown) {
      if (!(error instanceof SyncWorkInterruptedError)) {
        state.failures.push({ message: syncErrorMessage(error), target: state.identity, work: kind });
      }
      // Other exceptions can come from local validation or progress-store mutation and stay link-scoped.
      if (kind === 'pullPage' && error instanceof SyncNextFeedQueryError &&
          (error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500)) {
        blockedEndpoints.add(endpoint);
      }
    }
  }

  private async runPullPage(
    state: TargetState,
    shouldContinue: () => boolean,
    runRemoteRequest: SyncRemoteRequestRunner,
  ): Promise<void> {
    const result = await (this._operations.pullPage?.(
      state.target, shouldContinue, runRemoteRequest,
    ) ?? new SyncNextPullPage(this._agent, this._progressStore, runRemoteRequest).run(state.target, shouldContinue));
    if (result.kind !== 'committed') {
      return;
    }
    state.feedDrained = result.feedDrained;
  }

  private async runQuarantine(
    state: TargetState,
    shouldContinue: () => boolean,
    runRemoteRequest: SyncRemoteRequestRunner,
  ): Promise<void> {
    const lock = `enbox:sync-next-quarantine:${JSON.stringify([
      state.identity.tenantDid, state.identity.projectionId,
    ])}`;
    await runWithCrossContextLock(lock, async (): Promise<void> => {
      await (this._operations.quarantineRetry?.(
        state.target, shouldContinue, runRemoteRequest,
      ) ?? retryOneQuarantinedRoot({
        agent: this._agent, progressStore: this._progressStore, target: state.target, shouldContinue, runRemoteRequest,
      }));
    });
  }

  private async runPushPage(
    state: TargetState,
    shouldContinue: () => boolean,
    runRemoteRequest: SyncRemoteRequestRunner,
    blockedEndpoints: Set<string>,
  ): Promise<void> {
    const result = await (this._operations.pushPage?.(
      state.target, shouldContinue, runRemoteRequest,
    ) ?? new SyncNextPushPage(this._agent, this._progressStore, runRemoteRequest).run(state.target, shouldContinue));
    if (result.kind !== 'committed') {
      return;
    }
    state.feedDrained = result.feedDrained;
    if (result.blocked?.blockScope === 'endpoint') {
      blockedEndpoints.add(state.identity.remoteEndpoint);
    }
  }

  private async runDelivery(
    state: TargetState,
    shouldContinue: () => boolean,
    runRemoteRequest: SyncRemoteRequestRunner,
    blockedEndpoints: Set<string>,
  ): Promise<void> {
    const result = await (this._operations.deliveryRetry?.(
      state.target, shouldContinue, runRemoteRequest,
    ) ?? retryOneDeliveryObligation({
      agent: this._agent, progressStore: this._progressStore, target: state.target, shouldContinue, runRemoteRequest,
    }));
    if (result.kind === 'pending' && result.outcome.blockScope === 'endpoint') {
      blockedEndpoints.add(state.identity.remoteEndpoint);
    }
  }

  private requestRunner(
    endpoint: string,
    budget: RequestBudget,
    blockedEndpoints: Set<string>,
  ): SyncRemoteRequestRunner {
    return <T>(request: (signal?: AbortSignal) => Promise<T>): Promise<T> =>
      runWithCrossContextLock(`enbox:sync-next-endpoint:${endpoint}`, async (): Promise<T> => {
        if (blockedEndpoints.has(endpoint)) {
          throw new SyncWorkInterruptedError();
        }
        if (budget.signal?.aborted === true || budget.requests >= budget.limit) {
          throw new SyncWorkInterruptedError(budget.signal?.aborted === true ? 'stopped' : 'budget');
        }
        budget.requests++;
        const signal = budget.signal;
        try {
          return await request(signal);
        } catch (error: unknown) {
          if (signal?.aborted === true) {
            throw new SyncWorkInterruptedError();
          }
          if (this.isRemoteRequestFailure(error)) {
            blockedEndpoints.add(endpoint);
          }
          throw error;
        }
      });
  }

  private isRemoteRequestFailure(error: unknown): boolean {
    if (error instanceof SyncWorkInterruptedError) {
      return false;
    }
    if (error instanceof DwnRpcError) {
      return !error.terminal && !isQuotaExceededError(error.message, error.data);
    }
    return error instanceof Error;
  }

  private async buildResult(
    states: TargetState[],
    budget: RequestBudget,
    direction: SyncDirection,
  ): Promise<SyncNextRunResult> {
    const remaining = await Promise.all(states.map(state => this.hasRemainingWork(state, direction)));
    return {
      failures       : states.flatMap(state => state.failures),
      remoteRequests : budget.requests,
      workRemaining  : remaining.some(Boolean),
    };
  }

  private async hasRemainingWork(state: TargetState, direction: SyncDirection): Promise<boolean> {
    if (!state.feedDrained) {
      return true;
    }
    return this.hasPendingRecovery(state, direction);
  }

  private async hasPendingRecovery(state: TargetState, direction: SyncDirection): Promise<boolean> {
    const pending = direction === 'pull'
      ? await this._progressStore.getQuarantineForProjection(state.identity.tenantDid, state.identity.projectionId)
      : await this._progressStore.getDeliveryForLink(state.identity);
    return pending.length > 0;
  }

}
