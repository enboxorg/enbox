import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { SyncNextLinkIdentity, SyncNextSourceReceipt } from './types.js';

const KEY_END = '\uffff';

/** Encode one arbitrary string as an unambiguous compound-key part. */
function encodePart(value: string): string {
  return `${value.length}:${value}`;
}

/** Durable key for one exact next-engine link. */
export function syncNextLinkKey(identity: SyncNextLinkIdentity): string {
  return [
    identity.tenantDid,
    identity.remoteEndpoint,
    identity.projectionId,
    identity.authorizationEpoch,
  ].map(encodePart).join('');
}

/** Prefix range containing every exact-source row for one link. */
export function syncNextLinkRange(identity: SyncNextLinkIdentity): { gte: string; lte: string } {
  const prefix = syncNextLinkKey(identity);
  return { gte: prefix, lte: `${prefix}${KEY_END}` };
}

/** Prefix range containing every next-engine link for one tenant. */
export function syncNextTenantRange(tenantDid: string): { gte: string; lte: string } {
  const prefix = encodePart(tenantDid);
  return { gte: prefix, lte: `${prefix}${KEY_END}` };
}

/** Durable key for one exact source receipt beneath its link. */
export function syncNextReceiptKey(
  identity: SyncNextLinkIdentity,
  receipt: SyncNextSourceReceipt,
): string {
  return `${syncNextLinkKey(identity)}${[
    receipt.source.streamId,
    receipt.source.epoch,
    receipt.source.position,
    receipt.messageCid,
  ].map(encodePart).join('')}`;
}

/** Durable key for one terminal outcome, additionally isolated by direction. */
export function syncNextTerminalKey(
  identity: SyncNextLinkIdentity,
  direction: 'pull' | 'push',
  receipt: SyncNextSourceReceipt,
): string {
  return `${syncNextLinkKey(identity)}${encodePart(direction)}${[
    receipt.source.streamId,
    receipt.source.epoch,
    receipt.source.position,
    receipt.messageCid,
  ].map(encodePart).join('')}`;
}

/** Whether a progress token is safe for exact integer/domain comparison. */
export function isValidSyncNextToken(token: ProgressToken): boolean {
  return token.streamId.length > 0 &&
    token.epoch.length > 0 &&
    /^(0|[1-9]\d*)$/.test(token.position);
}

/** Compare two positions after the caller has validated their token domains. */
export function compareSyncNextPosition(a: ProgressToken, b: ProgressToken): number {
  const difference = BigInt(a.position) - BigInt(b.position);
  return difference < BigInt(0) ? -1 : difference > BigInt(0) ? 1 : 0;
}
