import { describe, expect, test } from 'bun:test';

import { AuthManager } from '../src/auth-manager.js';

describe('connect() routing logic', () => {
  test('AuthManager exposes connect() and connectLocal()', () => {
    expect(typeof AuthManager.prototype.connect).toBe('function');
    expect(typeof AuthManager.prototype.connectLocal).toBe('function');
  });

  test('connect() is a separate method from connectLocal()', () => {
    expect(AuthManager.prototype.connect).not.toBe(AuthManager.prototype.connectLocal);
  });
});

describe('_isLocalConnect heuristic (tested via reflection)', () => {
  const isLocalConnect = (AuthManager.prototype as any)._isLocalConnect;

  test('no options → defaults to local connect', () => {
    // Without explicit handler signals, defaults to local.
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

  test('protocols option → handler connect', () => {
    expect(isLocalConnect({ protocols: [] })).toBe(false);
  });

  test('connectHandler option → handler connect', () => {
    const handler = { requestAccess: async (): Promise<undefined> => undefined };
    expect(isLocalConnect({ connectHandler: handler })).toBe(false);
  });

  test('sync-only option → defaults to local connect', () => {
    expect(isLocalConnect({ sync: '15s' })).toBe(true);
  });

  test('protocols + password → handler connect (handler signal wins)', () => {
    expect(isLocalConnect({ protocols: [], password: 'test' })).toBe(false);
  });

  test('connectHandler + createIdentity → handler connect (handler signal wins)', () => {
    const handler = { requestAccess: async (): Promise<undefined> => undefined };
    expect(isLocalConnect({ connectHandler: handler, createIdentity: true })).toBe(false);
  });

  test('protocols + dwnEndpoints + metadata → handler connect (handler signal wins)', () => {
    expect(isLocalConnect({
      protocols    : [],
      dwnEndpoints : ['https://dwn.example.com'],
      metadata     : { name: 'Alice' },
    })).toBe(false);
  });
});
