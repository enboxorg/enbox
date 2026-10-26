import type { Enbox } from '../enbox.js';
import type { ObservableStore } from '../observable-store.js';
import type { StoreScope } from './scope.js';
import type { TypedProtocol } from '../protocol-types.js';
import type { ApplicationManifest, ApplicationManifestProtocolInput } from '../application-manifest.js';
import type { ConnectionSnapshot, ConnectionStore } from '../connection-store.js';
import type { StoreDefinition, StoreDefinitions, StoreInstance } from './definition.js';

import { defineApplicationManifest } from '../application-manifest.js';
import { StoreNotConnectedError, StoreRetiredError } from './scope.js';

export type ApplicationDefinition<Stores extends StoreDefinitions = StoreDefinitions> = Readonly<{
  stores: Stores;
  manifest: ApplicationManifest;
}>;

export type DefineApplicationOptions<Stores extends StoreDefinitions> = {
  stores: Stores;
  /** Additional protocols and explicit permission overrides for store dependencies. */
  protocols?: readonly ApplicationManifestProtocolInput[];
};

/** Compose store dependencies into the SDK's single protocol and permission manifest. */
export function defineApplication<const Stores extends StoreDefinitions>(
  options: DefineApplicationOptions<Stores>,
): ApplicationDefinition<Stores> {
  const stores = Object.freeze({ ...options.stores });
  const definitions = collectStores(stores);
  const protocols = new Map<string, TypedProtocol>();
  for (const definition of definitions) {
    for (const protocol of Object.values(definition.protocols)) {
      const uri = protocol.definition.protocol;
      const previous = protocols.get(uri);
      if (previous !== undefined && previous !== protocol) {
        throw new TypeError(`defineApplication: conflicting typed protocols for '${uri}'. Share one protocol definition between stores.`);
      }
      protocols.set(uri, protocol);
    }
  }
  const overrides = new Map<string, ApplicationManifestProtocolInput>();
  for (const input of options.protocols ?? []) {
    const protocol = 'definition' in input ? input : input.protocol;
    const uri = protocol.definition.protocol;
    if (overrides.has(uri)) {
      throw new TypeError(`defineApplication: duplicate explicit protocol '${uri}'.`);
    }
    const dependency = protocols.get(uri);
    if (dependency !== undefined && dependency !== protocol) {
      throw new TypeError(`defineApplication: explicit protocol '${uri}' conflicts with a store dependency.`);
    }
    overrides.set(uri, input);
    protocols.set(uri, protocol);
  }
  const manifest = defineApplicationManifest({
    protocols: [...protocols.entries()].map(([uri, protocol]): ApplicationManifestProtocolInput => overrides.get(uri) ?? protocol),
  });
  return Object.freeze({ stores, manifest });
}

/** One headless resource owner around the native connection store. */
export interface ApplicationRuntime extends ObservableStore<ConnectionSnapshot> {
  readonly connection: ConnectionStore;
  getServerSnapshot(): ConnectionSnapshot;
  store<Definition extends StoreDefinition>(definition: Definition): StoreInstance<Definition>;
  initialize(): Promise<ConnectionSnapshot>;
  /** Retire resource generations and dispose the owned native connection. */
  dispose(): Promise<void>;
}

export type CreateApplicationOptions = {
  /** The application takes ownership of this connection's terminal disposal. */
  connection: ConnectionStore;
};

type Generation = {
  abort: AbortController;
  enbox: Enbox | undefined;
  session: ConnectionSnapshot['session'];
  instances: Map<StoreDefinition, unknown>;
  cleanup: (() => void | Promise<void>)[];
  detachSession?: () => void;
};

/** Create an application without initializing authentication, storage, or protocol views. */
export function createApplication(
  definition: ApplicationDefinition,
  options: CreateApplicationOptions,
): ApplicationRuntime {
  return new HeadlessApplication(definition, options.connection);
}

class HeadlessApplication implements ApplicationRuntime {
  public readonly connection: ConnectionStore;
  private readonly _definitions: Set<StoreDefinition>;
  private readonly _listeners = new Set<(snapshot: ConnectionSnapshot) => void>();
  private readonly _serverSnapshot: ConnectionSnapshot = Object.freeze({ phase: 'initializing', vaultLocked: true });
  private readonly _retirements = new Set<Promise<void>>();
  private readonly _unsubscribe: () => void;
  private _generation: Generation | undefined;
  private _disposePromise: Promise<void> | undefined;
  private _disposed = false;

  public constructor(definition: ApplicationDefinition, connection: ConnectionStore) {
    this.connection = connection;
    this._definitions = collectStores(definition.stores);
    this._unsubscribe = connection.subscribe((): void => {
      if (this._disposed) {
        return;
      }
      this._reconcile();
      this._publish();
    });
  }

  public getSnapshot = (): ConnectionSnapshot => this.connection.getSnapshot();
  public getServerSnapshot = (): ConnectionSnapshot => this._serverSnapshot;

  public subscribe = (listener: (snapshot: ConnectionSnapshot) => void): (() => void) => {
    if (this._disposed) {
      throw new StoreRetiredError();
    }
    this._listeners.add(listener);
    return (): void => { this._listeners.delete(listener); };
  };

  public store<Definition extends StoreDefinition>(definition: Definition): StoreInstance<Definition> {
    if (this._disposed) {
      throw new StoreRetiredError();
    }
    if (!this._definitions.has(definition)) {
      throw new TypeError('Application.store: register the feature in defineApplication before resolving it.');
    }
    const generation = this._reconcile();
    if (!generation.instances.has(definition)) {
      for (const dependency of Object.values(definition.stores)) {
        this.store(dependency);
      }
      const lifetime = new AbortController();
      const signal = AbortSignal.any([generation.abort.signal, lifetime.signal]);
      const cleanup: (() => void | Promise<void>)[] = [];
      let closePromise: Promise<void> | undefined;
      const close = (): Promise<void> => {
        if (closePromise === undefined) {
          closePromise = closeResources([...cleanup].reverse(), 'Feature cleanup failed.')
            .finally((): void => { cleanup.length = 0; });
          lifetime.abort(new StoreRetiredError());
        }
        return closePromise;
      };
      generation.cleanup.push(close);
      const scope: StoreScope = {
        signal,
        assertCurrent: (): void => {
          if (signal.aborted) {
            throw new StoreRetiredError();
          }
          this._assertCurrent(generation);
        },
        getEnbox: (): Enbox => {
          scope.assertCurrent();
          return generation.enbox!;
        },
        onClose: (release: () => void | Promise<void>): void => {
          if (signal.aborted) {
            this._trackCleanup([release]);
          } else {
            cleanup.push(release);
          }
        },
      };
      try {
        const value = definition.instantiate(scope, (dependency): unknown => this.store(dependency));
        if (signal.aborted) {
          throw new StoreRetiredError();
        }
        generation.instances.set(definition, value);
      } catch (error) {
        const closing = close();
        this._trackCleanup([(): Promise<void> => closing]);
        throw error;
      }
    }
    // The definition token indexes only its own factory result.
    return generation.instances.get(definition) as StoreInstance<Definition>;
  }

  public initialize(): Promise<ConnectionSnapshot> {
    if (this._disposed) {
      return Promise.reject(new StoreRetiredError());
    }
    return this.connection.initialize();
  }

  public dispose(): Promise<void> {
    if (this._disposePromise !== undefined) {
      return this._disposePromise;
    }
    this._disposed = true;
    // Install the shared completion before abort callbacks can reenter disposal.
    this._disposePromise = Promise.resolve().then(async (): Promise<void> => {
      try {
        await this._drainRetirements();
      } finally {
        await this.connection.dispose();
      }
    });
    this._unsubscribe();
    this._listeners.clear();
    this._retire(this._generation);
    return this._disposePromise;
  }

  private _reconcile(): Generation {
    if (this._disposed) {
      throw new StoreRetiredError();
    }
    const snapshot = this.connection.getSnapshot();
    const session = snapshot.session?.signal.aborted === true ? undefined : snapshot.session;
    const enbox = session === undefined ? undefined : snapshot.enbox;
    const current = this._generation;
    if (current !== undefined && current.enbox === enbox && current.session === session) {
      return current;
    }
    const generation: Generation = {
      abort: new AbortController(), enbox, session, instances: new Map(), cleanup: [],
    };
    this._generation = generation;
    if (session !== undefined) {
      const abort = (): void => {
        if (this._generation !== generation || this._disposed) {
          return;
        }
        this._reconcile();
        this._publish();
      };
      session.signal.addEventListener('abort', abort, { once: true });
      generation.detachSession = (): void => session.signal.removeEventListener('abort', abort);
    }
    this._retire(current);
    // Abort listeners may resolve this successor or publish a still newer binding.
    return this._reconcile();
  }

  private _assertCurrent(generation: Generation): void {
    if (this._disposed || generation.abort.signal.aborted || this._generation !== generation) {
      throw new StoreRetiredError();
    }
    const snapshot = this.connection.getSnapshot();
    const session = snapshot.session?.signal.aborted === true ? undefined : snapshot.session;
    const enbox = session === undefined ? undefined : snapshot.enbox;
    if (generation.enbox !== enbox || generation.session !== session) {
      throw new StoreRetiredError();
    }
    if (generation.enbox === undefined || generation.session === undefined) {
      throw new StoreNotConnectedError();
    }
  }

  private _retire(generation: Generation | undefined): void {
    if (generation === undefined) {
      return;
    }
    if (this._generation === generation) {
      this._generation = undefined;
    }
    generation.detachSession?.();
    generation.abort.abort(new StoreRetiredError());
    generation.instances.clear();
    this._trackCleanup([...generation.cleanup].reverse());
    generation.cleanup.length = 0;
  }

  private _trackCleanup(cleanup: (() => void | Promise<void>)[]): void {
    const promise = closeResources(cleanup, 'Store resource cleanup failed.');
    this._retirements.add(promise);
    void promise.then((): void => { this._retirements.delete(promise); }, (cause: unknown): void => {
      this._retirements.delete(promise);
      console.warn('[@enbox/api] Store cleanup failed.', cause);
    });
  }

  private async _drainRetirements(errors: unknown[] = []): Promise<void> {
    const results = await Promise.allSettled(this._retirements);
    for (const result of results) {
      if (result.status === 'rejected') { errors.push(result.reason); }
    }
    if (this._retirements.size > 0) {
      return this._drainRetirements(errors);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Application resource cleanup failed.');
    }
  }

  private _publish(): void {
    const snapshot = this.getSnapshot();
    const listeners = [...this._listeners];
    for (const listener of listeners) {
      if (this._listeners.has(listener)) {
        try {
          listener(snapshot);
        } catch {
          // Consumer failures cannot interrupt retirement or other subscribers.
        }
      }
    }
  }
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
      throw new TypeError('defineApplication: feature dependencies must not contain cycles.');
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
