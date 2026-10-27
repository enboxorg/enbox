import type { BrowserConnectHandlerOptions } from './browser-connect-handler.js';
import type { ConnectHandler } from '@enbox/auth';
import type { ApplicationRuntime, ConnectionStoreOptions, CreateApplicationOptions, StoreDefinitions } from '@enbox/api';

import { BrowserConnectHandler } from './browser-connect-handler.js';
import { createConnectionStore, createApplication as createHeadlessApplication } from '@enbox/api';

/** Features, native connection settings, and the browser wallet defaults for one application. */
export type BrowserApplicationOptions<Stores extends StoreDefinitions = StoreDefinitions> =
  Pick<CreateApplicationOptions<Stores>, 'stores' | 'protocols'> & (
    | {
      /** Supply a native connection factory for custom hosts and tests. */
      connection: CreateApplicationOptions<Stores>['connection'];
      wallet?: never;
      connectHandler?: never;
    }
    | ({
      connection?: Omit<ConnectionStoreOptions, 'application' | 'connectHandler' | 'auth' | 'agent'>;
    } & (
      | { wallet?: BrowserConnectHandlerOptions; connectHandler?: never }
      | { connectHandler: ConnectHandler; wallet?: never }
    ))
  );

const walletOptionsByApplication = new WeakMap<ApplicationRuntime, BrowserConnectHandlerOptions>();

/**
 * Create the application and its native browser connection without starting session restoration.
 * The manifest comes from the feature definitions. The application owns connection disposal.
 */
export function createApplication<const Stores extends StoreDefinitions>(
  options: BrowserApplicationOptions<Stores>,
): ApplicationRuntime {
  const registration = {
    stores: options.stores,
    ...(options.protocols === undefined ? {} : { protocols: options.protocols }),
  };
  if (typeof options.connection === 'function') {
    if (options.wallet !== undefined || options.connectHandler !== undefined) {
      throw new TypeError('createApplication: a native connection factory owns its connect handler.');
    }
    return createHeadlessApplication({ ...registration, connection: options.connection });
  }
  if (options.wallet !== undefined && options.connectHandler !== undefined) {
    throw new TypeError('createApplication: choose wallet options or a connectHandler.');
  }
  for (const key of ['application', 'connectHandler', 'auth', 'agent']) {
    if (options.connection !== undefined && Object.prototype.hasOwnProperty.call(options.connection, key)) {
      throw new TypeError(`createApplication: connection.${key} is owned by the application.`);
    }
  }
  const walletOptions = options.connectHandler === undefined ? Object.freeze({ ...options.wallet }) : undefined;
  const connectHandler = options.connectHandler ?? BrowserConnectHandler(walletOptions);
  const application = createHeadlessApplication({
    ...registration,
    connection: (manifest) => createConnectionStore({
      ...options.connection,
      application: manifest,
      connectHandler,
    }),
  });
  if (walletOptions !== undefined) { walletOptionsByApplication.set(application, walletOptions); }
  return application;
}

/** Browser bindings use these defaults when a user supplies per-call wallet options. */
export function getApplicationWalletOptions(application: ApplicationRuntime): BrowserConnectHandlerOptions | undefined {
  return walletOptionsByApplication.get(application);
}
