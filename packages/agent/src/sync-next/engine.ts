import type { SyncDirection } from '../types/sync.js';
import type { SyncNextLinkIdentity } from './types.js';
import type { SyncNextProgressStore } from './progress-store.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type { SyncNextRunner, SyncNextTargetRunResult, SyncNextWorkFailure } from './runner.js';

import { syncErrorMessage } from '../sync-runtime-errors.js';
import { SyncWorkInterruptedError } from '../sync-messages.js';
import { syncNextLinkIdentity, syncNextLinkKey } from './progress-key.js';

export type SyncEngineNextDirection = SyncDirection | 'both';

export type SyncEngineNextDirectionResult = {
  feedCovered: boolean;
  requested: boolean;
  workRemaining: boolean;
};

export type SyncEngineNextRunResult = {
  blockedEndpoints: string[];
  deliveryPending: boolean;
  failures: SyncNextWorkFailure[];
  pull: SyncEngineNextDirectionResult;
  push: SyncEngineNextDirectionResult;
  quarantinePending: boolean;
  remoteRequests: number;
  /** Whether unfinished work could not continue within the remote-request budget. */
  requestBudgetExhausted: boolean;
  /** Number of unique exact links in the planned target snapshot. */
  targetCount: number;
  /** Whether the complete target snapshot remained authoritative through final status collection. */
  targetsCurrent: boolean;
  /** Whether unfinished work consumed the complete runner-turn limit. */
  turnLimitReached: boolean;
  turns: number;
  /** Whether any requested direction or its durable pending queue remains incomplete. */
  workRemaining: boolean;
};

/** Complete target-plan surface required by the next engine. */
export interface SyncEngineNextTargetPlanner {
  readonly lastResolutionComplete: boolean;
  readonly topologyGeneration: number;
  getTargets(): Promise<SyncTarget[]>;
  withCurrentRoleGrant(target: SyncTarget): Promise<SyncTarget>;
}

type DirectionState = SyncEngineNextDirectionResult & {
  completedTargets: Set<string>;
  coveredTargets: Set<string>;
  stalled: boolean;
};

type PreparedTargets = {
  failures: SyncNextWorkFailure[];
  targets: SyncTarget[];
};

type RunTargets = {
  planned: SyncTarget[];
  prepared: PreparedTargets;
  targetsCurrent: boolean;
  topologyGeneration: number;
};

type RunState = {
  blockedEndpoints: Set<string>;
  failedTargetDirections: Set<string>;
  failures: SyncNextWorkFailure[];
  maxRemoteRequests: number;
  maxTurns: number;
  pull: DirectionState;
  push: DirectionState;
  remoteRequests: number;
  requestBudgetExhausted: boolean;
  roundProgress: boolean;
  signal?: AbortSignal;
  targets: SyncTarget[];
  topologyGeneration: number;
  turnLimitReached: boolean;
  turns: number;
};

const DEFAULT_MAX_REMOTE_REQUESTS = 64;
const DEFAULT_MAX_TURNS = 64;
const MAX_RUNNER_REQUESTS = 32;
const MIN_RUNNER_REQUESTS = 3;

/**
 * Resolves one authoritative target snapshot and drives bounded pull and push
 * work without owning subscriptions, timers, or public engine selection.
 */
export class SyncEngineNext {
  private readonly _nextTargetKeys = new Map<SyncDirection, string>();
  private _runTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly _targetPlanner: SyncEngineNextTargetPlanner,
    private readonly _progressStore: SyncNextProgressStore,
    private readonly _runner: Pick<SyncNextRunner, 'run'>,
  ) {}

  /**
   * Run requested directions until covered, blocked, or out of budget.
   * Caller cancellation rejects with `SyncWorkInterruptedError`; committed
   * checkpoints and pending rows remain available to the next call.
   */
  public run(
    direction: SyncEngineNextDirection = 'both',
    options: { maxRemoteRequests?: number; maxTurns?: number; signal?: AbortSignal } = {},
  ): Promise<SyncEngineNextRunResult> {
    const maxRemoteRequests = options.maxRemoteRequests ?? DEFAULT_MAX_REMOTE_REQUESTS;
    const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    const minimumRemoteRequests = direction === 'both' ? MIN_RUNNER_REQUESTS * 2 : MIN_RUNNER_REQUESTS;
    if (!Number.isSafeInteger(maxRemoteRequests) || maxRemoteRequests < minimumRemoteRequests) {
      throw new RangeError(`SyncEngineNext: request budget must be an integer of at least ${minimumRemoteRequests}.`);
    }
    const minimumTurns = direction === 'both' ? 2 : 1;
    if (!Number.isSafeInteger(maxTurns) || maxTurns < minimumTurns) {
      throw new RangeError(`SyncEngineNext: turn limit must be an integer of at least ${minimumTurns}.`);
    }

    const run = this._runTail.then(() => this.runInternal(direction, maxRemoteRequests, maxTurns, options.signal));
    this._runTail = run.then((): void => {}, (): void => {});
    return options.signal === undefined ? run : SyncEngineNext.rejectWhenAborted(run, options.signal);
  }

  private async runInternal(
    direction: SyncEngineNextDirection,
    maxRemoteRequests: number,
    maxTurns: number,
    signal?: AbortSignal,
  ): Promise<SyncEngineNextRunResult> {
    SyncEngineNext.throwIfAborted(signal);
    const runTargets = await this.resolveRunTargets(direction, signal);

    const state = this.createRunState(
      runTargets.prepared,
      runTargets.planned,
      direction,
      maxRemoteRequests,
      maxTurns,
      runTargets.topologyGeneration,
      signal,
    );
    await this.runRounds(state);
    SyncEngineNext.throwIfAborted(signal);
    let targetsCurrent = runTargets.targetsCurrent;
    const { topologyGeneration } = runTargets;
    targetsCurrent &&= this.isTargetPlanCurrent(topologyGeneration);

    const pending = await this._progressStore.hasPendingWork();
    targetsCurrent &&= this.isTargetPlanCurrent(topologyGeneration);
    const pull = this.directionResult(state.pull, targetsCurrent);
    const push = this.directionResult(state.push, targetsCurrent);
    const workRemaining = !targetsCurrent || pull.workRemaining || push.workRemaining ||
      (pull.requested && pending.quarantine) || (push.requested && pending.delivery);

    return {
      blockedEndpoints       : [...state.blockedEndpoints].sort((left, right) => left.localeCompare(right)),
      deliveryPending        : pending.delivery,
      failures               : state.failures,
      pull,
      push,
      quarantinePending      : pending.quarantine,
      remoteRequests         : state.remoteRequests,
      requestBudgetExhausted : workRemaining &&
        (state.requestBudgetExhausted || state.remoteRequests >= state.maxRemoteRequests),
      targetCount      : runTargets.planned.length,
      targetsCurrent,
      turnLimitReached : state.turnLimitReached && workRemaining,
      turns            : state.turns,
      workRemaining,
    };
  }

  private async resolveRunTargets(
    direction: SyncEngineNextDirection,
    signal?: AbortSignal,
  ): Promise<RunTargets> {
    const topologyGeneration = this._targetPlanner.topologyGeneration;
    const targets = await this._targetPlanner.getTargets();
    SyncEngineNext.throwIfAborted(signal);
    if (!this.isTargetPlanGenerationCurrent(topologyGeneration)) {
      return SyncEngineNext.emptyRunTargets(topologyGeneration);
    }

    const planned = await this.ensureTargets(targets, topologyGeneration, signal);
    if (planned === undefined) {
      return SyncEngineNext.emptyRunTargets(topologyGeneration);
    }
    const prepared = await this.prepareTargetsForRun(planned, direction, signal);
    SyncEngineNext.throwIfAborted(signal);
    if (!this.isTargetPlanGenerationCurrent(topologyGeneration)) {
      return SyncEngineNext.emptyRunTargets(topologyGeneration);
    }

    let targetsCurrent = this.isTargetPlanCurrent(topologyGeneration);
    if (targetsCurrent) {
      targetsCurrent = await this.retireStaleLinks(planned, topologyGeneration, signal);
    }
    return { planned, prepared, targetsCurrent, topologyGeneration };
  }

  private async ensureTargets(
    targets: readonly SyncTarget[],
    topologyGeneration: number,
    signal?: AbortSignal,
  ): Promise<SyncTarget[] | undefined> {
    const unique = new Map<string, SyncTarget>();
    for (const target of targets) {
      const key = syncNextLinkKey(syncNextLinkIdentity(target));
      if (!unique.has(key)) {
        unique.set(key, target);
      }
    }

    for (const target of unique.values()) {
      if (SyncEngineNext.isAborted(signal)) {
        throw new SyncWorkInterruptedError();
      }
      if (!this.isTargetPlanGenerationCurrent(topologyGeneration)) {
        return undefined;
      }
      await this._progressStore.getOrCreateLink({ // NOSONAR: S9382 - check cancellation between link mutations.
        ...syncNextLinkIdentity(target),
        authorization : target.authorization,
        scope         : target.scope,
      });
    }
    return this.isTargetPlanGenerationCurrent(topologyGeneration) ? [...unique.values()] : undefined;
  }

  /** Resolve transient role grants without letting one unavailable target block its peers. */
  private async prepareTargetsForRun(
    targets: readonly SyncTarget[],
    direction: SyncEngineNextDirection,
    signal?: AbortSignal,
  ): Promise<PreparedTargets> {
    const failures: SyncNextWorkFailure[] = [];
    const prepared: SyncTarget[] = [];
    const roleGrants = new Map<string, Promise<SyncTarget>>();
    for (const target of targets) {
      if (direction === 'push' || target.authorization.kind !== 'role' || target.delegateDid === undefined) {
        prepared.push(target);
        continue;
      }
      if (SyncEngineNext.isAborted(signal)) {
        throw new SyncWorkInterruptedError();
      }

      const key = JSON.stringify([
        target.authorization.actorDid,
        target.delegateDid,
        target.scope.kind === 'context' ? target.scope.protocol : undefined,
      ]);
      let roleGrant = roleGrants.get(key);
      let grantTarget: SyncTarget;
      try {
        if (roleGrant === undefined) {
          roleGrant = this._targetPlanner.withCurrentRoleGrant(target);
          roleGrants.set(key, roleGrant);
        }
        grantTarget = await roleGrant; // NOSONAR: S9382 - serialize unique forced grant refreshes to avoid a request wave.
      } catch (error: unknown) {
        failures.push({
          message : syncErrorMessage(error),
          target  : syncNextLinkIdentity(target),
          work    : 'authorityRefresh',
        });
        prepared.push(target);
        continue;
      }
      if (SyncEngineNext.isAborted(signal)) {
        throw new SyncWorkInterruptedError();
      }
      // Only the transient grant crosses this boundary; durable link identity stays planned.
      prepared.push({ ...target, authorDelegatedGrant: grantTarget.authorDelegatedGrant });
    }
    return { failures, targets: prepared };
  }

  private async retireStaleLinks(
    targets: readonly SyncTarget[],
    topologyGeneration: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const currentKeys = new Set(targets.map(target => syncNextLinkKey(syncNextLinkIdentity(target))));
    const staleLinks = (await this._progressStore.getAllLinks())
      .filter(link => !currentKeys.has(syncNextLinkKey(link)));
    for (const link of staleLinks) {
      if (SyncEngineNext.isAborted(signal) || !this.isTargetPlanCurrent(topologyGeneration)) {
        return false;
      }
      await this._progressStore.retireLink(link); // NOSONAR: S9382 - recheck the target generation before each retirement.
    }
    return this.isTargetPlanCurrent(topologyGeneration);
  }

  private createRunState(
    prepared: PreparedTargets,
    planned: SyncTarget[],
    direction: SyncEngineNextDirection,
    maxRemoteRequests: number,
    maxTurns: number,
    topologyGeneration: number,
    signal?: AbortSignal,
  ): RunState {
    return {
      blockedEndpoints       : new Set(),
      failedTargetDirections : new Set(prepared.failures.map(failure =>
        SyncEngineNext.targetWorkKey('pull', failure.target)
      )),
      failures : [...prepared.failures],
      maxRemoteRequests,
      maxTurns,
      pull     : this.createDirectionState(direction !== 'push', planned.length),
      push     : this.createDirectionState(
        direction !== 'pull', this.targetsForDirection(planned, 'push').length,
      ),
      remoteRequests         : 0,
      requestBudgetExhausted : false,
      roundProgress          : false,
      signal,
      targets                : prepared.targets,
      topologyGeneration,
      turnLimitReached       : false,
      turns                  : 0,
    };
  }

  private createDirectionState(requested: boolean, targetCount: number): DirectionState {
    return {
      completedTargets : new Set(),
      coveredTargets   : new Set(),
      feedCovered      : requested && targetCount === 0,
      requested,
      stalled          : false,
      workRemaining    : requested && targetCount > 0,
    };
  }

  private async runRounds(state: RunState): Promise<void> {
    while (this.canContinue(state)) {
      state.roundProgress = false;
      await this.runDirection(state, 'pull', this.shouldReserveFor(state, 'push'));
      if (!this.canContinue(state)) {
        return;
      }
      await this.runDirection(state, 'push', false);
      if (!state.roundProgress) {
        return;
      }
    }
  }

  private async runDirection(state: RunState, direction: SyncDirection, reserveForLater: boolean): Promise<void> {
    const directionState = state[direction];
    if (!directionState.requested || !directionState.workRemaining || directionState.stalled) {
      return;
    }

    const directionTargets = this.targetsForDirection(state.targets, direction);
    const eligibleTargets = this.orderTargets(direction, directionTargets.filter(target =>
      this.isTargetAvailable(state, direction, target) &&
      !directionState.completedTargets.has(syncNextLinkKey(syncNextLinkIdentity(target)))
    ));
    if (eligibleTargets.length === 0) {
      this.updateDirectionStatus(state, direction, directionTargets);
      directionState.stalled = directionState.workRemaining;
      return;
    }

    const allowance = this.requestAllowance(state, reserveForLater);
    if (allowance < MIN_RUNNER_REQUESTS) {
      state.requestBudgetExhausted = true;
      return;
    }

    const result = await this._runner.run(eligibleTargets, direction, {
      maxRemoteRequests : allowance,
      signal            : state.signal,
    });
    state.turns++;
    state.remoteRequests += result.remoteRequests;
    state.failures.push(...result.failures);
    for (const failure of result.failures) {
      state.failedTargetDirections.add(SyncEngineNext.targetWorkKey(direction, failure.target));
    }
    for (const endpoint of result.blockedEndpoints) {
      state.blockedEndpoints.add(endpoint);
    }

    const schedulingProgress = this.recordTargetResults(direction, directionState, result.targetResults);
    this.updateDirectionStatus(state, direction, directionTargets);
    directionState.stalled = directionState.workRemaining && !result.madeProgress && !schedulingProgress;
    if (schedulingProgress) {
      state.roundProgress = true;
    }
    if (result.madeProgress) {
      state.roundProgress = true;
      this.invalidateOppositeDirection(state, direction);
    }
  }

  private invalidateOppositeDirection(state: RunState, direction: SyncDirection): void {
    const opposite = direction === 'pull' ? state.push : state.pull;
    const oppositeDirection = direction === 'pull' ? 'push' : 'pull';
    if (!opposite.requested || this.targetsForDirection(state.targets, oppositeDirection).length === 0) {
      return;
    }
    opposite.feedCovered = false;
    opposite.stalled = false;
    opposite.workRemaining = true;
    opposite.completedTargets.clear();
    opposite.coveredTargets.clear();
  }

  private requestAllowance(state: RunState, reserveForLater: boolean): number {
    const remaining = state.maxRemoteRequests - state.remoteRequests;
    const reserve = reserveForLater && remaining >= MIN_RUNNER_REQUESTS * 2
      ? MIN_RUNNER_REQUESTS
      : 0;
    return Math.min(MAX_RUNNER_REQUESTS, remaining - reserve);
  }

  private shouldReserveFor(state: RunState, direction: SyncDirection): boolean {
    const directionState = state[direction];
    return directionState.requested && directionState.workRemaining && !directionState.stalled &&
      this.targetsForDirection(state.targets, direction)
        .some(target => this.isTargetAvailable(state, direction, target) &&
          !directionState.completedTargets.has(syncNextLinkKey(syncNextLinkIdentity(target))));
  }

  private updateDirectionStatus(state: RunState, direction: SyncDirection, targets: readonly SyncTarget[]): void {
    const directionState = state[direction];
    const hasUnavailableTarget = targets.some(target => !this.isTargetAvailable(state, direction, target));
    directionState.feedCovered = !hasUnavailableTarget && targets.every(target =>
      directionState.coveredTargets.has(syncNextLinkKey(syncNextLinkIdentity(target)))
    );
    directionState.workRemaining = hasUnavailableTarget || targets.some(target =>
      !directionState.completedTargets.has(syncNextLinkKey(syncNextLinkIdentity(target)))
    );
  }

  private recordTargetResults(
    direction: SyncDirection,
    state: DirectionState,
    results: readonly SyncNextTargetRunResult[],
  ): boolean {
    const completedBefore = state.completedTargets.size;
    for (const result of results) {
      const key = syncNextLinkKey(result.identity);
      if (result.feedAttempted) {
        if (result.feedCovered) {
          state.coveredTargets.add(key);
        } else {
          state.coveredTargets.delete(key);
        }
      }
      if (result.workRemaining) {
        state.completedTargets.delete(key);
      } else {
        state.completedTargets.add(key);
      }
    }
    this.rememberNextTarget(direction, results);
    return state.completedTargets.size > completedBefore ||
      (results.some(result => result.feedAttempted) &&
       results.some(result => !result.feedAttempted && result.workRemaining));
  }

  private orderTargets(direction: SyncDirection, targets: SyncTarget[]): SyncTarget[] {
    const nextKey = this._nextTargetKeys.get(direction);
    const nextIndex = nextKey === undefined
      ? -1
      : targets.findIndex(target => syncNextLinkKey(syncNextLinkIdentity(target)) === nextKey);
    return nextIndex > 0 ? [...targets.slice(nextIndex), ...targets.slice(0, nextIndex)] : targets;
  }

  private rememberNextTarget(direction: SyncDirection, results: readonly SyncNextTargetRunResult[]): void {
    const next = results.find(result => !result.feedAttempted && result.workRemaining) ??
      results.find(result => result.workRemaining);
    if (next === undefined) {
      this._nextTargetKeys.delete(direction);
    } else {
      this._nextTargetKeys.set(direction, syncNextLinkKey(next.identity));
    }
  }

  private isTargetAvailable(state: RunState, direction: SyncDirection, target: SyncTarget): boolean {
    const identity = syncNextLinkIdentity(target);
    return !state.blockedEndpoints.has(identity.remoteEndpoint) &&
      !state.failedTargetDirections.has(SyncEngineNext.targetWorkKey(direction, identity));
  }

  private canContinue(state: RunState): boolean {
    if (state.signal?.aborted === true || !this.isTargetPlanGenerationCurrent(state.topologyGeneration)) {
      return false;
    }
    if (state.turns >= state.maxTurns) {
      state.turnLimitReached = true;
      return false;
    }
    return (state.pull.workRemaining && !state.pull.stalled) ||
      (state.push.workRemaining && !state.push.stalled);
  }

  private targetsForDirection(targets: readonly SyncTarget[], direction: SyncDirection): SyncTarget[] {
    return direction === 'push'
      ? targets.filter(target => target.authorization.kind !== 'role')
      : [...targets];
  }

  private directionResult(state: DirectionState, targetsCurrent: boolean): SyncEngineNextDirectionResult {
    return {
      feedCovered   : state.requested && targetsCurrent && state.feedCovered,
      requested     : state.requested,
      workRemaining : state.requested && (!targetsCurrent || !state.feedCovered || state.workRemaining),
    };
  }

  private isTargetPlanCurrent(topologyGeneration: number): boolean {
    return this._targetPlanner.lastResolutionComplete &&
      this.isTargetPlanGenerationCurrent(topologyGeneration);
  }

  private isTargetPlanGenerationCurrent(topologyGeneration: number): boolean {
    return this._targetPlanner.topologyGeneration === topologyGeneration;
  }

  private static isAborted(signal?: AbortSignal): boolean {
    return signal?.aborted === true;
  }

  private static emptyRunTargets(topologyGeneration: number): RunTargets {
    return {
      planned        : [],
      prepared       : { failures: [], targets: [] },
      targetsCurrent : false,
      topologyGeneration,
    };
  }

  private static throwIfAborted(signal?: AbortSignal): void {
    if (SyncEngineNext.isAborted(signal)) {
      throw new SyncWorkInterruptedError();
    }
  }

  private static rejectWhenAborted<TResult>(operation: Promise<TResult>, signal: AbortSignal): Promise<TResult> {
    if (signal.aborted) {
      return Promise.reject(new SyncWorkInterruptedError());
    }
    return new Promise<TResult>((resolve, reject) => {
      const abort = (): void => { reject(new SyncWorkInterruptedError()); };
      signal.addEventListener('abort', abort, { once: true });
      operation.then(
        (value): void => {
          signal.removeEventListener('abort', abort);
          resolve(value);
        },
        (error: unknown): void => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
    });
  }

  private static targetWorkKey(direction: SyncDirection, target: SyncNextLinkIdentity): string {
    return `${direction}:${syncNextLinkKey(target)}`;
  }
}
