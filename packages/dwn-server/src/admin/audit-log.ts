import type { Dialect } from '@enbox/dwn-sql-store';

import { Kysely } from 'kysely';

/**
 * Input for recording a new audit event.
 */
export type AuditEventInput = {
  /** The actor that performed the action (`system` or an admin identifier). */
  actor : string;
  /** Dot-delimited action identifier (e.g. `tenant.suspend`, `quota.update`). */
  action : string;
  /** Target of the action (typically a tenant DID or resource identifier). */
  target? : string;
  /** Additional detail — stored as a JSON string. */
  detail? : string;
};

/**
 * A persisted audit event row.
 */
export type AuditEvent = AuditEventInput & {
  /** Auto-incremented row ID. */
  id : number;
  /** ISO-8601 timestamp when the event was recorded. */
  timestamp : string;
};

/**
 * Query options for retrieving audit events.
 */
export type AuditQueryOptions = {
  /** Return events with timestamp >= this ISO-8601 value. */
  since? : string;
  /** Filter by action (exact match or prefix with `*`). */
  action? : string;
  /** Filter by target DID or resource. */
  target? : string;
  /** Maximum number of results. Default: 50. */
  limit? : number;
  /** Cursor (row ID) for keyset pagination. */
  cursor? : number;
};

/**
 * Persistent, append-only audit log backed by a SQL table.
 *
 * Records significant admin and system events. Queryable via
 * `GET /admin/api/audit`.
 *
 * @see https://github.com/enboxorg/enbox/issues/327
 */
export class AuditLog {
  static readonly #tableName = 'adminAuditLog';

  #db: Kysely<AuditDatabase>;

  private constructor(dialect: Dialect) {
    this.#db = new Kysely<AuditDatabase>({ dialect });
  }

  /**
   * Creates and initializes an `AuditLog` instance.
   * Creates the `adminAuditLog` table if it does not already exist.
   */
  public static async create(dialect: Dialect): Promise<AuditLog> {
    const auditLog = new AuditLog(dialect);
    await auditLog.#initialize();
    return auditLog;
  }

  /**
   * Creates the audit log table and indices if they do not exist.
   */
  async #initialize(): Promise<void> {
    await this.#db.schema
      .createTable(AuditLog.#tableName)
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('timestamp', 'text', (col) => col.notNull())
      .addColumn('actor', 'text', (col) => col.notNull())
      .addColumn('action', 'text', (col) => col.notNull())
      .addColumn('target', 'text')
      .addColumn('detail', 'text')
      .execute();

    // Indices for common query patterns. Wrapped in try/catch because
    // `CREATE INDEX IF NOT EXISTS` syntax varies across dialects.
    try {
      await this.#db.schema
        .createIndex('index_audit_timestamp')
        .ifNotExists()
        .on(AuditLog.#tableName)
        .column('timestamp')
        .execute();
    } catch {
      // Index already exists.
    }

    try {
      await this.#db.schema
        .createIndex('index_audit_target')
        .ifNotExists()
        .on(AuditLog.#tableName)
        .column('target')
        .execute();
    } catch {
      // Index already exists.
    }

    try {
      await this.#db.schema
        .createIndex('index_audit_action')
        .ifNotExists()
        .on(AuditLog.#tableName)
        .column('action')
        .execute();
    } catch {
      // Index already exists.
    }
  }

  /**
   * Records a new audit event.
   */
  public async record(event: AuditEventInput): Promise<void> {
    await this.#db
      .insertInto(AuditLog.#tableName)
      .values({
        timestamp : new Date().toISOString(),
        actor     : event.actor,
        action    : event.action,
        target    : event.target ?? null,
        detail    : event.detail ?? null,
      })
      .execute();
  }

  /**
   * Queries audit events with optional filtering and pagination.
   */
  public async query(options?: AuditQueryOptions): Promise<{ events: AuditEvent[]; cursor?: number }> {
    const limit = Math.min(options?.limit ?? 50, 1000);

    let query = this.#db
      .selectFrom(AuditLog.#tableName)
      .selectAll()
      .orderBy('id', 'desc')
      .limit(limit + 1); // fetch one extra to detect next page

    if (options?.cursor !== undefined) {
      query = query.where('id', '<', options.cursor);
    }

    if (options?.since !== undefined) {
      query = query.where('timestamp', '>=', options.since);
    }

    if (options?.action !== undefined) {
      if (options.action.endsWith('*')) {
        const prefix = options.action.slice(0, -1);
        query = query.where('action', 'like', `${prefix}%`);
      } else {
        query = query.where('action', '=', options.action);
      }
    }

    if (options?.target !== undefined) {
      query = query.where('target', '=', options.target);
    }

    const results = await query.execute();

    const events: AuditEvent[] = results.map((row): AuditEvent => ({
      id        : Number(row.id),
      timestamp : row.timestamp,
      actor     : row.actor,
      action    : row.action,
      target    : row.target ?? undefined,
      detail    : row.detail ?? undefined,
    }));

    let cursor: number | undefined;
    if (events.length > limit) {
      events.pop();
      cursor = events[events.length - 1].id;
    }

    return { events, cursor };
  }

  /**
   * Returns the total number of audit events.
   */
  public async count(): Promise<number> {
    const result = await this.#db
      .selectFrom(AuditLog.#tableName)
      .select(this.#db.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();

    return Number(result.count);
  }

  /**
   * Closes the underlying database connection.
   */
  public async close(): Promise<void> {
    await this.#db.destroy();
  }
}

// ---------------------------------------------------------------------------
// Kysely type definitions
// ---------------------------------------------------------------------------

interface AuditLogRow {
  id : number;
  timestamp : string;
  actor : string;
  action : string;
  target : string | null;
  detail : string | null;
}

interface AuditDatabase {
  adminAuditLog : AuditLogRow;
}
