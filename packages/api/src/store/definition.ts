import type { ProtocolStore } from './protocol-store.js';
import type { StoreCommand } from './command.js';
import type { StoreScope } from './scope.js';
import type { TypedProtocol } from '../protocol-types.js';

import { createCommand } from './command.js';
import { createProtocolStore } from './protocol-store.js';
import { isTypedProtocol } from '../define-protocol.js';

export type StoreProtocols = Readonly<Record<string, TypedProtocol>>;
export type StoreDefinitions = Readonly<Record<string, StoreDefinition>>;

/** An inert feature definition; instances are owned by an application scope. */
export interface StoreDefinition<Value = unknown> {
  readonly protocols: StoreProtocols;
  readonly stores: StoreDefinitions;
  /** @internal Instantiate declared dependencies for a single authorization scope. */
  instantiate(scope: StoreScope, resolve: (definition: StoreDefinition) => unknown): Value;
}

export type StoreInstance<Definition extends StoreDefinition> =
  Definition extends StoreDefinition<infer Value> ? Value : never;

export type StoreContext<Protocols extends StoreProtocols, Stores extends StoreDefinitions> = Readonly<{
  protocols: { readonly [Name in keyof Protocols]: ProtocolStore<Protocols[Name]> };
  stores: { readonly [Name in keyof Stores]: StoreInstance<Stores[Name]> };
  signal: AbortSignal;
  command<Output>(operation: () => Output | Promise<Output>): StoreCommand<void, Output>;
  command<Input, Output>(operation: (input: Input) => Output | Promise<Output>): StoreCommand<Input, Output>;
  onClose(close: () => void | Promise<void>): void;
}>;

export type DefineStoreOptions<Protocols extends StoreProtocols, Stores extends StoreDefinitions, Value> = {
  protocols: Protocols;
  stores?: Stores;
  /** Declare inert handles; register effects and cleanup against the scope. */
  create(context: StoreContext<Protocols, Stores>): Value;
};

/** Declare named protocol resources and domain commands without opening storage or connections. */
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
