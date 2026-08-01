import type { FollowedSyncSource, SyncEvent } from '@enbox/agent';

type FollowedContextChange = Extract<SyncEvent, { type: 'followed-context:change' }>;

/** Whether a catalog transition permanently retires one followed-source acceptance. */
export function followedContextChangeRetiresSource(
  source: Pick<FollowedSyncSource, 'acceptanceId' | 'id'>,
  event: FollowedContextChange,
): boolean {
  return event.followedSourceId === undefined
    ? event.followedSourceAcceptanceId === source.acceptanceId
    : event.followedSourceId !== source.id || event.followedSourceAcceptanceId !== source.acceptanceId;
}
