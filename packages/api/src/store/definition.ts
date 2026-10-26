import type { ProtocolStore } from './protocol-store.js';
import type { StoreCommand } from './command.js';
import type { StoreScope } from './scope.js';
import type { TypedProtocol } from '../protocol-types.js';

import { createCommand } from './command.js';
import { createProtocolStore } from './protocol-store.js';
import { isTypedProtocol } from '../define-protocol.js';

/** Named protocol dependencies retained by a feature definition. */
export type StoreProtocols = Readonly<Record<string, TypedProtocol>>;
/** Named feature dependencies resolved within the same application session scope. */
export type StoreDefinitions = Readonly<Record<string, StoreDefinition>>;

/** An inert feature definition; instances are owned by an application scope. */
export interface StoreDefinition<Value = unknown> {
  /** Protocols needed to construct this feature's manifest and typed bindings. */
  readonly protocols: StoreProtocols;
  /** Features that must be resolved before this feature is constructed. */
  readonly stores: StoreDefinitions;
  /** @internal Instantiate declared dependencies for a single authorization scope. */
  instantiate(scope: StoreScope, resolve: (definition: StoreDefinition) => unknown): Value;
}

/** The feature value returned by a definition's factory. */
export type StoreInstance<Definition extends StoreDefinition> =
  Definition extends StoreDefinition<infer Value> ? Value : never;

type CommandOperation = (input: never) => unknown;
type CommandInput<Operation extends CommandOperation> = Parameters<Operation> extends [] ? void : Parameters<Operation>[0];
// Preserve the author's required, optional, or absent input when exposing run().
type InferredCommand<Operation extends CommandOperation> =
  Omit<StoreCommand<CommandInput<Operation>, Awaited<ReturnType<Operation>>>, 'run'> & {
    run(...input: [] extends Parameters<Operation>
      ? [input?: CommandInput<Operation>] : [input: CommandInput<Operation>]
    ): Promise<Awaited<ReturnType<Operation>>>;
  };

/** Session-owned dependencies and lifecycle controls supplied to a feature factory. */
export type StoreContext<Protocols extends StoreProtocols, Stores extends StoreDefinitions> = Readonly<{
  protocols: { readonly [Name in keyof Protocols]: ProtocolStore<Protocols[Name]> };
  stores: { readonly [Name in keyof Stores]: StoreInstance<Stores[Name]> };
  /** Aborted when this feature closes, fails construction, or its session/facade is replaced. */
  signal: AbortSignal;
  /** Wrap a domain operation with shared progress and error state, preserving its input signature. */
  command<Operation extends CommandOperation>(
    operation: Operation,
  ): InferredCommand<Operation>;
  /** Explicit input/output form of the same session-owned command factory. */
  command<Input, Output>(operation: (input: Input) => Output | Promise<Output>): StoreCommand<Input, Output>;
  /** Register resource cleanup, run after scope invalidation in reverse registration order. */
  onClose(close: () => void | Promise<void>): void;
}>;

/** Static dependencies and the factory that builds their feature interface. */
export type DefineStoreOptions<Protocols extends StoreProtocols, Stores extends StoreDefinitions, Value> = {
  protocols: Protocols;
  stores?: Stores;
  /** Declare inert handles; register effects and cleanup against the scope. */
  create(context: StoreContext<Protocols, Stores>): Value;
};

/**
 * Declare a feature without running its factory or opening storage and connections.
 * The application resolves dependencies and constructs the feature within its session scope.
 */
export function defineStore<
  const Protocols extends StoreProtocols,
  const Stores extends StoreDefinitions = Record<never, never>,
  Value = unknown,
>(options: DefineStoreOptions<Protocols, Stores, Value>): StoreDefinition<Value> {
  const protocols = Object.freeze({ ...options.protocols });
  const stores = Object.freeze({ ...options.stores });
  for (const [name, protocol] of Object.entries(protocols)) {
    if (!isTypedProtocol(protocol)) {
      throw new TypeError(`defineStore: protocol '${name}' must be a TypedProtocol.`);
    }
  }
  const create = options.create;
  return Object.freeze({
    protocols,
    stores,
    instantiate(scope: StoreScope, resolve: (definition: StoreDefinition) => unknown): Value {
      const bindings = Object.fromEntries(Object.entries(protocols).map(([name, protocol]): [string, ProtocolStore<TypedProtocol>] =>
        [name, createProtocolStore(protocol, scope)]));
      const dependencies = Object.fromEntries(Object.entries(stores).map(([name, definition]): [string, unknown] =>
        [name, resolve(definition)]));
      return create({
        // The declared keys pair each original protocol with its own typed binding.
        protocols : bindings as unknown as StoreContext<Protocols, Stores>['protocols'],
        stores    : dependencies as StoreContext<Protocols, Stores>['stores'],
        signal    : scope.signal,
        command   : <Input, Output>(operation: (input: Input) => Output | Promise<Output>): StoreCommand<Input, Output> =>
          createCommand(scope, operation),
        onClose: (close: () => void | Promise<void>): void => scope.onClose(close),
      });
    },
  });
}
