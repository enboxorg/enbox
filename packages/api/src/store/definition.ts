import type { Enbox } from '../enbox.js';
import type { ModuleStore } from './module-store.js';
import type { ObservationFactory } from './observed-store.js';
import type { StoreCommand } from './command.js';
import type { StoreScope } from './scope.js';
import type { TypedModule } from '../module-types.js';

import { createCommand } from './command.js';
import { createModuleStore } from './module-store.js';
import { createObservationFactory } from './observed-store.js';
import { isTypedModule } from '../define-module.js';
import { withStoreSignal } from './scope.js';

/** Named module dependencies retained by a feature definition. */
export type StoreModules = Readonly<Record<string, TypedModule>>;
/** Named feature dependencies resolved within the same application session scope. */
export type StoreDefinitions = Readonly<Record<string, StoreDefinition>>;

const storeFactory = Symbol('storeFactory');

/** An inert feature definition; instances are owned by an application scope. */
export interface StoreDefinition<Value = unknown> {
  /** Modules needed to construct this feature's manifest and typed bindings. */
  readonly modules: StoreModules;
  /** Features that must be resolved before this feature is constructed. */
  readonly stores: StoreDefinitions;
  /** @internal Construct a feature from dependencies already resolved in its authorization scope. */
  [storeFactory](scope: StoreScope, dependencies: Readonly<Record<string, unknown>>): Value;
}

/** The feature value returned by a definition's factory. */
export type StoreInstance<Definition extends StoreDefinition> =
  Definition extends StoreDefinition<infer Value> ? Value : never;

type CommandOperation = (input: never) => unknown;
type CommandInput<Operation extends CommandOperation> = Parameters<Operation> extends [] ? void : Parameters<Operation>[0];
type SingleInputOperation<Operation extends CommandOperation> =
  Parameters<Operation> extends [] | [input?: unknown] ? Operation : never;
// Preserve the author's required, optional, or absent input when exposing run().
type InferredCommand<Operation extends CommandOperation> =
  Omit<StoreCommand<CommandInput<Operation>, Awaited<ReturnType<Operation>>>, 'run'> & {
    // Preserve function unions so callers must satisfy every possible operation.
    run: Parameters<Operation> extends []
      ? (input?: void) => Promise<Awaited<ReturnType<Operation>>>
      : Operation extends CommandOperation
        ? (...input: Parameters<Operation>) => Promise<Awaited<ReturnType<Operation>>>
        : never;
  };

/** Session-owned dependencies and lifecycle controls supplied to a feature factory. */
export type StoreContext<Modules extends StoreModules, Stores extends StoreDefinitions> = Readonly<{
  /** Resolve the active Enbox session inside a command or observation opener; throws when inactive or retired. */
  enbox(): Enbox;
  modules: { readonly [Name in keyof Modules]: ModuleStore<Modules[Name]> };
  stores: { readonly [Name in keyof Stores]: StoreInstance<Stores[Name]> };
  /** Aborted when this feature closes, fails construction, or its session/facade is replaced. */
  signal: AbortSignal;
  /** Declare an observable store over a native observation or a changing input; construction performs no I/O. */
  observe: ObservationFactory;
  /** Wrap a domain operation with shared progress and error state, preserving its input signature. */
  command<Operation extends CommandOperation>(
    operation: Operation & SingleInputOperation<Operation>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): InferredCommand<Operation>;
  /**
   * Register cleanup before starting owned work; return its complete asynchronous release.
   * Callbacks run after invalidation in reverse order. Late registrations remain application-owned
   * but do not extend this feature's dependency teardown sequence.
   */
  onClose(close: () => void | Promise<void>): void;
}>;

/** Static dependencies and the factory that builds their feature interface. */
export type DefineStoreOptions<Modules extends StoreModules, Stores extends StoreDefinitions, Value> = {
  modules?: Modules;
  stores?: Stores;
  /** Return inert handles synchronously; register effects and cleanup against the scope. */
  create(context: StoreContext<Modules, Stores>): Value & ([Extract<Value, PromiseLike<unknown>>] extends [never] ? unknown : never);
};

/**
 * Declare a feature without running its factory or opening storage and connections.
 * The application resolves dependencies and constructs the feature within its session scope.
 */
export function defineStore<
  const Modules extends StoreModules = Record<never, never>,
  const Stores extends StoreDefinitions = Record<never, never>,
  Value = unknown,
>(options: DefineStoreOptions<Modules, Stores, Value>): StoreDefinition<Value> {
  const modules: StoreModules = Object.freeze({ ...options.modules });
  const stores = Object.freeze({ ...options.stores });
  for (const [name, module] of Object.entries(modules)) {
    if (!isTypedModule(module)) {
      throw new TypeError(`defineStore: module '${name}' must be a TypedModule.`);
    }
  }
  const create = options.create;
  return Object.freeze({
    modules,
    stores,
    [storeFactory](scope: StoreScope, dependencies: Readonly<Record<string, unknown>>): Value {
      const bindings = Object.fromEntries(Object.entries(modules).map(([name, module]): [string, unknown] =>
        [name, createModuleStore(module, scope)]));
      // Runtime dispatch is single-input; authoring retains its optionality and awaited result.
      const command = ((operation: CommandOperation, options?: Readonly<{ signal?: AbortSignal }>) =>
        createCommand(withStoreSignal(scope, options?.signal), operation)) as StoreContext<Modules, Stores>['command'];
      return create({
        enbox   : (): Enbox => scope.getEnbox(),
        // The declared keys pair each original module with its own typed binding.
        modules : bindings as unknown as StoreContext<Modules, Stores>['modules'],
        stores  : dependencies as StoreContext<Modules, Stores>['stores'],
        signal  : scope.signal,
        observe : createObservationFactory(scope),
        command,
        onClose : (close: () => void | Promise<void>): void => { scope.onClose(close); },
      });
    },
  });
}

/** @internal Only the application owner invokes a definition's hidden factory. */
export function instantiateStore<Definition extends StoreDefinition>(
  definition: Definition,
  scope: StoreScope,
  dependencies: Readonly<Record<string, unknown>>,
): StoreInstance<Definition> {
  return definition[storeFactory](scope, dependencies) as StoreInstance<Definition>;
}
