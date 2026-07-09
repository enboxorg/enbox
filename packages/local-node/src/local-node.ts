import type { LocalNodePairingSessionStore } from './pairing-session-store.js';
import type { LocalNodeServerConfigOptions } from './local-node-config.js';
import type { PairingBroker } from './pairing-broker.js';
import type { DwnDiscoveryFile, DwnDiscoveryRecord } from '@enbox/agent';
import type {
  DwnServerConfig,
  LocalNodePairingManager,
  LocalNodePairingRequestView,
  LocalNodePairingSessionRecord,
} from '@enbox/dwn-server';

import {
  DwnDiscoveryFile as DefaultDwnDiscoveryFile,
  localDwnPortCandidates,
  localDwnServerName,
} from '@enbox/agent';
import { LocalNodePairingManager as DefaultLocalNodePairingManager, DwnServer } from '@enbox/dwn-server';

import { createLocalNodeDwnServerConfig } from './local-node-config.js';
import { LocalNodePairingSessionFile } from './pairing-session-store.js';

export type LocalNodeState = 'stopped' | 'running';

export type LocalNodeDwnServer = {
  dwn?: { close(): Promise<void> };
  localNodePairingManager: LocalNodePairingManager;
  revokeLocalNodePairingToken?(token: string): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

export type LocalNodeStartResult = {
  discoveryFilePath : string;
  endpoint : string;
  localNodeToken : string;
  pid : number;
  port : number;
};

export type LocalNodeStatus = {
  discoveryFilePath : string;
  endpoint? : string;
  localNodeToken? : string;
  pendingPairingRequests : LocalNodePairingRequestView[];
  pid : number;
  port? : number;
  state : LocalNodeState;
  webSocketSupport : boolean;
};

export type ExistingLocalNode = {
  endpoint : string;
  pid : number;
};

type LocalNodeInfoResponse = {
  localNode?: boolean;
  server?: string;
};

export type LocalNodeOptions = Omit<LocalNodeServerConfigOptions, 'port'> & {
  createServer? : (config: DwnServerConfig, pairingManager: LocalNodePairingManager) => LocalNodeDwnServer;
  discoveryFile? : DwnDiscoveryFile;
  fetch? : typeof fetch;
  pairingBroker? : PairingBroker;
  pairingPollIntervalMs? : number;
  pairingManager? : LocalNodePairingManager;
  pairingSessionStore? : LocalNodePairingSessionStore;
  pid? : number;
  portCandidates? : readonly number[];
};

export class LocalNodeAlreadyRunningError extends Error {
  public readonly endpoint: string;
  public readonly pid: number;

  public constructor(existingNode: ExistingLocalNode) {
    super(`LocalNode: local node is already running at ${existingNode.endpoint}.`);
    this.name = 'LocalNodeAlreadyRunningError';
    this.endpoint = existingNode.endpoint;
    this.pid = existingNode.pid;
  }
}

export class LocalNode {
  readonly #allowedOrigins: string[];
  readonly #configOptions: Omit<LocalNodeServerConfigOptions, 'allowedOrigins' | 'port'>;
  readonly #createServer: (config: DwnServerConfig, pairingManager: LocalNodePairingManager) => LocalNodeDwnServer;
  readonly #discoveryFile: DwnDiscoveryFile;
  readonly #fetch: typeof fetch;
  readonly #pairingBroker: PairingBroker | undefined;
  readonly #pairingManager: LocalNodePairingManager;
  readonly #pairingPollIntervalMs: number;
  readonly #pairingSessionStore: LocalNodePairingSessionStore;
  readonly #pid: number;
  readonly #portCandidates: readonly number[];

  #endpoint: string | undefined;
  #localNodeToken: string | undefined;
  #pairingBrokerLoopFailure: { error: unknown } | undefined;
  #pairingBrokerProcessing: Promise<void> | undefined;
  #pairingBrokerTimer: ReturnType<typeof setInterval> | undefined;
  #pairingSessionChangeUnsubscribe: (() => void) | undefined;
  #pairingSessionWriteFailure: { error: unknown } | undefined;
  #pairingSessionWriteQueue: Promise<void> = Promise.resolve();
  #port: number | undefined;
  #server: LocalNodeDwnServer | undefined;
  #state: LocalNodeState = 'stopped';

  public constructor(options: LocalNodeOptions = {}) {
    this.#allowedOrigins = options.allowedOrigins ?? [];
    this.#configOptions = {
      baseUrl                : options.baseUrl,
      dataStore              : options.dataStore,
      deliveryEnabled        : options.deliveryEnabled,
      eventBusPluginPath     : options.eventBusPluginPath,
      forwardingEnabled      : options.forwardingEnabled,
      hostname               : options.hostname,
      logLevel               : options.logLevel,
      maxRecordDataSize      : options.maxRecordDataSize,
      messageStore           : options.messageStore,
      packageJsonPath        : options.packageJsonPath,
      registrationStoreUrl   : options.registrationStoreUrl,
      resumableTaskStore     : options.resumableTaskStore,
      serverName             : options.serverName,
      storageUrl             : options.storageUrl,
      termsOfServiceFilePath : options.termsOfServiceFilePath,
      ttlCacheUrl            : options.ttlCacheUrl,
      webSocketSupport       : options.webSocketSupport,
    };
    this.#createServer = options.createServer ?? LocalNode.#createDwnServer;
    this.#discoveryFile = options.discoveryFile ?? new DefaultDwnDiscoveryFile();
    this.#fetch = options.fetch ?? fetch;
    this.#pairingBroker = options.pairingBroker;
    this.#pairingManager = options.pairingManager ?? new DefaultLocalNodePairingManager();
    this.#pairingPollIntervalMs = options.pairingPollIntervalMs ?? 500;
    this.#pairingSessionStore = options.pairingSessionStore ?? new LocalNodePairingSessionFile();
    this.#pid = options.pid ?? process.pid;
    this.#portCandidates = options.portCandidates ?? localDwnPortCandidates;
  }

  public get discoveryFilePath(): string {
    return this.#discoveryFile.path;
  }

  public get endpoint(): string | undefined {
    return this.#endpoint;
  }

  public get pairingManager(): LocalNodePairingManager {
    return this.#pairingManager;
  }

  public get state(): LocalNodeState {
    return this.#state;
  }

  public async start(): Promise<LocalNodeStartResult> {
    if (this.#state === 'running') {
      return this.#getStartResult();
    }

    const existingNode = await this.findExistingNode();
    if (existingNode !== undefined) {
      throw new LocalNodeAlreadyRunningError(existingNode);
    }

    await this.#loadPairingSessions();
    const localNodeToken = this.#pairingManager.createSession(undefined);
    this.#subscribeToPairingSessionChanges();

    try {
      const startResult = await this.#startFirstAvailableServer();
      this.#server = startResult.server;
      this.#port = startResult.port;
      this.#endpoint = startResult.endpoint;
      this.#localNodeToken = localNodeToken;
      this.#state = 'running';

      await this.#writeDiscoveryFile();
      this.#startPairingBrokerLoop();
    } catch (error) {
      await this.#cleanupStartedServer();
      throw error;
    }

    return this.#getStartResult();
  }

  public async stop(): Promise<void> {
    if (this.#state === 'stopped') {
      return;
    }

    this.#stopPairingBrokerLoop();
    let stopFailure: { error: unknown } | undefined;

    try {
      await this.#discoveryFile.remove();
    } catch (error) {
      stopFailure = { error };
    }

    try {
      await this.#server?.stop();
    } catch (error) {
      stopFailure ??= { error };
    }

    this.#unsubscribeFromPairingSessionChanges();
    try {
      await this.#flushPairingSessionWrites();
    } catch (error) {
      stopFailure ??= { error };
    }

    stopFailure ??= this.#pairingBrokerLoopFailure;
    this.#endpoint = undefined;
    this.#localNodeToken = undefined;
    this.#pairingBrokerLoopFailure = undefined;
    this.#port = undefined;
    this.#server = undefined;
    this.#state = 'stopped';

    if (stopFailure !== undefined) {
      throw stopFailure.error;
    }
  }

  public async findExistingNode(): Promise<ExistingLocalNode | undefined> {
    const record = await this.#discoveryFile.read();
    if (record === undefined) {
      return undefined;
    }

    const isLive = await this.#isLiveLocalNode(record.endpoint);
    if (!isLive) {
      await this.#discoveryFile.remove();
      return undefined;
    }

    return {
      endpoint : record.endpoint,
      pid      : record.pid,
    };
  }

  public getStatus(): LocalNodeStatus {
    return {
      discoveryFilePath      : this.#discoveryFile.path,
      endpoint               : this.#endpoint,
      localNodeToken         : this.#localNodeToken,
      pendingPairingRequests : this.#pairingManager.listPendingRequests(),
      pid                    : this.#pid,
      port                   : this.#port,
      state                  : this.#state,
      webSocketSupport       : this.#configOptions.webSocketSupport ?? true,
    };
  }

  public async revokePairingToken(token: string): Promise<boolean> {
    const revoked = this.#server?.revokeLocalNodePairingToken !== undefined
      ? await this.#server.revokeLocalNodePairingToken(token)
      : this.#pairingManager.revokeToken(token);
    if (!revoked) {
      return false;
    }

    await this.#flushPairingSessionWrites();
    return true;
  }

  public async processPendingPairingRequests(): Promise<void> {
    if (this.#pairingBroker === undefined) {
      return;
    }

    if (this.#pairingBrokerProcessing !== undefined) {
      await this.#pairingBrokerProcessing;
      return;
    }

    const processing = this.#processPendingPairingRequests();
    this.#pairingBrokerProcessing = processing;

    try {
      await processing;
    } finally {
      this.#pairingBrokerProcessing = undefined;
    }
  }

  async #processPendingPairingRequests(): Promise<void> {
    const pendingRequests = this.#pairingManager.listPendingRequests();
    for (const request of pendingRequests) {
      await this.#processPairingRequest(request);
    }
  }

  static #createDwnServer(config: DwnServerConfig, pairingManager: LocalNodePairingManager): LocalNodeDwnServer {
    return new DwnServer({
      config,
      localNodePairingManager: pairingManager,
    });
  }

  async #startFirstAvailableServer(): Promise<{ endpoint: string; port: number; server: LocalNodeDwnServer }> {
    for (const port of this.#portCandidates) {
      const config = createLocalNodeDwnServerConfig({
        ...this.#configOptions,
        allowedOrigins: this.#allowedOrigins,
        port,
      });
      const server = this.#createServer(config, this.#pairingManager);

      try {
        await server.start();
        return {
          endpoint: config.baseUrl,
          port,
          server,
        };
      } catch (error) {
        await LocalNode.#closeFailedServer(server);
        if (!isAddressInUseError(error) || this.#portCandidates.length === 1) {
          throw error;
        }
      }
    }

    throw new Error(`LocalNode: no available port found in ${Array.from(this.#portCandidates).join(', ')}.`);
  }

  async #writeDiscoveryFile(): Promise<void> {
    if (this.#endpoint === undefined || this.#localNodeToken === undefined) {
      throw new Error('LocalNode: cannot write discovery file before the node has started.');
    }

    const capabilities = this.#configOptions.webSocketSupport === false ? ['http'] : ['http', 'ws'];
    const record: DwnDiscoveryRecord = {
      capabilities,
      endpoint       : this.#endpoint,
      localNodeToken : this.#localNodeToken,
      pid            : this.#pid,
    };

    await this.#discoveryFile.write(record);
  }

  #startPairingBrokerLoop(): void {
    if (this.#pairingBroker === undefined || this.#pairingBrokerTimer !== undefined) {
      return;
    }

    void this.processPendingPairingRequests().catch((error: unknown): void => {
      this.#pairingBrokerLoopFailure ??= { error };
    });
    this.#pairingBrokerTimer = setInterval((): void => {
      void this.processPendingPairingRequests().catch((error: unknown): void => {
        this.#pairingBrokerLoopFailure ??= { error };
      });
    }, this.#pairingPollIntervalMs);
  }

  #stopPairingBrokerLoop(): void {
    if (this.#pairingBrokerTimer === undefined) {
      return;
    }

    clearInterval(this.#pairingBrokerTimer);
    this.#pairingBrokerTimer = undefined;
  }

  async #processPairingRequest(request: LocalNodePairingRequestView): Promise<void> {
    const decision = await this.#pairingBroker!.decidePairingRequest(request);
    if (decision === 'approve') {
      const approved = this.#pairingManager.approveRequest(request.id);
      if (approved) {
        await this.#flushPairingSessionWrites();
      }
    } else {
      this.#pairingManager.denyRequest(request.id);
    }
  }

  async #isLiveLocalNode(endpoint: string): Promise<boolean> {
    try {
      const endpointWithTrailingSlash = endpoint.endsWith('/') ? endpoint : `${endpoint}/`;
      const response = await this.#fetch(new URL('info', endpointWithTrailingSlash).toString());
      if (!response.ok) {
        return false;
      }

      const serverInfo = await response.json() as LocalNodeInfoResponse;
      return serverInfo.server === localDwnServerName && serverInfo.localNode === true;
    } catch {
      return false;
    }
  }

  async #loadPairingSessions(): Promise<void> {
    const sessions = await this.#pairingSessionStore.read();
    this.#pairingManager.importSessions(sessions);
  }

  #subscribeToPairingSessionChanges(): void {
    this.#pairingSessionChangeUnsubscribe = this.#pairingManager.onSessionsChanged(
      (sessions: LocalNodePairingSessionRecord[]): void => {
        const browserSessions = sessions
          .filter((session: LocalNodePairingSessionRecord): boolean => session.origin !== undefined);

        this.#pairingSessionWriteQueue = this.#pairingSessionWriteQueue.then(async (): Promise<void> => {
          try {
            await this.#pairingSessionStore.write(browserSessions);
          } catch (error) {
            this.#pairingSessionWriteFailure ??= { error };
          }
        });
      },
    );
  }

  #unsubscribeFromPairingSessionChanges(): void {
    this.#pairingSessionChangeUnsubscribe?.();
    this.#pairingSessionChangeUnsubscribe = undefined;
  }

  async #flushPairingSessionWrites(): Promise<void> {
    let pendingWrites: Promise<void>;
    do {
      pendingWrites = this.#pairingSessionWriteQueue;
      await pendingWrites;
    } while (pendingWrites !== this.#pairingSessionWriteQueue);

    const failure = this.#pairingSessionWriteFailure;
    this.#pairingSessionWriteFailure = undefined;
    if (failure !== undefined) {
      throw failure.error;
    }
  }

  async #waitForPairingSessionWrites(): Promise<void> {
    let pendingWrites: Promise<void>;
    do {
      pendingWrites = this.#pairingSessionWriteQueue;
      await pendingWrites;
    } while (pendingWrites !== this.#pairingSessionWriteQueue);
  }

  #getStartResult(): LocalNodeStartResult {
    if (this.#endpoint === undefined || this.#localNodeToken === undefined || this.#port === undefined) {
      throw new Error('LocalNode: node is not running.');
    }

    return {
      discoveryFilePath : this.#discoveryFile.path,
      endpoint          : this.#endpoint,
      localNodeToken    : this.#localNodeToken,
      pid               : this.#pid,
      port              : this.#port,
    };
  }

  static async #closeFailedServer(server: LocalNodeDwnServer): Promise<void> {
    try {
      await server.stop();
    } catch {
      // Best-effort cleanup for partially-started servers.
    }

    try {
      await server.dwn?.close();
    } catch {
      // Best-effort cleanup for partially-created DWN instances.
    }
  }

  async #cleanupStartedServer(): Promise<void> {
    this.#stopPairingBrokerLoop();

    try {
      await this.#server?.stop();
    } finally {
      this.#unsubscribeFromPairingSessionChanges();
      await this.#waitForPairingSessionWrites();
      this.#endpoint = undefined;
      this.#localNodeToken = undefined;
      this.#pairingBrokerLoopFailure = undefined;
      this.#port = undefined;
      this.#server = undefined;
      this.#state = 'stopped';
    }
  }
}

function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const maybeCode = (error as { code?: unknown }).code;
  if (maybeCode === 'EADDRINUSE') {
    return true;
  }

  const maybeMessage = (error as { message?: unknown }).message;
  if (typeof maybeMessage === 'string' && maybeMessage.toLowerCase().includes('address already in use')) {
    return true;
  }

  const maybeCause = (error as { cause?: unknown }).cause;
  return isAddressInUseError(maybeCause);
}
