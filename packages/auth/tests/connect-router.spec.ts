import { describe, expect, test } from 'bun:test';

import { AuthManager } from '../src/auth-manager.js';

describe('connect() routing logic', () => {
  test('AuthManager exposes connect() and connectVault()', () => {
    expect(typeof AuthManager.prototype.connect).toBe('function');
    expect(typeof AuthManager.prototype.connectVault).toBe('function');
  });

  test('connect() is a separate method from connectVault()', () => {
    expect(AuthManager.prototype.connect).not.toBe(AuthManager.prototype.connectVault);
  });
});

describe('_isVaultConnect heuristic (tested via reflection)', () => {
  const isVaultConnect = (AuthManager.prototype as any)._isVaultConnect;

  test('no options → defaults to vault connect', () => {
    expect(isVaultConnect(undefined)).toBe(true);
    expect(isVaultConnect({})).toBe(true);
  });

  test('password option → vault connect', () => {
    expect(isVaultConnect({ password: 'test' })).toBe(true);
  });

  test('createIdentity option → vault connect', () => {
    expect(isVaultConnect({ createIdentity: true })).toBe(true);
  });

  test('dwnEndpoints option → vault connect', () => {
    expect(isVaultConnect({ dwnEndpoints: ['https://dwn.example.com'] })).toBe(true);
  });

  test('metadata option → vault connect', () => {
    expect(isVaultConnect({ metadata: { name: 'Alice' } })).toBe(true);
  });

  test('non-empty modules option → handler connect', () => {
    expect(isVaultConnect({ modules: [{ module: 'x', published: true, types: {}, structure: {} } as any] })).toBe(false);
  });

  test('empty modules array → vault connect (no scopes for handler to authorize)', () => {
    // An empty array carries no permission intent; treating it as a handler
    // signal would produce a zero-grant "connected" session that's
    // indistinguishable from a denied connect.
    expect(isVaultConnect({ modules: [] })).toBe(true);
  });

  test('connectHandler option → handler connect', () => {
    const handler = { requestAccess: async (): Promise<undefined> => undefined };
    expect(isVaultConnect({ connectHandler: handler })).toBe(false);
  });

  test('sync-only option → defaults to vault connect', () => {
    expect(isVaultConnect({ sync: '15s' })).toBe(true);
  });

  test('non-empty modules + password → handler connect (handler signal wins)', () => {
    const proto = { module: 'x', published: true, types: {}, structure: {} } as any;
    expect(isVaultConnect({ modules: [proto], password: 'test' })).toBe(false);
  });

  test('connectHandler + createIdentity → handler connect (handler signal wins)', () => {
    const handler = { requestAccess: async (): Promise<undefined> => undefined };
    expect(isVaultConnect({ connectHandler: handler, createIdentity: true })).toBe(false);
  });

  test('non-empty modules + dwnEndpoints + metadata → handler connect (handler signal wins)', () => {
    const proto = { module: 'x', published: true, types: {}, structure: {} } as any;
    expect(isVaultConnect({
      modules      : [proto],
      dwnEndpoints : ['https://dwn.example.com'],
      metadata     : { name: 'Alice' },
    })).toBe(false);
  });

  test('modules: null is treated as no handler signal → vault connect', () => {
    expect(isVaultConnect({ modules: null as any })).toBe(true);
  });

  test('connectHandler: null → vault connect', () => {
    expect(isVaultConnect({ connectHandler: null as any })).toBe(true);
  });
});
