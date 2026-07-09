import { describe, expect, it } from 'bun:test';

import { LocalNodePairingManager } from '../src/local-node-pairing.js';

describe('LocalNodePairingManager', () => {
  it('should coalesce pending requests and return an approved token once', () => {
    const manager = new LocalNodePairingManager();

    const firstCreate = manager.createRequest('https://app.example');
    expect(firstCreate.status).toBe('created');
    if (firstCreate.status !== 'created') {
      throw new Error('expected created pairing request');
    }

    const secondCreate = manager.createRequest('https://app.example');
    expect(secondCreate.status).toBe('coalesced');
    expect(secondCreate.requestId).toBe(firstCreate.requestId);

    expect(manager.approveRequest(firstCreate.requestId)).toBe(true);

    const firstPoll = manager.pollRequest(firstCreate.requestId);
    expect(firstPoll?.status).toBe('approved');
    if (firstPoll?.status !== 'approved') {
      throw new Error('expected approved pairing request');
    }

    expect(typeof firstPoll.token).toBe('string');
    expect(manager.validateSession('https://app.example', firstPoll.token)).toBe(true);
    expect(manager.validateSession('https://other.example', firstPoll.token)).toBe(false);

    const secondPoll = manager.pollRequest(firstCreate.requestId);
    expect(secondPoll).toEqual({ origin: 'https://app.example', status: 'approved' });
  });

  it('should reject missing and non-http origins', () => {
    const manager = new LocalNodePairingManager();

    expect(manager.createRequest(null)).toEqual({
      message : 'Origin header is required.',
      status  : 'invalid-origin',
    });
    expect(manager.createRequest('chrome-extension://abc')).toEqual({
      message : 'Origin header must be an http(s) origin.',
      status  : 'invalid-origin',
    });
    expect(manager.createRequest('https://app.example/path')).toEqual({
      message : 'Origin header must be an http(s) origin.',
      status  : 'invalid-origin',
    });
  });

  it('should expire pending requests', () => {
    let now = 1_000;
    const manager = new LocalNodePairingManager({
      now                 : (): number => now,
      pairingRequestTtlMs : 100,
    });

    const created = manager.createRequest('https://app.example');
    expect(created.status).toBe('created');
    if (created.status !== 'created') {
      throw new Error('expected created pairing request');
    }

    now += 101;
    expect(manager.approveRequest(created.requestId)).toBe(false);
    expect(manager.pollRequest(created.requestId)).toEqual({
      origin : 'https://app.example',
      status : 'expired',
    });
  });

  it('should rate limit new pairing requests per origin', () => {
    const manager = new LocalNodePairingManager({
      pairingRateLimitMax      : 1,
      pairingRateLimitWindowMs : 60_000,
    });

    const created = manager.createRequest('https://app.example');
    expect(created.status).toBe('created');
    if (created.status !== 'created') {
      throw new Error('expected created pairing request');
    }

    expect(manager.denyRequest(created.requestId)).toBe(true);

    const rateLimited = manager.createRequest('https://app.example');
    expect(rateLimited.status).toBe('rate-limited');
  });

  it('should validate no-Origin sessions only for no-Origin requests', () => {
    const manager = new LocalNodePairingManager();
    const token = manager.createSession(undefined);

    expect(manager.validateSession(undefined, token)).toBe(true);
    expect(manager.validateSession('https://app.example', token)).toBe(false);
  });

  it('should export, import, and revoke sessions', () => {
    const manager = new LocalNodePairingManager({ now: (): number => 1234 });
    const browserToken = manager.createSession('https://app.example');
    const localToken = manager.createSession(undefined);

    const restoredManager = new LocalNodePairingManager();
    restoredManager.importSessions(manager.exportSessions());

    expect(restoredManager.validateSession('https://app.example', browserToken)).toBe(true);
    expect(restoredManager.validateSession(undefined, localToken)).toBe(true);
    expect(restoredManager.revokeToken(browserToken)).toBe(true);
    expect(restoredManager.validateSession('https://app.example', browserToken)).toBe(false);
  });

  it('should notify session listeners after approvals and revocations', () => {
    const manager = new LocalNodePairingManager({ now: (): number => 1234 });
    const sessionSnapshots: string[][] = [];
    const unsubscribe = manager.onSessionsChanged((sessions): void => {
      sessionSnapshots.push(sessions.map((session): string => session.token));
    });
    const created = manager.createRequest('https://app.example');
    if (created.status !== 'created') {
      throw new Error('expected created pairing request');
    }

    expect(manager.approveRequest(created.requestId)).toBe(true);
    const approved = manager.pollRequest(created.requestId);
    if (approved?.status !== 'approved' || approved.token === undefined) {
      throw new Error('expected approved pairing token');
    }

    expect(sessionSnapshots).toEqual([[approved.token]]);
    expect(manager.revokeToken(approved.token)).toBe(true);
    expect(sessionSnapshots).toEqual([[approved.token], []]);

    unsubscribe();
    manager.createSession('https://other.example');
    expect(sessionSnapshots).toHaveLength(2);
  });
});
