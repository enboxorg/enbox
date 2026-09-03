import { describe, expect, it } from 'bun:test';

import { isExplicitlyOffline } from '../src/network.js';

describe('isExplicitlyOffline', () => {
  it('returns true only when the browser explicitly reports offline', () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

    try {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
      expect(isExplicitlyOffline()).toBe(false);

      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
      expect(isExplicitlyOffline()).toBe(false);

      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
      expect(isExplicitlyOffline()).toBe(true);
    } finally {
      if (originalNavigator === undefined) {
        Reflect.deleteProperty(globalThis, 'navigator');
      } else {
        Object.defineProperty(globalThis, 'navigator', originalNavigator);
      }
    }
  });
});
