import type { ReplicationLinkSnapshot } from '@enbox/agent';

/** Select one exact replication link whose authorization is durably paused. */
export function pausedReplicationLink(
  links: readonly ReplicationLinkSnapshot[],
): ReplicationLinkSnapshot | undefined {
  for (const link of links) {
    if (link.status === 'paused') {
      return link;
    }
  }
}
