import { describe, expect, it } from 'bun:test';

import { activatePolyfills } from '../src/web-features.js';

describe('web features', () => {
  describe('activatePolyfills', () => {
    it('does not throw', () => {
      expect(() => activatePolyfills()).not.toThrow();
    });
  });
});
