import { describe, expect, it } from 'bun:test';

import { projectReplicationCurrentness } from '../src/replication-currentness.js';

const CurrentLink = { status: 'live', connectivity: 'online', isPullCurrent: true } as const;

describe('projectReplicationCurrentness()', () => {
  it('should require at least one current link', () => {
    for (const [links, expected] of [
      [[], 'syncing'],
      [[CurrentLink], 'caught-up'],
      [[CurrentLink, { ...CurrentLink, isPullCurrent: false }], 'syncing'],
      [[{ ...CurrentLink, connectivity: 'offline' }], 'syncing'],
      [[{ ...CurrentLink, status: 'initializing' }], 'syncing'],
      [[{ ...CurrentLink, status: 'paused' }], 'error'],
    ] as const) {
      expect(projectReplicationCurrentness(links)).toBe(expected);
    }
  });
});
