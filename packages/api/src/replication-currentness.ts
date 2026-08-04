import type { ReplicationLinkSnapshot } from '@enbox/agent';

import { areReplicationLinksCurrent } from '@enbox/agent';

/** Whether replication is still advancing, caught up, or unable to continue. */
export type ReplicationCurrentness = 'syncing' | 'caught-up' | 'error';
type ReplicationCurrentnessLink = Pick<ReplicationLinkSnapshot, 'connectivity' | 'isPullCurrent' | 'status'>;

/** Project replication links into the currentness shared by observable API surfaces. */
export function projectReplicationCurrentness(
  links: readonly ReplicationCurrentnessLink[],
): ReplicationCurrentness {
  if (links.some((link): boolean => link.status === 'paused')) {
    return 'error';
  }
  if (areReplicationLinksCurrent(links)) {
    return 'caught-up';
  }
  return 'syncing';
}
