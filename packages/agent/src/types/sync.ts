import type { EnboxPlatformAgent } from './agent.js';

/**
 * The SyncEngine is responsible for syncing messages between the agent and the platform.
 */
export type SyncIdentityOptions = {
  /**
   * The delegate DID that should be used to sign the sync messages.
   */
  delegateDid?: string;
  /**
   * The protocols that should be synced for this identity, if an empty array is provided, all messages for all protocols will be synced.
   */
  protocols: string[];
};

/**
 * Connectivity state of the sync engine.
 */
export type SyncConnectivityState = 'online' | 'offline' | 'unknown';

/**
 * Describes the sync mode: `'poll'` for periodic SMT reconciliation,
 * `'live'` for `MessagesSubscribe`-based real-time sync with SMT fallback.
 */
export type SyncMode = 'poll' | 'live';

/**
 * Parameters for {@link SyncEngine.startSync}.
 */
export type StartSyncParams = {
  /**
   * The sync mode to use. Default: `'poll'`.
   *
   * - `'live'`: Opens `MessagesSubscribe` WebSocket subscriptions to remote
   *   DWNs for real-time pull, and listens to the local EventLog for immediate
   *   push. Falls back to SMT reconciliation on cold start or long disconnect.
   *   An infrequent SMT integrity check still runs at `interval`.
   *
   * - `'poll'`: Legacy mode. Performs a full SMT set-reconciliation sync on a
   *   fixed interval. No WebSocket subscriptions are used.
   */
  mode?: SyncMode;

  /**
   * The interval at which the sync operation should be performed.
   * Accepts any value recognised by `ms()`, e.g. `'30s'`, `'2m'`, `'10m'`.
   *
   * In `'live'` mode this controls the frequency of the SMT integrity check.
   * In `'poll'` mode this controls the polling frequency.
   *
   * Default: `'2m'` (in poll mode), `'5m'` (in live mode).
   */
  interval?: string;
};

export interface SyncEngine {
  /**
   * The agent that the SyncEngine is attached to.
   */
  agent: EnboxPlatformAgent;

  /**
   * Current connectivity state as observed by the sync engine.
   * Updated when WebSocket subscriptions connect/disconnect or when the
   * browser `online`/`offline` events fire.
   */
  readonly connectivityState: SyncConnectivityState;

  /**
   * Register an identity to be managed by the SyncEngine for syncing.
   * The options can define specific protocols that should only be synced, or a delegate DID that should be used to sign the sync messages.
   */
  registerIdentity(params: { did: string, options?: SyncIdentityOptions }): Promise<void>;
  /**
   * Unregister an identity from the SyncEngine, this will stop syncing messages for this identity.
   */
  unregisterIdentity(did: string): Promise<void>;
  /**
   * Get the Sync Options for a specific identity.
   */
  getIdentityOptions(did: string): Promise<SyncIdentityOptions | undefined>;
  /**
   * Update the Sync Options for a specific identity, replaces the existing options.
   */
  updateIdentityOptions(params: { did: string, options: SyncIdentityOptions }): Promise<void>;
  /**
   * Preforms a one-shot sync operation. If no direction is provided, it will perform both push and pull.
   * @param direction which direction you'd like to perform the sync operation.
   *
   * @throws {Error} if a sync is already in progress or the sync operation fails.
   */
  sync(direction?: 'push' | 'pull'): Promise<void>;
  /**
   * Starts sync. In `'live'` mode opens real-time subscriptions with SMT
   * fallback; in `'poll'` mode uses periodic SMT reconciliation.
   *
   * Subsequent calls update the mode/interval. Calling with a different mode
   * tears down the previous mode's resources before starting the new one.
   */
  startSync(params: StartSyncParams): Promise<void>;
  /**
   * Stops the periodic sync operation, will complete the current sync operation if one is already in progress.
   *
   * @param timeout the maximum amount of time, in milliseconds, to wait for the current sync operation to complete. Default is 2000 (2 seconds).
   * @throws {Error} if the sync operation fails to stop before the timeout.
   */
  stopSync(timeout?: number): Promise<void>;

  /**
   * Release all resources held by the sync engine (LevelDB handles, timers,
   * WebSocket subscriptions). After calling `close()`, the engine should not
   * be reused.
   */
  close(): Promise<void>;
}
