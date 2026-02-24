import type { DidResolutionResult } from '../types/did-core.js';
import type { DidResolverCache } from '../types/did-resolution.js';

/**
 * No-op cache that is used as the default cache for did-resolver.
 *
 * The motivation behind using a no-op cache as the default stems from the desire to maximize the
 * potential for this library to be used in as many JS runtimes as possible.
 */
export const DidResolverCacheNoop: DidResolverCache = {
  open(): Promise<void> {
    return Promise.resolve();
  },
  get(_key: string): Promise<DidResolutionResult | void> {
    return Promise.resolve(undefined);
  },
  set(_key: string, _value: DidResolutionResult): Promise<void> {
    return Promise.resolve();
  },
  delete(_key: string): Promise<boolean | void> {
    return Promise.resolve();
  },
  clear(): Promise<void> {
    return Promise.resolve();
  },
  close(): Promise<void> {
    return Promise.resolve();
  }
};