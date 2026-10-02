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
import { SyncPullAbortedError } from '../sync-messages.js';
import { syncNextLinkIdentity, syncNextLinkKey } from './ledger-key.js';

type SyncNextWorkKind = 'delivery' | 'pullPage' | 'pushPage' | 'quarantine';

export type SyncNextWorkDirection = 'both' | 'pull' | 'push';

export type SyncNextWorkPumpRunOptions = {
  maxDurationMs?: number;
  maxRemoteRequests?: number;
  signal?: AbortSignal;
};

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
  nextRunAt?: string;
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
  cooldownMs?: number;
  maxDurationMs?: number;
  maxRemoteRequests?: number;
  now?: () => number;
  operations?: Partial<SyncNextWorkPumpOperations>;
};

type TargetState = {
  errors: Partial<Record<SyncNextWorkKind, string>>;
  notBefore: Partial<Record<SyncNextWorkKind, number>>;
  pullCovered: boolean;
  pushCovered: boolean;
  queue: SyncNextWorkKind[];
  target: SyncTarget;
};

type QuarantineAttempt = {
  remaining: number;
  result: SyncNextQuarantineRetryResult;
};

const DEFAULT_COOLDOWN_MS = 1_000;
const DEFAULT_MAX_DURATION_MS = 1_000;
const DEFAULT_MAX_REMOTE_REQUESTS = 32;

/**
 * Runs bounded sync-next work for already-resolved targets.
 *
 * It owns no target discovery, subscriptions, or durable scheduling policy.
 * Callers add coalesced work marks and invoke `drain()`; a returned `nextRunAt`
 * can be handed to the later runtime timer owner.
 */
export class SyncNextWorkPump {
  private _drain?: Promise<SyncNextWorkPumpResult>;
  private readonly _endpointCooldowns = new Map<string, number>();
  private readonly _operations: SyncNextWorkPumpOperations;
  private readonly _states = new Map<string, TargetState>();

  public constructor(
    private readonly _agent: EnboxPlatformAgent,
    private readonly _ledger: SyncNextLedgerStore,
    private readonly _options: SyncNextWorkPumpOptions = {},
  ) {
    this._operations = {
      deliveryRetry: (target, shouldContinue, runRemoteRequest): Promise<SyncNextDeliveryRetryResult> =>
        retryOneDeliveryObligation({
          agent: this._agent, ledger: this._ledger, target, shouldContinue, runRemoteRequest,
        }),
      pullPage: (target, shouldContinue, runRemoteRequest): Promise<SyncNextPullPageResult> =>
        new SyncNextPullPage(this._agent, this._ledger, runRemoteRequest).consume(target, shouldContinue),
      pushPage: (target, shouldContinue, runRemoteRequest): Promise<SyncNextPushPageResult> =>
        new SyncNextPushPage(this._agent, this._ledger, runRemoteRequest).consume(target, shouldContinue),
      quarantineRetry: (
        target, shouldContinue, runRemoteRequest,
      ): Promise<SyncNextQuarantineRetryResult> => retryOneQuarantinedRoot({
        agent: this._agent, ledger: this._ledger, target, shouldContinue, runRemoteRequest,
      }),
      ..._options.operations,
    };
  }

  /** Add a coalesced direction wake without starting background work. */
  public request(target: SyncTarget, direction: SyncNextWorkDirection = 'both'): void {
    const state = this.getOrCreateState(target);
    if (direction === 'pull' || direction === 'both') {
      state.pullCovered = false;
      delete state.notBefore.pullPage;
      delete state.notBefore.quarantine;
      this.enqueue(state, 'pullPage');
    }
    if ((direction === 'push' || direction === 'both') && target.authorization.kind !== 'role') {
      state.pushCovered = false;
      delete state.notBefore.delivery;
      delete state.notBefore.pushPage;
      this.enqueue(state, 'pushPage');
    }
  }

  /** Request work for resolved targets and drain it under one bounded budget. */
  public async run(
    targets: readonly SyncTarget[],
    direction: SyncNextWorkDirection = 'both',
    options: SyncNextWorkPumpRunOptions = {},
  ): Promise<SyncNextWorkPumpResult> {
    for (const target of targets) {
      this.request(target, direction);
    }
    return this.drain(options);
  }

  /** Drain eligible coalesced work. Concurrent callers join the active owner. */
  public drain(options: SyncNextWorkPumpRunOptions = {}): Promise<SyncNextWorkPumpResult> {
    if (this._drain !== undefined) {
      return this._drain.then(
        (): Promise<SyncNextWorkPumpResult> => this.drain(options),
        (): Promise<SyncNextWorkPumpResult> => this.drain(options),
      );
    }

    const budget = new WorkBudget(
      options.maxRemoteRequests ?? this._options.maxRemoteRequests ?? DEFAULT_MAX_REMOTE_REQUESTS,
      options.maxDurationMs ?? this._options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
      options.signal,
      this.now,
    );
    const drain = this.drainOwned(budget);
    this._drain = drain;
    const release = (): void => {
      if (this._drain === drain) {
        this._drain = undefined;
      }
    };
    drain.then(release, release);
    return drain;
  }

  private async drainOwned(budget: WorkBudget): Promise<SyncNextWorkPumpResult> {
    await this.seedSparseWork();
    while (this.hasEligibleWork()) {
      if (!budget.canStartWork()) {
        break;
      }
      const work = this.takeRound();
      if (work.length === 0) {
        break;
      }
      await Promise.all(work.map(({ state, kind }) => this.runWork(state, kind, budget)));
    }

    return this.buildResult(budget);
  }

  private hasEligibleWork(): boolean {
    return [...this._states.values()].some(state => {
      const endpointReady = this.endpointIsEligible(normalizeDwnEndpoint(state.target.dwnUrl));
      return state.queue.some(kind =>
        (state.notBefore[kind] ?? 0) <= this.now() && (kind === 'quarantine' || endpointReady)
      );
    });
  }

  /** Select at most one link per endpoint for this round. */
  private takeRound(): Array<{ kind: SyncNextWorkKind; state: TargetState }> {
    const endpoints = new Set<string>();
    const quarantineTargets = new Set<string>();
    const work: Array<{ kind: SyncNextWorkKind; state: TargetState }> = [];
    for (const state of this._states.values()) {
      const endpoint = normalizeDwnEndpoint(state.target.dwnUrl);
      if (endpoints.has(endpoint)) {
        continue;
      }
      const kind = this.takeEligible(state, quarantineTargets, this.endpointIsEligible(endpoint));
      if (kind === undefined) {
        continue;
      }
      endpoints.add(endpoint);
      work.push({ kind, state });
    }
    for (const { state } of work) {
      const key = syncNextLinkKey(syncNextLinkIdentity(state.target));
      this._states.delete(key);
      this._states.set(key, state);
    }
    return work;
  }

  private async runWork(state: TargetState, kind: SyncNextWorkKind, budget: WorkBudget): Promise<void> {
    const endpoint = normalizeDwnEndpoint(state.target.dwnUrl);
    const shouldContinue = (): boolean => !budget.cancelled;
    const runRemoteRequest = this.requestRunner(endpoint, budget);

    try {
      await this.ensureLink(state.target);
      switch (kind) {
        case 'pullPage':
          await this.runPullPage(state, shouldContinue, runRemoteRequest);
          break;
        case 'quarantine':
          await this.runQuarantine(state, shouldContinue, runRemoteRequest);
          break;
        case 'pushPage':
          await this.runPushPage(state, shouldContinue, runRemoteRequest);
          break;
        case 'delivery':
          await this.runDelivery(state, shouldContinue, runRemoteRequest);
          break;
      }
      delete state.errors[kind];
    } catch (error: unknown) {
      state.errors[kind] = syncErrorMessage(error);
      this.defer(state, kind);
      if (kind === 'pullPage' && error instanceof SyncNextFeedQueryError &&
          (error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500)) {
        this.coolEndpoint(endpoint);
      }
    }
  }

  private async runPullPage(
    state: TargetState,
    shouldContinue: () => boolean,
    runRemoteRequest: SyncRemoteRequestRunner,
  ): Promise<void> {
    const result = await this._operations.pullPage(state.target, shouldContinue, runRemoteRequest);
    if (result.kind !== 'committed') {
      if (result.kind === 'aborted') {
        this.enqueue(state, 'pullPage');
      } else {
        state.pullCovered = false;
      }
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
    const logicalKey = this.logicalTargetKey(state.target);
    const { result, remaining } = await runWithCrossContextLock(
      `enbox:sync-next-quarantine:${logicalKey}`,
      async (): Promise<QuarantineAttempt> => {
        const result = await this._operations.quarantineRetry(state.target, shouldContinue, runRemoteRequest);
        const remaining = (await this._ledger.getQuarantineForLogicalTarget(
          state.target.did, state.target.projectionId,
        )).length;
        return { result, remaining };
      },
    );
    if (result.kind === 'aborted') {
      if (this.endpointIsEligible(normalizeDwnEndpoint(state.target.dwnUrl))) {
        this.enqueue(state, 'quarantine');
      } else {
        this.defer(state, 'quarantine');
      }
    } else if (result.kind === 'settled' && remaining > 0) {
      this.enqueue(state, 'quarantine');
    } else if (result.kind === 'pending' && remaining > 0) {
      this.deferLogicalQuarantine(state.target);
    }
  }

  private async runPushPage(
    state: TargetState,
    shouldContinue: () => boolean,
    runRemoteRequest: SyncRemoteRequestRunner,
  ): Promise<void> {
    const result = await this._operations.pushPage(state.target, shouldContinue, runRemoteRequest);
    if (result.kind !== 'committed') {
      if (result.kind === 'aborted') {
        this.enqueue(state, 'pushPage');
      } else {
        state.pushCovered = false;
      }
      return;
    }

    state.pushCovered = !result.hasMore;
    if (result.hasMore) {
      this.enqueue(state, 'pushPage');
    }
    if (result.blocked?.blockScope === 'endpoint') {
      this.coolEndpoint(normalizeDwnEndpoint(state.target.dwnUrl));
    }
    const link = await this._ledger.getLink(syncNextLinkIdentity(state.target));
    if (link !== undefined && (await this._ledger.getDeliveryForLink(link)).length > 0) {
      this.enqueue(state, 'delivery');
    }
  }

  private async runDelivery(
    state: TargetState,
    shouldContinue: () => boolean,
    runRemoteRequest: SyncRemoteRequestRunner,
  ): Promise<void> {
    const result = await this._operations.deliveryRetry(state.target, shouldContinue, runRemoteRequest);
    const link = await this._ledger.getLink(syncNextLinkIdentity(state.target));
    const remaining = link === undefined ? 0 : (await this._ledger.getDeliveryForLink(link)).length;
    if (result.kind === 'aborted') {
      this.enqueue(state, 'delivery');
    } else if (result.kind === 'settled' && remaining > 0) {
      this.enqueue(state, 'delivery');
    } else if (result.kind === 'pending' && remaining > 0) {
      if (result.outcome.blockScope === 'endpoint') {
        this.coolEndpoint(normalizeDwnEndpoint(state.target.dwnUrl));
      }
      this.defer(state, 'delivery');
    }
  }

  private requestRunner(endpoint: string, budget: WorkBudget): SyncRemoteRequestRunner {
    return <T>(request: (signal?: AbortSignal) => Promise<T>): Promise<T> =>
      runWithCrossContextLock(`enbox:sync-next-endpoint:${endpoint}`, async (): Promise<T> => {
        if (!this.endpointIsEligible(endpoint) || !budget.startRequest()) {
          throw new SyncPullAbortedError();
        }
        const signal = budget.requestSignal();
        try {
          return await request(signal);
        } catch (error: unknown) {
          budget.observeRequestError(signal);
          if (this.isEndpointFailure(error)) {
            this.coolEndpoint(endpoint);
          }
          throw error;
        }
      });
  }

  private async ensureLink(target: SyncTarget): Promise<void> {
    await this._ledger.getOrCreateLink({
      ...syncNextLinkIdentity(target),
      authorization : target.authorization,
      scope         : target.scope,
    });
  }

  private getOrCreateState(target: SyncTarget): TargetState {
    const key = syncNextLinkKey(syncNextLinkIdentity(target));
    const existing = this._states.get(key);
    if (existing !== undefined) {
      existing.target = target;
      return existing;
    }
    const state: TargetState = {
      errors      : {},
      notBefore   : {},
      pullCovered : false,
      pushCovered : false,
      queue       : [],
      target,
    };
    this._states.set(key, state);
    return state;
  }

  private enqueue(state: TargetState, kind: SyncNextWorkKind, first = false): void {
    if (!state.queue.includes(kind)) {
      if (first) {
        state.queue.unshift(kind);
      } else {
        state.queue.push(kind);
      }
    }
  }

  private defer(state: TargetState, kind: SyncNextWorkKind): void {
    state.notBefore[kind] = this.now() + (this._options.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    this.enqueue(state, kind);
  }

  private takeEligible(
    state: TargetState,
    quarantineTargets: Set<string>,
    endpointReady: boolean,
  ): SyncNextWorkKind | undefined {
    for (let index = 0; index < state.queue.length; index++) {
      const kind = state.queue[index];
      if ((state.notBefore[kind] ?? 0) > this.now()) {
        continue;
      }
      if (kind !== 'quarantine' && !endpointReady) {
        continue;
      }
      if (kind === 'quarantine') {
        const logicalKey = this.logicalTargetKey(state.target);
        if (quarantineTargets.has(logicalKey)) {
          continue;
        }
        quarantineTargets.add(logicalKey);
      }
      state.queue.splice(index, 1);
      delete state.notBefore[kind];
      return kind;
    }
  }

  private async seedSparseWork(): Promise<void> {
    for (const state of this._states.values()) {
      if (state.queue.includes('pullPage') && (await this._ledger.getQuarantineForLogicalTarget(
        state.target.did, state.target.projectionId,
      )).length > 0) {
        this.enqueue(state, 'quarantine', true);
      }
      if (state.queue.includes('pushPage')) {
        const link = await this._ledger.getLink(syncNextLinkIdentity(state.target));
        if (link !== undefined && (await this._ledger.getDeliveryForLink(link)).length > 0) {
          this.enqueue(state, 'delivery');
        }
      }
    }
  }

  private deferLogicalQuarantine(target: SyncTarget): void {
    const logicalKey = this.logicalTargetKey(target);
    for (const state of this._states.values()) {
      if (this.logicalTargetKey(state.target) === logicalKey) {
        this.defer(state, 'quarantine');
      }
    }
  }

  private endpointIsEligible(endpoint: string): boolean {
    return (this._endpointCooldowns.get(endpoint) ?? 0) <= this.now();
  }

  private coolEndpoint(endpoint: string): void {
    const until = this.now() + (this._options.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    this._endpointCooldowns.set(endpoint, Math.max(until, this._endpointCooldowns.get(endpoint) ?? 0));
  }

  private isEndpointFailure(error: unknown): boolean {
    if (error instanceof SyncPullAbortedError || isAbortError(error)) {
      return false;
    }
    if (error instanceof DwnRpcError) {
      return !error.terminal && !isQuotaExceededError(error.message, error.data);
    }
    return error instanceof Error;
  }

  private async buildResult(budget: WorkBudget): Promise<SyncNextWorkPumpResult> {
    const targets: SyncNextWorkTargetStatus[] = [];
    for (const state of this._states.values()) {
      const link = await this._ledger.getLink(syncNextLinkIdentity(state.target));
      const pendingDelivery = link === undefined ? 0 : (await this._ledger.getDeliveryForLink(link)).length;
      const pendingQuarantine = (await this._ledger.getQuarantineForLogicalTarget(
        state.target.did, state.target.projectionId,
      )).length;
      targets.push({
        authorizationEpoch : state.target.authorizationEpoch,
        projectionId       : state.target.projectionId,
        pull               : {
          ...errorProperty(state.errors.pullPage ?? state.errors.quarantine),
          feedCovered: state.pullCovered && !state.queue.includes('pullPage'),
          pendingQuarantine,
        },
        push: {
          enabled     : state.target.authorization.kind !== 'role',
          ...errorProperty(state.errors.pushPage ?? state.errors.delivery),
          feedCovered : state.pushCovered && !state.queue.includes('pushPage'),
          pendingDelivery,
        },
        remoteEndpoint : normalizeDwnEndpoint(state.target.dwnUrl),
        tenantDid      : state.target.did,
      });
    }

    const nextRun = this.nextRunAt();
    const sparseWork = targets.some(status =>
      status.pull.pendingQuarantine > 0 || status.push.pendingDelivery > 0
    );
    return {
      budgetExhausted : budget.exhausted,
      cancelled       : budget.cancelled,
      ...(nextRun === undefined ? {} : { nextRunAt: new Date(nextRun).toISOString() }),
      remoteRequests  : budget.requests,
      targets,
      workRemaining   : sparseWork || [...this._states.values()].some(state => state.queue.length > 0),
    };
  }

  private nextRunAt(): number | undefined {
    const times = [...this._endpointCooldowns.values()];
    for (const state of this._states.values()) {
      times.push(...Object.values(state.notBefore));
    }
    return times.filter(time => time > this.now()).sort((left, right) => left - right)[0];
  }

  private get now(): () => number {
    return this._options.now ?? Date.now;
  }

  private logicalTargetKey(target: SyncTarget): string {
    return `${target.did}\n${target.projectionId}`;
  }
}

class WorkBudget {
  private readonly deadline: number;
  private _exhausted = false;
  private _requests = 0;

  public constructor(
    private readonly maxRequests: number,
    maxDurationMs: number,
    private readonly signal: AbortSignal | undefined,
    private readonly now: () => number,
  ) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0 ||
        !Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
      throw new RangeError('SyncNextWorkPump: request and duration budgets must be positive.');
    }
    this.deadline = now() + maxDurationMs;
  }

  public get cancelled(): boolean {
    return this.signal?.aborted === true;
  }

  public get exhausted(): boolean {
    return this._exhausted;
  }

  public get requests(): number {
    return this._requests;
  }

  public canStartWork(): boolean {
    if (this.cancelled) {
      return false;
    }
    if (this._requests >= this.maxRequests || this.now() >= this.deadline) {
      this._exhausted = true;
      return false;
    }
    return true;
  }

  public startRequest(): boolean {
    if (!this.canStartWork()) {
      return false;
    }
    this._requests++;
    return true;
  }

  public requestSignal(): AbortSignal {
    const timeout = AbortSignal.timeout(Math.max(1, this.deadline - this.now()));
    return this.signal === undefined ? timeout : AbortSignal.any([this.signal, timeout]);
  }

  public observeRequestError(requestSignal: AbortSignal): void {
    if (requestSignal.aborted && !this.cancelled) {
      this._exhausted = true;
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorProperty(error: string | undefined): { error?: string } {
  return error === undefined ? {} : { error };
}
