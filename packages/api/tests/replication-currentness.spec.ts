import { describe, expect, it } from 'bun:test';

import { projectReplicationCurrentness } from '../src/replication-currentness.js';

const CurrentLink = { status: 'live', connectivity: 'online', isPullCurrent: true } as const;

describe('projectReplicationCurrentness()', () => {
  it('should require at least one current link and preserve ready history when unavailable', () => {
    for (const [links, hasBeenReady, expected] of [
      [[], false, 'loading'],
      [[CurrentLink], false, 'ready'],
      [[{ ...CurrentLink, isPullCurrent: false }], true, 'stale'],
      [[{ ...CurrentLink, status: 'paused' }], true, 'error'],
    ] as const) {
      expect(projectReplicationCurrentness(links, hasBeenReady)).toBe(expected);
    }
  });
});
