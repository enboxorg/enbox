import type { CacheCheckCallback, DrlFetchEvent } from '../../dist/types/web-features.js';

declare const native: FetchEvent;
declare const portable: DrlFetchEvent;

// Preserve compatibility in both directions without importing DOM ambient globals.
const fromNative: DrlFetchEvent = native;
const toNative: FetchEvent = portable;
void fromNative;
void toNative;

const callback: CacheCheckCallback = (event) => {
  if ('request' in event) {
    event.waitUntil(Promise.resolve());
    const response: Promise<Response | undefined> = event.preloadResponse;
    void response;
  }
  return undefined;
};
callback(native, 'drl:test');
