import type { ActivatePolyfillsOptions, CacheCheckCallback, DrlFetchEvent } from '@enbox/browser';

import { activatePolyfills, fetchResource, handleEvent } from '@enbox/browser';

// A page application must not need the conflicting WebWorker ambient library.
// @ts-expect-error FetchEvent is intentionally unavailable in this DOM-only project
declare const nativeWorkerEvent: FetchEvent;
void nativeWorkerEvent;

const onCacheCheck: CacheCheckCallback = (event, drl) => {
  const url: string = drl;
  void url;
  if ('request' in event) {
    const request: Request = event.request;
    const client: string = event.clientId;
    void request;
    void client;
  }
  return { ttl: 30_000 };
};
const options: ActivatePolyfillsOptions = { onCacheCheck };
activatePolyfills(options);

declare const event: DrlFetchEvent;
const handled: Promise<Response> = handleEvent(event, 'did:example:alice', 'record', options);
const fetched: Promise<Response> = fetchResource(event, 'did:example:alice', 'drl:test', 'record', undefined, options);
void handled;
void fetched;
