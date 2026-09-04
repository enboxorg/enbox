import type { DidResolutionResult } from '../types/did-core.js';

import { parseDurationInMilliseconds } from '@enbox/common';

export const DEFAULT_DID_CACHE_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_DID_CACHE_MAX_IDLE = '90d';
export const DEFAULT_DID_CACHE_TOUCH_INTERVAL = '1h';
export const DEFAULT_DID_CACHE_TTL = '15m';

export type CachedDidResolutionResult = {
  pinned?: boolean;
  ttlMillis: number;
  value: DidResolutionResult;
};

const textEncoder = new TextEncoder();

export function assertMaxBytes(maxBytes: number): void {
  if (maxBytes !== Infinity && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
    throw new TypeError('maxBytes must be a positive safe integer or Infinity');
  }
}

export function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export function isFresh(entry: CachedDidResolutionResult, currentTime = Date.now()): boolean {
  return currentTime < entry.ttlMillis;
}

export function parsePositiveDuration(duration: string, name: string): number {
  const milliseconds = parseDurationInMilliseconds(duration);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new TypeError(`${name} must resolve to a positive whole number of milliseconds`);
  }
  return milliseconds;
}
