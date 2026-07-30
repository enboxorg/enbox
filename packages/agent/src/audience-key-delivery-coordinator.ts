import type { SyncEngine, SyncEvent } from './types/sync.js';

import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

import { syncEventCoversProtocol } from './types/sync.js';
import { SyncRuntime } from './sync-runtime.js';
import { SyncTaskGroup } from './sync-task-group.js';

const DEFAULT_RETRY_DELAYS = [1_000, 5_000, 30_000] as const;
const RETRY_TIMER = 'audience-key-delivery-retry';

/** Internal signal that reconciliation must wait for an authoritative local replica. */
export class AudienceKeyDeliveryReplicaNotCurrentError extends Error {
  public constructor() {
    super('Audience-key delivery reconciliation is waiting for the local replica to become current.');
    this.name = 'AudienceKeyDeliveryReplicaNotCurrentError';
  }
}

/** Session-scoped scheduler for one protocol's role-delivery repair. */
export class AudienceKeyDeliveryCoordinator {
  private readonly _abortListener = (): void => { this.close(); };
  private readonly _onClosed: () => void;
  private readonly _retryDelays: readonly number[];
  private readonly _retryRuntime = new SyncRuntime();
  private readonly _rolePaths: ReadonlySet<string>;
  private readonly _run: (includeDormant: boolean) => Promise<boolean>;
  private readonly _tasks = new SyncTaskGroup();
  private readonly _unsubscribe: () => void;
  private _closed = false;
  private _pending?: boolean;
  private _retryAttempt = 0;
  private _running = false;
  private _waitingForCurrent = false;

  public readonly protocol: string;
  public readonly sessionSignal: AbortSignal;
  public readonly targetDid: string;

  public constructor(params: {
    onClosed?: () => void;
    protocol: string;
    retryDelays?: readonly number[];
    rolePaths: ReadonlySet<string>;
    run: (includeDormant: boolean) => Promise<boolean>;
    signal: AbortSignal;
    sync: SyncEngine;
    targetDid: string;
  }) {
    this._onClosed = params.onClosed ?? ((): void => {});
    this._retryDelays = params.retryDelays ?? DEFAULT_RETRY_DELAYS;
    this._rolePaths = params.rolePaths;
    this._run = params.run;
    this.protocol = params.protocol;
    this.sessionSignal = params.signal;
    this.targetDid = params.targetDid;
    this._unsubscribe = params.sync.on(this.handleSyncEvent.bind(this));
    this.sessionSignal.addEventListener('abort', this._abortListener, { once: true });
    if (this.sessionSignal.aborted) {
      this.close();
    } else {
      this.wake();
    }
  }

  public close(): void {
    if (this._closed) {
      return;
    }

    this._closed = true;
    this._tasks.pause();
    this._retryRuntime.dispose();
    this.sessionSignal.removeEventListener('abort', this._abortListener);
    this._unsubscribe();
    void this.whenIdle().then(this._onClosed);
  }

  public async whenIdle(): Promise<void> {
    await this._tasks.settle();
  }

  /** Starts a fresh bounded retry sequence after a newly observed transient failure. */
  public retry(): void {
    if (this._closed) {
      return;
    }
    this._retryRuntime.cancelTimer(RETRY_TIMER);
    this._retryAttempt = 0;
    this.scheduleRetry();
  }

  /** Reconciles active roles without retrying dormant recipient-install failures. */
  public reconcile(): void {
    this.request(false);
  }

  /** Wakes active and recipient-install-blocked delivery work. */
  public wake(): void {
    this.request(true);
  }

  private async drain(): Promise<void> {
    try {
      while (!this._closed && this._pending !== undefined) {
        const includeDormant = this._pending;
        this._pending = undefined;

        let retry: boolean;
        try {
          retry = await this._run(includeDormant);
          this._waitingForCurrent = false;
        } catch (error) {
          retry = true;
          this._waitingForCurrent = error instanceof AudienceKeyDeliveryReplicaNotCurrentError;
        }

        if (retry && this._pending === undefined) {
          this.scheduleRetry();
        } else if (!retry && !this._retryRuntime.hasTimer(RETRY_TIMER)) {
          this._retryAttempt = 0;
        }
      }
    } finally {
      this._running = false;
    }
  }

  private handleSyncEvent(event: SyncEvent): void {
    if (this._closed) {
      return;
    }
    if (event.type === 'delivery:applied') {
      this.handleDeliveryEvent(event);
      return;
    }
    if (event.tenantDid !== this.targetDid) {
      return;
    }
    if (event.type === 'identity:registration-change') {
      this.wake();
      return;
    }
    if (!syncEventCoversProtocol(event, this.protocol)) {
      return;
    }
    if (event.type === 'link:connectivity-change' && event.to === 'online') {
      this.wake();
      return;
    }
    if (this._waitingForCurrent && (
      (event.type === 'pull:currentness-change' && event.to) ||
      (event.type === 'link:status-change' && event.to === 'live')
    )) {
      this.wake();
    }
  }

  private handleDeliveryEvent(event: Extract<SyncEvent, { type: 'delivery:applied' }>): void {
    const { descriptor } = event;
    if (descriptor.interface === DwnInterfaceName.Protocols &&
        descriptor.method === DwnMethodName.Configure &&
        descriptor.protocol === this.protocol) {
      this.wake();
      return;
    }
    if (event.tenantDid !== this.targetDid) {
      return;
    }
    if (descriptor.interface === DwnInterfaceName.Records && descriptor.method === DwnMethodName.Write) {
      if (descriptor.protocol === this.protocol && descriptor.protocolPath !== undefined &&
          this._rolePaths.has(descriptor.protocolPath)) {
        this.reconcile();
      }
    } else if (descriptor.interface === DwnInterfaceName.Records && descriptor.method === DwnMethodName.Delete) {
      if (descriptor.protocol === undefined
        ? syncEventCoversProtocol(event, this.protocol)
        : descriptor.protocol === this.protocol) {
        this.reconcile();
      }
    }
  }

  private request(includeDormant: boolean): void {
    if (this._closed) {
      return;
    }

    this._retryAttempt = 0;
    this._retryRuntime.cancelTimer(RETRY_TIMER);
    this._pending = includeDormant || this._pending === true;
    if (!this._running) {
      this.startDrain();
    }
  }

  private scheduleRetry(): void {
    if (this._closed || this._retryRuntime.hasTimer(RETRY_TIMER)) {
      return;
    }

    const delay = this._retryDelays[this._retryAttempt];
    if (delay === undefined) {
      return;
    }
    this._retryAttempt += 1;
    this._retryRuntime.armTimeout(RETRY_TIMER, (): void => {
      this._pending ??= false;
      if (!this._running) {
        this.startDrain();
      }
    }, delay);
  }

  private startDrain(): void {
    this._running = true;
    void this._tasks.run(() => this.drain());
  }
}
