import type { AbstractLevel } from 'abstract-level';
import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { DirectionCheckpoint, LinkStatus, ReplicationLinkState, SyncScope } from './types/sync.js';

import { computeScopeId } from './types/sync.js';

/** Separator used in compound LevelDB keys. */
const KEY_SEP = '^';

/**
 * Durable replication ledger — persists {@link ReplicationLinkState} for each
 * sync link in a LevelDB sublevel. Provides CRUD operations and replication
 * checkpoint helpers.
 *
 * Key format: `{tenantDid}^{remoteEndpoint}^{scopeId}`
 *
 * Each link tracks independent pull and push {@link DirectionCheckpoint}s.
 * The ledger does not own subscriptions or timers — it is a passive state
 * store called by the sync engine.
 */
export class ReplicationLedger {
  private readonly db: AbstractLevel<string | Buffer | Uint8Array>;
  private readonly sublevel;

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
   * `initializing` status and empty checkpoints.
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
      const link = JSON.parse(raw) as ReplicationLinkState;
      delete (link as any).push; // strip legacy push field from old persisted links
      // connectivity is runtime state — always reset to 'unknown' on load
      // so stale 'online' from a previous session doesn't give false positives.
      link.connectivity = 'unknown';

      // Update delegateDid if it changed (e.g. via updateIdentityOptions).
      // Without this, repair/reconcile would keep using the old delegate.
      if (link.delegateDid !== params.delegateDid) {
        link.delegateDid = params.delegateDid;
        await this.sublevel.put(key, JSON.stringify(link));
      }

      return link;
    } catch (error) {
      const e = error as { code: string };
      if (e.code !== 'LEVEL_NOT_FOUND') {
        throw error;
      }
    }

    // Create a new link with empty checkpoints.
    const link: ReplicationLinkState = {
      tenantDid      : params.tenantDid,
      remoteEndpoint : params.remoteEndpoint,
      scopeId,
      scope          : params.scope,
      status         : 'initializing',
      connectivity   : 'unknown',
      pull           : {},
      needsReconcile : false,
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
  // Minimal checkpoint helpers (durable state only — no progression logic)
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
   * Check whether a token belongs to the same domain (streamId + epoch) as
   * the checkpoint's current baseline. Returns `true` if domains match or if
   * the checkpoint has no baseline yet.
   */
  public static validateTokenDomain(checkpoint: DirectionCheckpoint, token: ProgressToken): boolean {
    if (checkpoint.contiguousAppliedToken === undefined) { return true; }
    return token.streamId === checkpoint.contiguousAppliedToken.streamId &&
           token.epoch === checkpoint.contiguousAppliedToken.epoch;
  }

  /**
   * Update `receivedToken` to the highest seen token (for observability).
   * Does NOT advance `contiguousAppliedToken` — that is owned by the engine's
   * delivery-order tracking.
   */
  public static setReceivedToken(checkpoint: DirectionCheckpoint, token: ProgressToken): void {
    if (
      checkpoint.receivedToken === undefined ||
      ReplicationLedger.comparePosition(token, checkpoint.receivedToken) > 0
    ) {
      checkpoint.receivedToken = token;
    }
  }

  /**
   * Commit a token as the new contiguous applied baseline. The caller (engine)
   * must have already verified that all earlier delivered tokens for this link
   * are durably committed before calling this.
   */
  public static commitContiguousToken(checkpoint: DirectionCheckpoint, token: ProgressToken): void {
    checkpoint.contiguousAppliedToken = token;
  }

  /**
   * Reset a replication checkpoint (e.g., after repair or domain change).
   * Clears all state.
   */
  public static resetCheckpoint(checkpoint: DirectionCheckpoint, token?: ProgressToken): void {
    checkpoint.contiguousAppliedToken = token;
    checkpoint.receivedToken = token;
  }

  // ---------------------------------------------------------------------------
  // Reconciliation helpers
  // ---------------------------------------------------------------------------

  /**
   * Mark a link as needing SMT reconciliation and persist.
   * Idempotent — no-op if already set.
   */
  public async markNeedsReconcile(link: ReplicationLinkState, _reason?: string): Promise<void> {
    if (!link.needsReconcile) {
      link.needsReconcile = true;
      await this.saveLink(link);
    }
  }

  /**
   * Clear the reconciliation flag after successful SMT reconciliation.
   */
  public async clearNeedsReconcile(link: ReplicationLinkState): Promise<void> {
    if (link.needsReconcile) {
      link.needsReconcile = false;
      await this.saveLink(link);
    }
  }
}

