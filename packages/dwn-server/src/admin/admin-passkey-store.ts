import type { Dialect } from '@enbox/dwn-sql-store';

import { Kysely, sql } from 'kysely';

/**
 * A registered WebAuthn credential (passkey) for admin access.
 */
export type AdminPasskeyRecord = {
  /** Base64url-encoded credential ID. */
  id : string;
  /** Human-readable name for the passkey (e.g. "MacBook Touch ID"). */
  name : string;
  /** Base64url-encoded COSE public key. */
  publicKey : string;
  /** Monotonically increasing counter for replay protection. */
  counter : number;
  /** WebAuthn transports the credential supports (JSON-encoded string array). */
  transports : string;
  /** ISO-8601 timestamp when the passkey was registered. */
  createdAt : string;
  /** ISO-8601 timestamp of the most recent successful authentication. */
  lastUsedAt : string | null;
};

/**
 * SQL-backed credential store for WebAuthn passkeys used by the admin panel.
 *
 * Follows the same Kysely + Dialect pattern as {@link AuditLog} and
 * {@link WebhookManager}. The `adminPasskeys` table is created automatically
 * on first use.
 *
 * Future: migrate to DID/DWN-based auth (see https://github.com/enboxorg/enbox/issues/546).
 */
export class AdminPasskeyStore {
  static readonly #tableName = 'adminPasskeys';

  readonly #db: Kysely<PasskeyDatabase>;

  private constructor(dialect: Dialect) {
    this.#db = new Kysely<PasskeyDatabase>({ dialect });
  }

  /**
   * Creates and initializes an `AdminPasskeyStore` instance.
   * Creates the `adminPasskeys` table if it does not already exist.
   */
  public static async create(dialect: Dialect): Promise<AdminPasskeyStore> {
    const store = new AdminPasskeyStore(dialect);
    await store.#initialize();
    return store;
  }

  /**
   * Verifies that the required table exists. Throws a clear error directing
   * the caller to run server migrations first.
   */
  async #initialize(): Promise<void> {
    try {
      await sql`SELECT 1 FROM ${sql.table(AdminPasskeyStore.#tableName)} LIMIT 0`.execute(this.#db);
    } catch {
      throw new Error(
        `AdminPasskeyStore: table '${AdminPasskeyStore.#tableName}' does not exist. Run server migrations before starting.`
      );
    }
  }

  /**
   * Stores a new passkey credential.
   */
  public async save(record: AdminPasskeyRecord): Promise<void> {
    await this.#db
      .insertInto(AdminPasskeyStore.#tableName)
      .values({
        id         : record.id,
        name       : record.name,
        publicKey  : record.publicKey,
        counter    : record.counter,
        transports : record.transports,
        createdAt  : record.createdAt,
        lastUsedAt : record.lastUsedAt ?? null,
      })
      .execute();
  }

  /**
   * Retrieves a passkey by its credential ID.
   */
  public async getById(id: string): Promise<AdminPasskeyRecord | undefined> {
    const row = await this.#db
      .selectFrom(AdminPasskeyStore.#tableName)
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) {
      return undefined;
    }

    return this.#toRecord(row);
  }

  /**
   * Returns all registered passkeys, ordered by creation date (newest first).
   */
  public async list(): Promise<AdminPasskeyRecord[]> {
    const rows = await this.#db
      .selectFrom(AdminPasskeyStore.#tableName)
      .selectAll()
      .orderBy('createdAt', 'desc')
      .execute();

    return rows.map((row): AdminPasskeyRecord => this.#toRecord(row));
  }

  /**
   * Returns the count of registered passkeys.
   */
  public async count(): Promise<number> {
    const result = await this.#db
      .selectFrom(AdminPasskeyStore.#tableName)
      .select(this.#db.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();

    return Number(result.count);
  }

  /**
   * Updates the counter and last-used timestamp after a successful authentication.
   */
  public async updateCounter(id: string, counter: number): Promise<void> {
    await this.#db
      .updateTable(AdminPasskeyStore.#tableName)
      .set({
        counter,
        lastUsedAt: new Date().toISOString(),
      })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Deletes a passkey by its credential ID.
   * @returns `true` if the passkey was found and deleted.
   */
  public async delete(id: string): Promise<boolean> {
    const result = await this.#db
      .deleteFrom(AdminPasskeyStore.#tableName)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    return Number(result.numDeletedRows) > 0;
  }

  /**
   * Closes the underlying database connection.
   */
  public async close(): Promise<void> {
    await this.#db.destroy();
  }

  #toRecord(row: PasskeyRow): AdminPasskeyRecord {
    return {
      id         : row.id,
      name       : row.name,
      publicKey  : row.publicKey,
      counter    : Number(row.counter),
      transports : row.transports,
      createdAt  : row.createdAt,
      lastUsedAt : row.lastUsedAt ?? null,
    };
  }
}

// ---------------------------------------------------------------------------
// Kysely type definitions
// ---------------------------------------------------------------------------

interface PasskeyRow {
  id : string;
  name : string;
  publicKey : string;
  counter : number;
  transports : string;
  createdAt : string;
  lastUsedAt : string | null;
}

interface PasskeyDatabase {
  adminPasskeys : PasskeyRow;
}
