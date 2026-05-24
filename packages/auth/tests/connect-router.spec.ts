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

  test('non-empty protocols option → handler connect', () => {
    expect(isLocalConnect({ protocols: [{ protocol: 'x', published: true, types: {}, structure: {} } as any] })).toBe(false);
  });

  test('empty protocols array → local connect (no scopes for handler to authorize)', () => {
    // An empty array carries no permission intent; treating it as a handler
    // signal would produce a zero-grant "connected" session that's
    // indistinguishable from a denied connect.
    expect(isLocalConnect({ protocols: [] })).toBe(true);
  });

  test('connectHandler option → handler connect', () => {
    const handler = { requestAccess: async (): Promise<undefined> => undefined };
    expect(isLocalConnect({ connectHandler: handler })).toBe(false);
  });

  test('sync-only option → defaults to local connect', () => {
    expect(isLocalConnect({ sync: '15s' })).toBe(true);
  });

  test('non-empty protocols + password → handler connect (handler signal wins)', () => {
    const proto = { protocol: 'x', published: true, types: {}, structure: {} } as any;
    expect(isLocalConnect({ protocols: [proto], password: 'test' })).toBe(false);
  });

  test('connectHandler + createIdentity → handler connect (handler signal wins)', () => {
    const handler = { requestAccess: async (): Promise<undefined> => undefined };
    expect(isLocalConnect({ connectHandler: handler, createIdentity: true })).toBe(false);
  });

  test('non-empty protocols + dwnEndpoints + metadata → handler connect (handler signal wins)', () => {
    const proto = { protocol: 'x', published: true, types: {}, structure: {} } as any;
    expect(isLocalConnect({
      protocols    : [proto],
      dwnEndpoints : ['https://dwn.example.com'],
      metadata     : { name: 'Alice' },
    })).toBe(false);
  });

  test('protocols: null is treated as no handler signal → local connect', () => {
    // Defensive: a caller using JS may pass null. `'protocols' in options &&
    // options.protocols !== undefined` would be true for null, but
    // null.length throws — guarding via length > 0 also covers this.
    expect(isLocalConnect({ protocols: null as any })).toBe(true);
  });

  test('connectHandler: null → local connect', () => {
    // The `!== undefined` predicate intentionally tolerates explicit-null
    // handler. A null handler is not actionable, so route to local.
    expect(isLocalConnect({ connectHandler: null as any })).toBe(true);
  });
});
