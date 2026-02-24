import type { GenericMessage } from '@enbox/dwn-sdk-js';

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request-scoped context that threads the original DWN message through the
 * call stack without modifying the `DataStore` interface.
 *
 * When a `RecordsRead` is processed, `RelayServer` wraps the
 * `dwn.processMessage()` call in `requestContext.run(message, ...)`.
 * Inside the call, `RelayDataStore.get()` can retrieve the original signed
 * message via `requestContext.getStore()` and forward it to a peer DWN for
 * proxy reads of non-published records.
 *
 * Background operations (sync, eviction) run without a request context,
 * so `getStore()` returns `undefined` — the proxy falls back to an
 * anonymous (unsigned) RecordsRead, which only works for published records.
 */
export const requestContext = new AsyncLocalStorage<GenericMessage>();
