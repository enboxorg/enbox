import type { ConnectionStatusGrant } from '../src/connect-status.js';

import { describe, expect, test } from 'bun:test';

import { computeConnectionStatus, reconcileConnectionStatusGrants } from '../src/connect-status.js';

const OWNER_DID = 'did:dht:owner';
const DELEGATE_DID = 'did:dht:delegate';
const NOW = '2026-07-13T12:00:00.000000Z';

function createGrant(overrides: Partial<ConnectionStatusGrant> = {}): ConnectionStatusGrant {
  return {
    id             : 'grant-1',
    grantor        : OWNER_DID,
    grantee        : DELEGATE_DID,
    dateExpires    : '2026-07-13T14:00:00.000000Z',
    connectSession : {
      id        : 'session-1',
      createdAt : '2026-07-13T10:00:00.000000Z',
      expiresAt : '2026-07-13T14:00:00.000000Z',
    },
    ...overrides,
  };
}

describe('delegated connection status', () => {
  test('returns none when no grant has connect-session metadata', () => {
    const grant = createGrant({ connectSession: undefined });

    expect(computeConnectionStatus([grant], { now: NOW })).toEqual({ state: 'none' });
  });

  test('selects the session with the latest createdAt rather than the latest expiry', () => {
    const olderLongSession = createGrant({
      id             : 'older-grant',
      dateExpires    : '2026-08-01T00:00:00.000000Z',
      connectSession : {
        id        : 'older-session',
        createdAt : '2026-07-10T00:00:00.000000Z',
        expiresAt : '2026-08-01T00:00:00.000000Z',
      },
    });
    const newerSession = createGrant({
      id             : 'newer-grant',
      dateExpires    : '2026-07-13T13:00:00.000000Z',
      connectSession : {
        id        : 'newer-session',
        createdAt : '2026-07-13T11:00:00.000000Z',
        expiresAt : '2026-07-13T13:00:00.000000Z',
      },
    });

    const status = computeConnectionStatus([olderLongSession, newerSession], {
      now                          : NOW,
      expiringSoonThresholdSeconds : 3600,
    });

    expect(status.connectSessionId).toBe('newer-session');
    expect(status.state).toBe('expiring-soon');
  });

  test('uses the earliest enforcing grant expiry and honors state boundaries', () => {
    const first = createGrant({
      id          : 'grant-later',
      dateExpires : '2026-07-13T14:00:00.000000Z',
    });
    const second = createGrant({
      id          : 'grant-earlier',
      dateExpires : '2026-07-13T13:00:00.000000Z',
    });

    const expiring = computeConnectionStatus([first, second], {
      now                          : NOW,
      expiringSoonThresholdSeconds : 3600,
    });
    const active = computeConnectionStatus([first, second], {
      now                          : NOW,
      expiringSoonThresholdSeconds : 3599,
    });
    const expired = computeConnectionStatus([first, second], {
      now: '2026-07-13T13:00:00.000000Z',
    });

    expect(expiring).toMatchObject({
      state              : 'expiring-soon',
      connectedDid       : OWNER_DID,
      delegateDid        : DELEGATE_DID,
      expiresAt          : '2026-07-13T13:00:00.000000Z',
      secondsUntilExpiry : 3600,
    });
    expect(active.state).toBe('active');
    expect(expired).toMatchObject({ state: 'expired', secondsUntilExpiry: 0 });
  });

  test('reports revoked ahead of expiry state', () => {
    const status = computeConnectionStatus([createGrant({ revoked: true })], { now: NOW });

    expect(status.state).toBe('revoked');
  });

  test('uses a proportional warning window for one-hour approvals by default', () => {
    const oneHourGrant = createGrant({
      dateExpires    : '2026-07-13T13:00:00.000000Z',
      connectSession : {
        id        : 'one-hour-session',
        createdAt : NOW,
        expiresAt : '2026-07-13T13:00:00.000000Z',
      },
    });

    expect(computeConnectionStatus([oneHourGrant], { now: NOW }).state).toBe('active');
    expect(computeConnectionStatus([oneHourGrant], {
      now: '2026-07-13T12:54:00.000000Z',
    }).state).toBe('expiring-soon');
  });

  test('caps the default warning window at one hour for long approvals', () => {
    const thirtyDayGrant = createGrant({
      dateExpires    : '2026-08-12T12:00:00.000000Z',
      connectSession : {
        id        : 'thirty-day-session',
        createdAt : NOW,
        expiresAt : '2026-08-12T12:00:00.000000Z',
      },
    });

    expect(computeConnectionStatus([thirtyDayGrant], {
      now: '2026-08-12T10:59:59.000000Z',
    }).state).toBe('active');
    expect(computeConnectionStatus([thirtyDayGrant], {
      now: '2026-08-12T11:00:00.000000Z',
    }).state).toBe('expiring-soon');
  });

  test('validates status thresholds and timestamps', () => {
    expect(() => computeConnectionStatus([], { expiringSoonThresholdSeconds: -1 })).toThrow(RangeError);
    expect(() => computeConnectionStatus([], { now: 'not-a-timestamp' })).toThrow(RangeError);
    expect(() => computeConnectionStatus([
      createGrant({ dateExpires: 'not-a-timestamp' }),
    ], { now: NOW })).toThrow(RangeError);
  });
});

describe('connection status partition reconciliation', () => {
  const olderComplete = createGrant({
    id             : 'older-grant',
    connectSession : {
      id        : 'older-session',
      createdAt : '2026-07-12T10:00:00.000000Z',
      expiresAt : '2026-07-14T10:00:00.000000Z',
    },
  });
  const newerOwnerOnly = createGrant({
    id             : 'newer-grant',
    connectSession : {
      id        : 'newer-session',
      createdAt : '2026-07-13T10:00:00.000000Z',
      expiresAt : '2026-07-15T10:00:00.000000Z',
    },
  });

  test('falls back to an older complete session when a newer session exists only in the owner partition', () => {
    const reconciled = reconcileConnectionStatusGrants({
      ownerGrants         : [olderComplete, newerOwnerOnly],
      delegateGrants      : [olderComplete],
      activeOwnerGrantIds : new Set(['older-grant', 'newer-grant']),
    });

    const status = computeConnectionStatus(reconciled, { now: NOW });
    expect(status.connectSessionId).toBe('older-session');
  });

  test('returns none when the only owner session is absent from the delegate partition', () => {
    const reconciled = reconcileConnectionStatusGrants({
      ownerGrants         : [newerOwnerOnly],
      delegateGrants      : [],
      activeOwnerGrantIds : new Set(['newer-grant']),
    });

    expect(computeConnectionStatus(reconciled, { now: NOW })).toEqual({ state: 'none' });
  });

  test('excludes a session when the delegate partition is missing one grant from its complete set', () => {
    const secondOwnerGrant = createGrant({
      id             : 'newer-grant-2',
      connectSession : newerOwnerOnly.connectSession,
    });
    const reconciled = reconcileConnectionStatusGrants({
      ownerGrants         : [olderComplete, newerOwnerOnly, secondOwnerGrant],
      delegateGrants      : [olderComplete, { ...newerOwnerOnly }],
      activeOwnerGrantIds : new Set(['older-grant', 'newer-grant', 'newer-grant-2']),
    });

    const status = computeConnectionStatus(reconciled, { now: NOW });
    expect(status.connectSessionId).toBe('older-session');
  });

  test('selects a newer session once its complete grant-ID set exists in both partitions', () => {
    const reconciled = reconcileConnectionStatusGrants({
      ownerGrants         : [olderComplete, newerOwnerOnly],
      delegateGrants      : [olderComplete, { ...newerOwnerOnly }],
      activeOwnerGrantIds : new Set(['older-grant', 'newer-grant']),
    });

    const status = computeConnectionStatus(reconciled, { now: NOW });
    expect(status.connectSessionId).toBe('newer-session');
  });
});
