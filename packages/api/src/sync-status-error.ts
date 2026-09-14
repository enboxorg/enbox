import type { ReplicationLinkSnapshot } from '@enbox/agent';

/** Select the newest durable recovery failure among paused replication links. */
export function latestPausedRecoveryLink(
  links: readonly ReplicationLinkSnapshot[],
): ReplicationLinkSnapshot | undefined {
  let latest: ReplicationLinkSnapshot | undefined;
  for (const link of links) {
    if (link.status !== 'paused' || link.recovery === undefined) {
      continue;
    }
    if (latest?.recovery === undefined || link.recovery.failedAt > latest.recovery.failedAt) {
      latest = link;
    }
  }
  return latest;
}
