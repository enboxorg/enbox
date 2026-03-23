import type { AbstractLevel } from 'abstract-level';
import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { DirectionFrontier, LinkStatus, ReplicationLinkState, SyncScope } from './types/sync.js';

import { computeScopeId, MAX_PENDING_TOKENS } from './types/sync.js';

/** Separator used in compound LevelDB keys. */
const KEY_SEP = '^';

/**
 * Durable replication ledger — persists {@link ReplicationLinkState} for each
 * sync link in a LevelDB sublevel. Provides CRUD operations and frontier
 * progression helpers.
 *
 * Key format: `{tenantDid}^{remoteEndpoint}^{scopeId}`
 *
 * Each link tracks independent pull and push {@link DirectionFrontier}s.
 * The ledger does not own subscriptions or timers — it is a passive state
 * store called by the sync engine.
 */
export class ReplicationLedger {
  private readonly db: AbstractLevel<string | Buffer | Uint8Array>;
  private sublevel;

  constructor(db: AbstractLevel<string | Buffer | Uint8Array>) {
    this.db = db;
    this.sublevel = this.db.sublevel('replicationLinks');
  }

  // ---------------------------------------------------------------------------
  // Key helpers
  // ---------------------------------------------------------------------------

  /** Build the compound key for a link. */
  private static buildKey(tenantDid: string, remoteEndpoint: string, scopeId: string): string {
    return `${tenantDid}${KEY_SEP}${remoteEndpoint}${KEY_SEP}${scopeId}`;
  }

  /** Parse a compound key back into its components. */
  private static parseKey(key: string): { tenantDid: string; remoteEndpoint: string; scopeId: string } {
    const parts = key.split(KEY_SEP);
    return {
      tenantDid      : parts[0],
      remoteEndpoint : parts[1],
      scopeId        : parts[2],
    };
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  /**
   * Get-or-create a link. If the link does not exist, it is created with
   * `initializing` status and empty frontiers.
   */
  public async getOrCreateLink(params: {
    tenantDid : string;
    remoteEndpoint : string;
    scope : SyncScope;
    delegateDid? : string;
    protocol? : string;
  }): Promise<ReplicationLinkState> {
    const scopeId = await computeScopeId(params.scope);
    const key = ReplicationLedger.buildKey(params.tenantDid, params.remoteEndpoint, scopeId);

    try {
      const raw = await this.sublevel.get(key);
      return JSON.parse(raw) as ReplicationLinkState;
    } catch (error) {
      const e = error as { code: string };
      if (e.code !== 'LEVEL_NOT_FOUND') {
        throw error;
      }
    }

    // Create a new link with empty frontiers.
    const link: ReplicationLinkState = {
      tenantDid      : params.tenantDid,
      remoteEndpoint : params.remoteEndpoint,
      scopeId,
      scope          : params.scope,
      status         : 'initializing',
      pull           : { pendingTokens: [] },
      push           : { pendingTokens: [] },
      delegateDid    : params.delegateDid,
      protocol       : params.protocol,
    };

    await this.sublevel.put(key, JSON.stringify(link));
    return link;
  }

  /** Persist the current state of a link. */
  public async saveLink(link: ReplicationLinkState): Promise<void> {
    const key = ReplicationLedger.buildKey(link.tenantDid, link.remoteEndpoint, link.scopeId);
    link.lastActivityAt = new Date().toISOString();
    await this.sublevel.put(key, JSON.stringify(link));
  }

  /** Delete a link. */
  public async deleteLink(tenantDid: string, remoteEndpoint: string, scopeId: string): Promise<void> {
    const key = ReplicationLedger.buildKey(tenantDid, remoteEndpoint, scopeId);
    await this.sublevel.del(key);
  }

  /** List all links for a tenant. */
  public async getLinksForTenant(tenantDid: string): Promise<ReplicationLinkState[]> {
    const prefix = `${tenantDid}${KEY_SEP}`;
    const links: ReplicationLinkState[] = [];
    for await (const [key, value] of this.sublevel.iterator()) {
      if (key.startsWith(prefix)) {
        links.push(JSON.parse(value) as ReplicationLinkState);
      }
    }
    return links;
  }

  /** List all links. */
  public async getAllLinks(): Promise<ReplicationLinkState[]> {
    const links: ReplicationLinkState[] = [];
    for await (const [, value] of this.sublevel.iterator()) {
      links.push(JSON.parse(value) as ReplicationLinkState);
    }
    return links;
  }

  // ---------------------------------------------------------------------------
  // Status transitions
  // ---------------------------------------------------------------------------

  /** Transition a link to a new status and persist. */
  public async setStatus(link: ReplicationLinkState, status: LinkStatus): Promise<void> {
    link.status = status;
    await this.saveLink(link);
  }

  // ---------------------------------------------------------------------------
  // Frontier progression
  // ---------------------------------------------------------------------------

  /**
   * Compare two tokens by position (BigInt numeric comparison).
   * Returns negative if a < b, zero if equal, positive if a > b.
   * Caller must verify streamId and epoch match before calling.
   */
  public static comparePosition(a: ProgressToken, b: ProgressToken): number {
    const diff = BigInt(a.position) - BigInt(b.position);
    if (diff < BigInt(0)) { return -1; }
    if (diff > BigInt(0)) { return 1; }
    return 0;
  }

  /**
   * Advance a frontier after successfully applying a token. Handles both
   * contiguous advancement and out-of-order pending tracking.
   *
   * Returns `'overflow'` if `pendingTokens` exceeds {@link MAX_PENDING_TOKENS},
   * signaling the caller should transition the link to `repairing`.
   */
  public static advanceFrontier(
    frontier: DirectionFrontier,
    appliedToken: ProgressToken,
  ): 'ok' | 'overflow' {
    // Update receivedToken to the highest seen.
    if (
      frontier.receivedToken === undefined ||
      ReplicationLedger.comparePosition(appliedToken, frontier.receivedToken) > 0
    ) {
      frontier.receivedToken = appliedToken;
    }

    if (frontier.contiguousAppliedToken === undefined) {
      // First token ever — set it as the contiguous baseline.
      frontier.contiguousAppliedToken = appliedToken;
    } else {
      const expectedNext = BigInt(frontier.contiguousAppliedToken.position) + BigInt(1);
      const appliedPos = BigInt(appliedToken.position);

      if (appliedPos === expectedNext) {
        // Contiguous: advance the baseline.
        frontier.contiguousAppliedToken = appliedToken;
      } else if (appliedPos > expectedNext) {
        // Out of order: add to pending.
        ReplicationLedger.insertPending(frontier.pendingTokens, appliedToken);
      }
      // appliedPos <= contiguousAppliedToken.position — already applied, ignore.
    }

    // Drain any pendingTokens that are now contiguous with the baseline.
    ReplicationLedger.drainContiguousPending(frontier);

    // Check overflow.
    if (frontier.pendingTokens.length > MAX_PENDING_TOKENS) {
      return 'overflow';
    }

    return 'ok';
  }

  /**
   * Insert a token into the pending list in ascending position order.
   * Skips if already present (by position + messageCid).
   */
  private static insertPending(pending: ProgressToken[], token: ProgressToken): void {
    const pos = BigInt(token.position);

    // Find insertion point (binary search).
    let lo = 0;
    let hi = pending.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (BigInt(pending[mid].position) < pos) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    // Check for duplicate.
    if (lo < pending.length && pending[lo].position === token.position && pending[lo].messageCid === token.messageCid) {
      return;
    }

    pending.splice(lo, 0, token);
  }

  /**
   * Drain pending tokens that are contiguous with `contiguousAppliedToken`,
   * advancing the baseline as far as possible.
   */
  private static drainContiguousPending(frontier: DirectionFrontier): void {
    if (frontier.contiguousAppliedToken === undefined) { return; }

    let baseline = BigInt(frontier.contiguousAppliedToken.position);

    while (frontier.pendingTokens.length > 0) {
      const next = frontier.pendingTokens[0];
      const nextPos = BigInt(next.position);

      if (nextPos === baseline + BigInt(1)) {
        // Contiguous — advance.
        frontier.contiguousAppliedToken = next;
        frontier.pendingTokens.shift();
        baseline = nextPos;
      } else {
        // Gap — stop draining.
        break;
      }
    }
  }

  /**
   * Reset a frontier (e.g., after repair). Sets the contiguous token and
   * clears pending.
   */
  public static resetFrontier(frontier: DirectionFrontier, token?: ProgressToken): void {
    frontier.contiguousAppliedToken = token;
    frontier.receivedToken = token;
    frontier.pendingTokens = [];
  }
}
