import type { Enbox } from '../enbox.js';
import type { StoreScope } from './scope.js';
import type { TypedProtocol } from '../protocol-types.js';
import type { ApplicationManifest, ApplicationManifestProtocolInput } from '../application-manifest.js';
import type { ConnectionSnapshot, ConnectionStore } from '../connection-store.js';
import type { StoreDefinition, StoreDefinitions, StoreInstance } from './definition.js';

import { defineApplicationManifest } from '../application-manifest.js';
import { instantiateStore } from './definition.js';
import { StoreNotConnectedError, StoreRetiredError } from './scope.js';

/** Register features and construct the native connection from their derived manifest. */
export type CreateApplicationOptions<Stores extends StoreDefinitions = StoreDefinitions> = {
  stores: Stores;
  /** Additional protocols and explicit permission overrides for store dependencies. */
  protocols?: readonly ApplicationManifestProtocolInput[];
  /** Called once after validating dependencies; the application owns the returned connection. */
  connection(manifest: ApplicationManifest): ConnectionStore;
};

/** Compose dependencies before any native connection or feature instance is constructed. */
function createManifest(
  definitions: ReadonlySet<StoreDefinition>,
  explicitProtocols: readonly ApplicationManifestProtocolInput[] = [],
): ApplicationManifest {
  const protocols = new Map<string, TypedProtocol>();
  for (const definition of definitions) {
    for (const protocol of Object.values(definition.protocols)) {
      const uri = protocol.definition.protocol;
      const previous = protocols.get(uri);
      if (previous !== undefined && previous !== protocol) {
        throw new TypeError(`createApplication: conflicting typed protocols for '${uri}'. Share one protocol definition between stores.`);
      }
      protocols.set(uri, protocol);
    }
  }
  const overrides = new Map<string, ApplicationManifestProtocolInput>();
  for (const input of explicitProtocols) {
    const protocol = 'definition' in input ? input : input.protocol;
    const uri = protocol.definition.protocol;
    if (overrides.has(uri)) {
      throw new TypeError(`createApplication: duplicate explicit protocol '${uri}'.`);
    }
    const dependency = protocols.get(uri);
    if (dependency !== undefined && dependency !== protocol) {
      throw new TypeError(`createApplication: explicit protocol '${uri}' conflicts with a store dependency.`);
    }
    overrides.set(uri, input);
    protocols.set(uri, protocol);
  }
  return defineApplicationManifest({
    protocols: [...protocols.entries()].map(([uri, protocol]): ApplicationManifestProtocolInput => overrides.get(uri) ?? protocol),
  });
}

/** Own session-scoped features and the native connection's lifetime. */
export interface ApplicationRuntime {
  /** The protocol and permission manifest derived from the registered features. */
  readonly manifest: ApplicationManifest;
  /** The authoritative connection state and actions, including connect and disconnect. */
  readonly connection: ConnectionStore;
  /** Invalidate feature lookups on native connection publications or scope retirement; compare the resolved instance identity. */
  subscribe: (listener: () => void) => () => void;
  /**
   * Resolve a registered feature once per native session/facade pair, including its dependencies.
   * Disconnected applications supply inert feature instances whose resources remain idle.
   */
  store<Definition extends StoreDefinition>(definition: Definition): StoreInstance<Definition>;
  /** Initialize the owned connection and restore its saved session. */
  initialize(): Promise<ConnectionSnapshot>;
  /** Permanently retire stores, await their cleanup, and dispose the native connection once. */
  dispose(): Promise<void>;
}

/**
 * Own feature instances and cleanup for one exact SDK session/facade pair.
 * A disconnected scope supplies idle stores without SDK authority.
 */
type SessionScope = {
  abortController: AbortController;
  enbox: Enbox | undefined;
  authorizationSession: ConnectionSnapshot['session'];
  storeInstances: Map<StoreDefinition, unknown>;
  closeCallbacks: (() => void | Promise<void>)[];
  detachSessionAbort?: () => void;
};

/**
 * Create the owner for registered features and the supplied connection.
 * Construction subscribes to connection changes; initialize() starts session restoration.
 */
export function createApplication<const Stores extends StoreDefinitions>(
  options: CreateApplicationOptions<Stores>,
): ApplicationRuntime {
  const definitions = collectStores(options.stores);
  const manifest = createManifest(definitions, options.protocols);
  return new HeadlessApplication(definitions, manifest, options.connection(manifest));
}

class HeadlessApplication implements ApplicationRuntime {
  public readonly manifest: ApplicationManifest;
  public readonly connection: ConnectionStore;
  private readonly _definitions: Set<StoreDefinition>;
  private readonly _listeners = new Set<() => void>();
  private readonly _pendingCleanup = new Set<Promise<void>>();
  private readonly _cleanupFailures: unknown[] = [];
  private readonly _unsubscribeConnection: () => void;
  private _sessionScope: SessionScope | undefined;
  private _disposePromise: Promise<void> | undefined;

  public constructor(definitions: Set<StoreDefinition>, manifest: ApplicationManifest, connection: ConnectionStore) {
    this.manifest = manifest;
    this.connection = connection;
    this._definitions = definitions;
    this._unsubscribeConnection = connection.subscribe((): void => {
      if (this._disposePromise !== undefined) {
        return;
      }
      this._resolveSessionScope();
      this._publish();
    });
  }

  public subscribe = (listener: () => void): (() => void) => {
    if (this._disposePromise !== undefined) {
      throw new StoreRetiredError();
    }
    this._listeners.add(listener);
    return (): void => { this._listeners.delete(listener); };
  };

  public store<Definition extends StoreDefinition>(definition: Definition): StoreInstance<Definition> {
    if (this._disposePromise !== undefined) {
      throw new StoreRetiredError();
    }
    if (!this._definitions.has(definition)) {
      throw new TypeError('Application.store: register the feature in createApplication before resolving it.');
    }
    const sessionScope = this._resolveSessionScope();
    if (!sessionScope.storeInstances.has(definition)) {
      // Reverse teardown must close this feature before the stores it depends on.
      const dependencies = Object.fromEntries(Object.entries(definition.stores).map(([name, dependency]): [string, unknown] =>
        [name, this.store(dependency)]));
      const storeAbortController = new AbortController();
      const signal = AbortSignal.any([sessionScope.abortController.signal, storeAbortController.signal]);
      const closeCallbacks: (() => void | Promise<void>)[] = [];
      let closePromise: Promise<void> | undefined;
      const close = (): Promise<void> => {
        if (closePromise === undefined) {
          closePromise = closeResources(closeCallbacks.splice(0).reverse(), 'Feature cleanup failed.');
          storeAbortController.abort(new StoreRetiredError());
        }
        return closePromise;
      };
      sessionScope.closeCallbacks.push(close);
      const storeScope: StoreScope = {
        signal,
        assertCurrent: (): void => {
          if (signal.aborted) {
            throw new StoreRetiredError();
          }
          this._assertCurrentSessionScope(sessionScope);
        },
        getEnbox: (): Enbox => {
          storeScope.assertCurrent();
          return sessionScope.enbox!;
        },
        onClose: (release: () => void | Promise<void>): (() => void) => {
          if (signal.aborted) {
            this._trackCleanup([release]);
            return (): void => {};
          } else {
            closeCallbacks.push(release);
            return (): void => {
              const index = closeCallbacks.indexOf(release);
              if (index !== -1) { closeCallbacks.splice(index, 1); }
            };
          }
        },
      };
      try {
        const value = instantiateStore(definition, storeScope, dependencies);
        assertSynchronousFeature(value);
        if (signal.aborted) {
          throw new StoreRetiredError();
        }
        sessionScope.storeInstances.set(definition, value);
      } catch (error) {
        const closing = close();
        this._trackCleanup([(): Promise<void> => closing]);
        throw error;
      }
    }
    // The definition token indexes only its own factory result.
    return sessionScope.storeInstances.get(definition) as StoreInstance<Definition>;
  }

  public initialize(): Promise<ConnectionSnapshot> {
    if (this._disposePromise !== undefined) {
      return Promise.reject(new StoreRetiredError());
    }
    return this.connection.initialize();
  }

  public dispose(): Promise<void> {
    if (this._disposePromise !== undefined) {
      return this._disposePromise;
    }
    // Installing the shared completion retires the runtime before cleanup can reenter.
    this._disposePromise = Promise.resolve().then(async (): Promise<void> => {
      await this._waitForCleanup();
      try {
        await this.connection.dispose();
      } catch (error) {
        this._cleanupFailures.push(error);
      }
      // Native teardown may cause a resource to register one final release.
      await this._waitForCleanup();
      if (this._cleanupFailures.length > 0) {
        throw new AggregateError(this._cleanupFailures, 'Application resource cleanup failed.');
      }
    });
    this._unsubscribeConnection();
    this._listeners.clear();
    this._retireSessionScope(this._sessionScope);
    return this._disposePromise;
  }

  private _resolveSessionScope(): SessionScope {
    if (this._disposePromise !== undefined) {
      throw new StoreRetiredError();
    }
    const snapshot = this.connection.getSnapshot();
    // A session can abort before the connection publishes its replacement state.
    const authorizationSession = snapshot.session?.signal.aborted === true ? undefined : snapshot.session;
    const enbox = authorizationSession === undefined ? undefined : snapshot.enbox;
    const currentScope = this._sessionScope;
    if (currentScope !== undefined && currentScope.enbox === enbox && currentScope.authorizationSession === authorizationSession) {
      return currentScope;
    }
    const sessionScope: SessionScope = {
      abortController: new AbortController(), enbox, authorizationSession, storeInstances: new Map(), closeCallbacks: [],
    };
    // Old abort callbacks can resolve stores synchronously, so expose their successor first.
    this._sessionScope = sessionScope;
    if (authorizationSession !== undefined) {
      const handleSessionAbort = (): void => {
        if (this._sessionScope !== sessionScope || this._disposePromise !== undefined) {
          return;
        }
        this._resolveSessionScope();
        this._publish();
      };
      authorizationSession.signal.addEventListener('abort', handleSessionAbort, { once: true });
      sessionScope.detachSessionAbort = (): void => authorizationSession.signal.removeEventListener('abort', handleSessionAbort);
    }
    this._retireSessionScope(currentScope);
    // A cleanup callback may replace the connection again; return its latest scope.
    return this._resolveSessionScope();
  }

  private _assertCurrentSessionScope(sessionScope: SessionScope): void {
    if (this._disposePromise !== undefined || sessionScope.abortController.signal.aborted || this._sessionScope !== sessionScope) {
      throw new StoreRetiredError();
    }
    const snapshot = this.connection.getSnapshot();
    const authorizationSession = snapshot.session?.signal.aborted === true ? undefined : snapshot.session;
    const enbox = authorizationSession === undefined ? undefined : snapshot.enbox;
    if (sessionScope.enbox !== enbox || sessionScope.authorizationSession !== authorizationSession) {
      throw new StoreRetiredError();
    }
    if (sessionScope.enbox === undefined || sessionScope.authorizationSession === undefined) {
      throw new StoreNotConnectedError();
    }
  }

  private _retireSessionScope(sessionScope: SessionScope | undefined): void {
    if (sessionScope === undefined) {
      return;
    }
    if (this._sessionScope === sessionScope) {
      this._sessionScope = undefined;
    }
    sessionScope.detachSessionAbort?.();
    sessionScope.abortController.abort(new StoreRetiredError());
    sessionScope.storeInstances.clear();
    // Authority ends synchronously; asynchronous releases remain owned until disposal finishes.
    this._trackCleanup(sessionScope.closeCallbacks.splice(0).reverse());
  }

  private _trackCleanup(cleanup: (() => void | Promise<void>)[]): void {
    const promise = closeResources(cleanup, 'Store resource cleanup failed.');
    this._pendingCleanup.add(promise);
    void promise.then((): void => { this._pendingCleanup.delete(promise); }, (cause: unknown): void => {
      this._pendingCleanup.delete(promise);
      this._cleanupFailures.push(cause);
      console.warn('[@enbox/api] Store cleanup failed.', cause);
    });
  }

  private async _waitForCleanup(): Promise<void> {
    await Promise.allSettled(this._pendingCleanup);
    // Cleanup callbacks can register follow-up releases while earlier ones finish.
    if (this._pendingCleanup.size > 0) {
      return this._waitForCleanup();
    }
  }

  private _publish(): void {
    const listeners = [...this._listeners];
    for (const listener of listeners) {
      if (this._listeners.has(listener)) {
        try {
          listener();
        } catch {
          // Consumer failures cannot interrupt retirement or other subscribers.
        }
      }
    }
  }
}

/** Invalid asynchronous factories must not escape as feature instances or unhandled rejections. */
function assertSynchronousFeature(value: unknown): void {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) { return; }
  if (typeof Reflect.get(value, 'then') !== 'function') { return; }
  void Promise.resolve(value).catch((): void => {});
  throw new TypeError('defineStore: create must return a synchronous feature value.');
}

/** Release dependents before dependencies, retaining every failure until all callbacks finish. */
function closeResources(cleanup: readonly (() => void | Promise<void>)[], message: string): Promise<void> {
  const errors: unknown[] = [];
  const completion = cleanup.reduce((previous, close): Promise<void> => previous.then(async (): Promise<void> => {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }), Promise.resolve());
  return completion.then((): void => {
    if (errors.length > 0) {
      throw new AggregateError(errors, message);
    }
  });
}

function collectStores(stores: StoreDefinitions): Set<StoreDefinition> {
  const definitions = new Set<StoreDefinition>();
  const visiting = new Set<StoreDefinition>();
  const visit = (definition: StoreDefinition): void => {
    if (visiting.has(definition)) {
      throw new TypeError('createApplication: feature dependencies must not contain cycles.');
    }
    if (definitions.has(definition)) {
      return;
    }
    visiting.add(definition);
    for (const dependency of Object.values(definition.stores)) {
      visit(dependency);
    }
    visiting.delete(definition);
    definitions.add(definition);
  };
  Object.values(stores).forEach(visit);
  return definitions;
}
