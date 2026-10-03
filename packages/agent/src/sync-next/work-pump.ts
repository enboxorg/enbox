import type { EnboxPlatformAgent } from '../types/agent.js';
import type { SyncNextDeliveryRetryResult } from './delivery-retry.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncNextPullPageResult } from './pull-page.js';
import type { SyncNextPushPageResult } from './push-page.js';
import type { SyncNextQuarantineRetryResult } from './quarantine-retry.js';
import type { SyncRemoteRequestRunner } from '../sync-request-runner.js';
import type { SyncTarget } from '../sync-target-resolver.js';

import { runWithCrossContextLock } from '@enbox/common';
import { DwnRpcError, isQuotaExceededError } from '@enbox/dwn-clients';

import { normalizeDwnEndpoint } from '../sync-target-resolver.js';
import { retryOneDeliveryObligation } from './delivery-retry.js';
import { retryOneQuarantinedRoot } from './quarantine-retry.js';
import { syncErrorMessage } from '../sync-runtime-errors.js';
import { SyncNextFeedQueryError } from './feed-page.js';
import { SyncNextPullPage } from './pull-page.js';
import { SyncNextPushPage } from './push-page.js';
import { SyncWorkInterruptedError } from '../sync-messages.js';
import { syncNextLinkIdentity, syncNextLinkKey } from './ledger-key.js';

type SyncNextWorkKind = 'delivery' | 'pullPage' | 'pushPage' | 'quarantine';

export type SyncNextWorkDirection = 'both' | 'pull' | 'push';

export type SyncNextWorkTargetStatus = {
  authorizationEpoch: string;
  projectionId: string;
  pull: {
    error?: string;
    feedCovered: boolean;
    pendingQuarantine: number;
  };
  push: {
    enabled: boolean;
    error?: string;
    feedCovered: boolean;
    pendingDelivery: number;
  };
  remoteEndpoint: string;
  tenantDid: string;
};

export type SyncNextWorkPumpResult = {
  budgetExhausted: boolean;
  cancelled: boolean;
  remoteRequests: number;
  targets: SyncNextWorkTargetStatus[];
  workRemaining: boolean;
};

type SyncNextWorkOperation<TResult> = (
  target: SyncTarget,
  shouldContinue: () => boolean,
  runRemoteRequest: SyncRemoteRequestRunner,
) => Promise<TResult>;

export type SyncNextWorkPumpOperations = {
  deliveryRetry: SyncNextWorkOperation<SyncNextDeliveryRetryResult>;
  pullPage: SyncNextWorkOperation<SyncNextPullPageResult>;
  pushPage: SyncNextWorkOperation<SyncNextPushPageResult>;
  quarantineRetry: SyncNextWorkOperation<SyncNextQuarantineRetryResult>;
};

type SyncNextWorkPumpOptions = {
  maxRemoteRequests?: number;
  operations?: Partial<SyncNextWorkPumpOperations>;
};

type TargetState = {
  errors: Partial<Record<SyncNextWorkKind, string>>;
  pullCovered: boolean;
  pullRequested: boolean;
  pushCovered: boolean;
  pushRequested: boolean;
  queue: SyncNextWorkKind[];
  target: SyncTarget;
};

type RequestBudget = {
  maxRequests: number;
  requests: number;
  signal?: AbortSignal;
};

const DEFAULT_MAX_REMOTE_REQUESTS = 32;

/** Executes one request-bounded sync-next turn for already-resolved targets. */
export class SyncNextWorkPump {
  public constructor(
    private readonly _agent: EnboxPlatformAgent,
    private readonly _ledger: SyncNextLedgerStore,
    private readonly _options: SyncNextWorkPumpOptions = {},
  ) {}

  /** Run one turn. Durable checkpoints and sparse rows carry unfinished work to the next turn. */
  public async run(
    targets: readonly SyncTarget[],
    direction: SyncNextWorkDirection = 'both',
    options: { maxRemoteRequests?: number; signal?: AbortSignal } = {},
  ): Promise<SyncNextWorkPumpResult> {
    const maxRequests = options.maxRemoteRequests ?? this._options.maxRemoteRequests ?? DEFAULT_MAX_REMOTE_REQUESTS;
    if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0) {
      throw new RangeError('SyncNextWorkPump: request budget must be a positive integer.');
    }
    const budget: RequestBudget = {
      maxRequests,
      requests: 0,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const states = this.createStates(targets, direction);
    await Promise.all(states.map(state => this.ensureLink(state.target)));
    const blockedEndpoints = new Set<string>();

    while (budget.signal?.aborted !== true && budget.requests < budget.maxRequests &&
      states.some(state => state.queue.length > 0)) {
      const work = this.takeRound(states, blockedEndpoints);
      if (work.length === 0) {
        break;
      }
      // Rounds are sequential so later work observes earlier ledger and endpoint results.
      await Promise.all(work.map(({ state, kind }) => // NOSONAR
        this.runWork(state, kind, budget, blockedEndpoints)
      ));
    }

    return this.buildResult(states, budget);
  }

  private createStates(targets: readonly SyncTarget[], direction: SyncNextWorkDirection): TargetState[] {
    const states = new Map<string, TargetState>();
    for (const target of targets) {
      const key = syncNextLinkKey(syncNextLinkIdentity(target));
      const state = states.get(key) ?? {
        errors        : {},
        pullCovered   : false,
        pullRequested : false,
        pushCovered   : false,
        pushRequested : false,
        queue         : [],
        target,
      };
      state.target = target;
      if (direction !== 'push') {
        state.pullRequested = true;
        this.enqueue(state, 'pullPage');
        this.enqueue(state, 'quarantine', true);
      }
      if (direction !== 'pull' && target.authorization.kind !== 'role') {
        state.pushRequested = true;
        this.enqueue(state, 'delivery');
        this.enqueue(state, 'pushPage');
      }
      states.set(key, state);
    }
    return [...states.values()];
  }

  private async ensureLink(target: SyncTarget): Promise<void> {
    await this._ledger.getOrCreateLink({
      ...syncNextLinkIdentity(target),
      authorization : target.authorization,
      scope         : target.scope,
    });
  }

  /** Select at most one link per endpoint and one quarantine owner per logical target. */
  private takeRound(
    states: TargetState[],
    blockedEndpoints: ReadonlySet<string>,
  ): Array<{ kind: SyncNextWorkKind; state: TargetState }> {
    const endpoints = new Set<string>();
    const quarantineTargets = new Set<string>();
    const work: Array<{ kind: SyncNextWorkKind; state: TargetState }> = [];
    for (const state of states) {
      const endpoint = normalizeDwnEndpoint(state.target.dwnUrl);
      if (blockedEndpoints.has(endpoint) || endpoints.has(endpoint)) {
        continue;
      }
      const kind = this.takeEligible(state, quarantineTargets);
      if (kind !== undefined) {
        endpoints.add(endpoint);
        work.push({ kind, state });
      }
    }
    for (const { state } of work) {
      states.splice(states.indexOf(state), 1);
      states.push(state);
    }
    return work;
  }

  private takeEligible(state: TargetState, quarantineTargets: Set<string>): SyncNextWorkKind | undefined {
    for (let index = 0; index < state.queue.length; index++) {
      const kind = state.queue[index];
      if (kind === 'quarantine') {
        const logicalKey = this.logicalTargetKey(state.target);
        if (quarantineTargets.has(logicalKey)) {
          continue;
        }
        quarantineTargets.add(logicalKey);
      }
      state.queue.splice(index, 1);
      return kind;
    }
  }

  private async runWork(
    state: TargetState,
    kind: SyncNextWorkKind,
    budget: RequestBudget,
    blockedEndpoints: Set<string>,
  ): Promise<void> {
    const endpoint = normalizeDwnEndpoint(state.target.dwnUrl);
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
      delete state.errors[kind];
    } catch (error: unknown) {
      state.errors[kind] = syncErrorMessage(error);
      if (this.isEndpointFailure(error)) {
        blockedEndpoints.add(endpoint);
      }
    }
  }

  private async runPullPage(
    state: TargetState,
    shouldContinue: () => boolean,
    runRemoteRequest: SyncRemoteRequestRunner,
  ): Promise<void> {
    const result = await (this._options.operations?.pullPage?.(
      state.target, shouldContinue, runRemoteRequest,
    ) ?? new SyncNextPullPage(this._agent, this._ledger, runRemoteRequest).consume(state.target, shouldContinue));
    if (result.kind !== 'committed') {
      return;
    }
    state.pullCovered = !result.hasMore;
    if (result.hasMore) {
      this.enqueue(state, 'pullPage');
    }
    if ((await this._ledger.getQuarantineForLogicalTarget(
      state.target.did, state.target.projectionId,
    )).length > 0) {
      this.enqueue(state, 'quarantine', true);
    }
  }

  private async runQuarantine(
    state: TargetState,
    shouldContinue: () => boolean,
    runRemoteRequest: SyncRemoteRequestRunner,
  ): Promise<void> {
    const result = await (this._options.operations?.quarantineRetry?.(
      state.target, shouldContinue, runRemoteRequest,
    ) ?? retryOneQuarantinedRoot({
      agent: this._agent, ledger: this._ledger, target: state.target, shouldContinue, runRemoteRequest,
    }));
    if (result.kind === 'settled' && (await this._ledger.getQuarantineForLogicalTarget(
      state.target.did, state.target.projectionId,
    )).length > 0) {
      this.enqueue(state, 'quarantine');
    }
  }

  private async runPushPage(
    state: TargetState,
    shouldContinue: () => boolean,
    runRemoteRequest: SyncRemoteRequestRunner,
    blockedEndpoints: Set<string>,
  ): Promise<void> {
    const result = await (this._options.operations?.pushPage?.(
      state.target, shouldContinue, runRemoteRequest,
    ) ?? new SyncNextPushPage(this._agent, this._ledger, runRemoteRequest).consume(state.target, shouldContinue));
    if (result.kind !== 'committed') {
      return;
    }
    state.pushCovered = !result.hasMore;
    if (result.hasMore) {
      this.enqueue(state, 'pushPage');
    }
    if (result.blocked?.blockScope === 'endpoint') {
      blockedEndpoints.add(normalizeDwnEndpoint(state.target.dwnUrl));
    }
    if ((await this._ledger.getDeliveryForLink(syncNextLinkIdentity(state.target))).length > 0) {
      this.enqueue(state, 'delivery');
    }
  }

  private async runDelivery(
    state: TargetState,
    shouldContinue: () => boolean,
    runRemoteRequest: SyncRemoteRequestRunner,
    blockedEndpoints: Set<string>,
  ): Promise<void> {
    const result = await (this._options.operations?.deliveryRetry?.(
      state.target, shouldContinue, runRemoteRequest,
    ) ?? retryOneDeliveryObligation({
      agent: this._agent, ledger: this._ledger, target: state.target, shouldContinue, runRemoteRequest,
    }));
    const remaining = (await this._ledger.getDeliveryForLink(syncNextLinkIdentity(state.target))).length;
    if (result.kind === 'settled' && remaining > 0) {
      this.enqueue(state, 'delivery');
    } else if (result.kind === 'pending' && result.outcome.blockScope === 'endpoint') {
      blockedEndpoints.add(normalizeDwnEndpoint(state.target.dwnUrl));
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
        if (budget.signal?.aborted === true || budget.requests >= budget.maxRequests) {
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
          if (this.isEndpointFailure(error)) {
            blockedEndpoints.add(endpoint);
          }
          throw error;
        }
      });
  }

  private isEndpointFailure(error: unknown): boolean {
    if (error instanceof SyncWorkInterruptedError) {
      return false;
    }
    if (error instanceof SyncNextFeedQueryError) {
      return error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500;
    }
    if (error instanceof DwnRpcError) {
      return !error.terminal && !isQuotaExceededError(error.message, error.data);
    }
    return error instanceof Error;
  }

  private async buildResult(states: TargetState[], budget: RequestBudget): Promise<SyncNextWorkPumpResult> {
    const built = await Promise.all(states.map(state => this.buildTargetStatus(state)));
    return {
      budgetExhausted : budget.signal?.aborted !== true && budget.requests >= budget.maxRequests,
      cancelled       : budget.signal?.aborted === true,
      remoteRequests  : budget.requests,
      targets         : built.map(([status]) => status),
      workRemaining   : built.some(([, remaining]) => remaining),
    };
  }

  private async buildTargetStatus(state: TargetState): Promise<[SyncNextWorkTargetStatus, boolean]> {
    const [quarantine, delivery] = await Promise.all([
      this._ledger.getQuarantineForLogicalTarget(state.target.did, state.target.projectionId),
      this._ledger.getDeliveryForLink(syncNextLinkIdentity(state.target)),
    ]);
    const status: SyncNextWorkTargetStatus = {
      authorizationEpoch : state.target.authorizationEpoch,
      projectionId       : state.target.projectionId,
      pull               : {
        ...errorProperty(state.errors.pullPage ?? state.errors.quarantine),
        feedCovered       : state.pullCovered,
        pendingQuarantine : quarantine.length,
      },
      push: {
        enabled         : state.target.authorization.kind !== 'role',
        ...errorProperty(state.errors.pushPage ?? state.errors.delivery),
        feedCovered     : state.pushCovered,
        pendingDelivery : delivery.length,
      },
      remoteEndpoint : normalizeDwnEndpoint(state.target.dwnUrl),
      tenantDid      : state.target.did,
    };
    return [status, state.queue.length > 0 ||
        (state.pullRequested && (!state.pullCovered || quarantine.length > 0)) ||
        (state.pushRequested && (!state.pushCovered || delivery.length > 0))];
  }

  private enqueue(state: TargetState, kind: SyncNextWorkKind, first = false): void {
    if (state.queue.includes(kind)) {
      return;
    }
    if (first) {
      state.queue.unshift(kind);
    } else {
      state.queue.push(kind);
    }
  }

  private logicalTargetKey(target: SyncTarget): string {
    return `${target.did}\n${target.projectionId}`;
  }
}

function errorProperty(error: string | undefined): { error?: string } {
  return error === undefined ? {} : { error };
}
