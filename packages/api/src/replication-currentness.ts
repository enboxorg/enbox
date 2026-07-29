import type { ReplicationLinkSnapshot } from '@enbox/agent';

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
  if (links.length > 0 && links.every((link): boolean =>
    link.status === 'live' && link.connectivity === 'online' && link.isPullCurrent)) {
    return 'ready';
  }
  return hasBeenReady ? 'stale' : 'loading';
}
