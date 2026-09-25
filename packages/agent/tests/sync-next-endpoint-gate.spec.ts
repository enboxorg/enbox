import sinon from 'sinon';
import { SocketUnavailableError } from '@enbox/dwn-clients';
import { describe, expect, it } from 'bun:test';

import {
  SyncNextEndpointBackoffError,
  SyncNextEndpointGate,
} from '../src/sync-next/endpoint-gate.js';

describe('SyncNextEndpointGate', () => {
  it('should bound one endpoint while allowing another endpoint to proceed', async () => {
    const gate = new SyncNextEndpointGate(2);
    let activeShared = 0;
    let maxShared = 0;
    let independentRan = false;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const shared = Array.from({ length: 4 }, () => gate.run('https://shared.example', async (): Promise<void> => {
      activeShared++;
      maxShared = Math.max(maxShared, activeShared);
      await blocked;
      activeShared--;
    }));
    const independent = gate.run('https://independent.example', async (): Promise<void> => {
      independentRan = true;
    });

    await independent;
    expect(independentRan).toBe(true);
    expect(maxShared).toBe(2);
    release();
    await Promise.all(shared);
  });

  it('should turn one connection failure into a bounded circuit instead of a queued wave', async () => {
    const clock = sinon.useFakeTimers({ now: Date.parse('2026-09-22T12:00:00.000Z') });
    const gate = new SyncNextEndpointGate(1);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let queuedRan = false;
    const first = gate.run('https://offline.example', async (): Promise<void> => {
      await blocked;
      throw new SocketUnavailableError('offline');
    });
    const queued = gate.run('https://offline.example', async (): Promise<void> => {
      queuedRan = true;
    });

    const outcomes = Promise.allSettled([first, queued]);
    release();
    const [firstOutcome, queuedOutcome] = await outcomes;
    expect(firstOutcome).toMatchObject({ status: 'rejected' });
    expect((firstOutcome as PromiseRejectedResult).reason).toBeInstanceOf(SocketUnavailableError);
    expect(queuedOutcome).toMatchObject({ status: 'rejected' });
    expect((queuedOutcome as PromiseRejectedResult).reason).toBeInstanceOf(SyncNextEndpointBackoffError);
    expect(queuedRan).toBe(false);

    await clock.tickAsync(5_000);
    await gate.run('https://offline.example', async (): Promise<void> => { queuedRan = true; });
    expect(queuedRan).toBe(true);
    clock.restore();
  });
});
