import { describe, expect, it } from 'bun:test';

import { isLocalNodeHostHeaderAllowed } from '../src/local-node-profile.js';

describe('local node profile', () => {
  describe('isLocalNodeHostHeaderAllowed()', () => {
    it('should accept loopback host headers', () => {
      expect(isLocalNodeHostHeaderAllowed('localhost')).toBe(true);
      expect(isLocalNodeHostHeaderAllowed('localhost:55500')).toBe(true);
      expect(isLocalNodeHostHeaderAllowed('localhost.:55500')).toBe(true);
      expect(isLocalNodeHostHeaderAllowed('127.0.0.1')).toBe(true);
      expect(isLocalNodeHostHeaderAllowed('127.42.0.1:55500')).toBe(true);
      expect(isLocalNodeHostHeaderAllowed('[::1]:55500')).toBe(true);
    });

    it('should reject malformed and non-loopback host headers', () => {
      expect(isLocalNodeHostHeaderAllowed(null)).toBe(false);
      expect(isLocalNodeHostHeaderAllowed('')).toBe(false);
      expect(isLocalNodeHostHeaderAllowed('evil.example')).toBe(false);
      expect(isLocalNodeHostHeaderAllowed('127.0.0.1evil')).toBe(false);
      expect(isLocalNodeHostHeaderAllowed('127.0.0.999')).toBe(false);
      expect(isLocalNodeHostHeaderAllowed('127.0.0.1.evil.example')).toBe(false);
      expect(isLocalNodeHostHeaderAllowed('[::2]:55500')).toBe(false);
    });
  });
});
