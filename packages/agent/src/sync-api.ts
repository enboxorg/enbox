import type { EnboxPlatformAgent } from './types/agent.js';
import type { StartSyncParams, SyncConnectivityState, SyncEngine, SyncIdentityOptions } from './types/sync.js';

export type SyncApiParams = {
  agent?: EnboxPlatformAgent;
  syncEngine: SyncEngine;
};

export class AgentSyncApi implements SyncEngine {
  /**
   * Holds the instance of a `EnboxPlatformAgent` that represents the current execution context for
   * the `AgentSyncApi`. This agent is used to interact with other Enbox agent components. It's vital
   * to ensure this instance is set to correctly contextualize operations within the broader Enbox
   * Agent framework.
   */
  private _agent?: EnboxPlatformAgent;

  private _syncEngine: SyncEngine;

  constructor({ agent, syncEngine }: SyncApiParams) {
    this._syncEngine = syncEngine;
    this._agent = agent;
  }

  /**
   * Retrieves the `EnboxPlatformAgent` execution context.
   *
   * @returns The `EnboxPlatformAgent` instance that represents the current execution context.
   * @throws Will throw an error if the `agent` instance property is undefined.
   */
  get agent(): EnboxPlatformAgent {
    if (this._agent === undefined) {
      throw new Error('AgentSyncApi: Unable to determine agent execution context.');
    }

    return this._agent;
  }

  set agent(agent: EnboxPlatformAgent) {
    this._agent = agent;
    this._syncEngine.agent = agent;
  }

  get connectivityState(): SyncConnectivityState {
    return this._syncEngine.connectivityState;
  }

  public async registerIdentity(params: { did: string; options?: SyncIdentityOptions }): Promise<void> {
    await this._syncEngine.registerIdentity(params);
  }

  public async unregisterIdentity(did: string): Promise<void> {
    await this._syncEngine.unregisterIdentity(did);
  }

  public async getIdentityOptions(did: string): Promise<SyncIdentityOptions | undefined> {
    return await this._syncEngine.getIdentityOptions(did);
  }

  public async updateIdentityOptions(params: { did: string, options: SyncIdentityOptions }): Promise<void> {
    await this._syncEngine.updateIdentityOptions(params);
  }

  public sync(direction?: 'push' | 'pull'): Promise<void> {
    return this._syncEngine.sync(direction);
  }

  public startSync(params: StartSyncParams): Promise<void> {
    return this._syncEngine.startSync(params);
  }

  public stopSync(timeout?: number): Promise<void> {
    return this._syncEngine.stopSync(timeout);
  }
}
