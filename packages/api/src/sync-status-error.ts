import type { ReplicationLinkSnapshot } from '@enbox/agent';

/** Select one paused replication link for user-facing context. */
export function pausedReplicationLink(
  links: readonly ReplicationLinkSnapshot[],
): ReplicationLinkSnapshot | undefined {
  return links.find(link => link.status === 'paused');
}
