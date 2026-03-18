import { describe, expect, test } from 'bun:test';

import { AuthManager } from '../src/auth-manager.js';

describe('connect() routing logic', () => {
  // We test the private _isLocalConnect method indirectly via the AuthManager class.
  // Since we can't easily mock the browser environment in bun:test, we test
  // the routing heuristics by checking the type-level behavior.

  test('AuthManager exposes connect() and connectLocal()', () => {
    // Verify the public API shape.
    expect(typeof AuthManager.prototype.connect).toBe('function');
    expect(typeof AuthManager.prototype.connectLocal).toBe('function');
  });

  test('connect() is a separate method from connectLocal()', () => {
    // They should be different functions.
    expect(AuthManager.prototype.connect).not.toBe(AuthManager.prototype.connectLocal);
  });
});

describe('_isLocalConnect heuristic (tested via reflection)', () => {
  // We access the private method via prototype to test the routing logic.
  // This is intentionally testing internals for correctness.
  const isLocalConnect = (AuthManager.prototype as any)._isLocalConnect;

  test('no options in non-browser → local connect', () => {
    // In bun test runner, globalThis.window is undefined.
    expect(isLocalConnect(undefined)).toBe(true);
    expect(isLocalConnect({})).toBe(true);
  });

  test('password option → local connect', () => {
    expect(isLocalConnect({ password: 'test' })).toBe(true);
  });

  test('createIdentity option → local connect', () => {
    expect(isLocalConnect({ createIdentity: true })).toBe(true);
  });

  test('recoveryPhrase option → local connect', () => {
    expect(isLocalConnect({ recoveryPhrase: 'word1 word2' })).toBe(true);
  });

  test('dwnEndpoints option → local connect', () => {
    expect(isLocalConnect({ dwnEndpoints: ['https://dwn.example.com'] })).toBe(true);
  });

  test('metadata option → local connect', () => {
    expect(isLocalConnect({ metadata: { name: 'Alice' } })).toBe(true);
  });

  test('protocols option → NOT local connect (DWeb Connect)', () => {
    // protocols is a DWeb Connect signal, not a local connect signal.
    expect(isLocalConnect({ protocols: [] })).toBe(false);
  });

  test('walletUrl option → NOT local connect (DWeb Connect)', () => {
    expect(isLocalConnect({ walletUrl: 'https://wallet.example.com' })).toBe(false);
  });

  test('sync-only option in non-browser → falls back to local connect', () => {
    // sync is shared between flows. In non-browser (bun test), falls back to local.
    expect(isLocalConnect({ sync: '15s' })).toBe(true);
  });
});
