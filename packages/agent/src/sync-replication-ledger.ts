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

  // Note: compound keys use raw '^' separator. This is safe because tenantDid
  // (DID URI), remoteEndpoint (URL), and scopeId (base64url hash) cannot
  // contain '^'. If future fields can contain '^', keys must be escaped.

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
   * Advance a frontier after successfully applying a token.
   *
   * **Sparse-position aware:** EventLog positions come from the source's
   * global sequence, not from the filtered result set. A subscription with
   * protocol filters may deliver positions 1, 5, 9 (skipping non-matching
   * events). The frontier tracks delivery order, not position arithmetic —
   * any token with a higher position than the current baseline is a valid
   * forward progression.
   *
   * Out-of-order detection uses delivery sequence, not position gaps.
   * `pendingTokens` accumulates tokens that arrived before earlier-position
   * tokens were applied (true reordering). When pendingTokens exceeds
   * {@link MAX_PENDING_TOKENS}, returns `'overflow'` to signal the caller
   * should transition the link to `repairing`.
   *
   * Returns `'domain_mismatch'` if the token's `streamId` or `epoch` does
   * not match the frontier's existing baseline.
   */
  public static advanceFrontier(
    frontier: DirectionFrontier,
    appliedToken: ProgressToken,
  ): 'ok' | 'overflow' | 'domain_mismatch' {
    // Validate token domain against the frontier baseline.
    if (frontier.contiguousAppliedToken !== undefined) {
      if (appliedToken.streamId !== frontier.contiguousAppliedToken.streamId ||
          appliedToken.epoch !== frontier.contiguousAppliedToken.epoch) {
        return 'domain_mismatch';
      }
    }

    // Update receivedToken to the highest seen.
    if (
      frontier.receivedToken === undefined ||
      ReplicationLedger.comparePosition(appliedToken, frontier.receivedToken) > 0
    ) {
      frontier.receivedToken = appliedToken;
    }

    const appliedPos = BigInt(appliedToken.position);

    if (frontier.contiguousAppliedToken === undefined) {
      // First token ever — set it as the baseline.
      frontier.contiguousAppliedToken = appliedToken;
    } else {
      const baselinePos = BigInt(frontier.contiguousAppliedToken.position);

      if (appliedPos > baselinePos) {
        // Forward progression — advance the baseline.
        // In a filtered stream, positions are sparse (e.g. 1 -> 5 -> 9).
        // Any higher position is valid advancement, not a gap.
        frontier.contiguousAppliedToken = appliedToken;
      }
      // appliedPos <= baselinePos — already applied or duplicate, ignore.
    }

    // Drain any pendingTokens that are now behind or equal to the baseline.
    ReplicationLedger.drainAppliedPending(frontier);

    // Check overflow.
    if (frontier.pendingTokens.length > MAX_PENDING_TOKENS) {
      return 'overflow';
    }

    return 'ok';
  }

  /**
   * Remove pending tokens that are at or behind the current baseline
   * (they have been implicitly applied by the baseline advancing past them).
   */
  private static drainAppliedPending(frontier: DirectionFrontier): void {
    if (frontier.contiguousAppliedToken === undefined) { return; }

    const baseline = BigInt(frontier.contiguousAppliedToken.position);

    // pendingTokens is sorted ascending — remove from the front while <= baseline.
    while (frontier.pendingTokens.length > 0) {
      const nextPos = BigInt(frontier.pendingTokens[0].position);
      if (nextPos <= baseline) {
        frontier.pendingTokens.shift();
      } else {
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
