import type { ReplicationLinkSnapshot } from '@enbox/agent';

import { areReplicationLinksCurrent } from '@enbox/agent';

export type ReplicationCurrentness = 'loading' | 'ready' | 'stale' | 'error';
type ReplicationCurrentnessLink = Pick<ReplicationLinkSnapshot, 'connectivity' | 'isPullCurrent' | 'status'>;

/** Project replication links into the currentness shared by observable API surfaces. */
export function projectReplicationCurrentness(
  links: readonly ReplicationCurrentnessLink[],
  hasBeenReady: boolean,
): ReplicationCurrentness {
  if (links.some((link): boolean => link.status === 'paused')) {
    return 'error';
  }
  if (areReplicationLinksCurrent(links)) {
    return 'ready';
  }
  return hasBeenReady ? 'stale' : 'loading';
}
