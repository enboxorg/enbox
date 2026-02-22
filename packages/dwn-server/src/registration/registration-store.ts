import type { Dialect } from '@enbox/dwn-sql-store';
import type { RegistrationData } from '@enbox/dwn-clients';
import type { TenantQuota } from '../admin/types.js';

import { Kysely, sql } from 'kysely';

/**
 * The RegistrationStore is responsible for storing and retrieving tenant registration information.
 */
export class RegistrationStore {
  private static readonly registeredTenantTableName = 'registeredTenants';
  private static readonly tenantQuotasTableName = 'tenantQuotas';

  private db: Kysely<RegistrationDatabase>;

  private constructor (sqlDialect: Dialect) {
    this.db = new Kysely<RegistrationDatabase>({ dialect: sqlDialect });
  }

  /**
   * Creates a new RegistrationStore instance.
   */
  public static async create(sqlDialect: Dialect): Promise<RegistrationStore> {
    const store = new RegistrationStore(sqlDialect);

    await store.initialize();

    return store;
  }

  private async initialize(): Promise<void> {
    await this.db.schema
      .createTable(RegistrationStore.registeredTenantTableName)
      .ifNotExists()
      .addColumn('did', 'text', (column) => column.primaryKey())
      .addColumn('termsOfServiceHash', 'text')
      .addColumn('suspended', 'integer', (column) => column.defaultTo(0))
      .execute();

    // Add the `suspended` column to existing tables that don't have it yet.
    // Kysely doesn't support `ADD COLUMN IF NOT EXISTS` across all dialects, so we
    // catch and ignore the "column already exists" error.
    try {
      await this.db.schema
        .alterTable(RegistrationStore.registeredTenantTableName)
        .addColumn('suspended', 'integer', (column) => column.defaultTo(0))
        .execute();
    } catch {
      // Column already exists — expected for new installations.
    }

    // Per-tenant storage quotas table.
    await this.db.schema
      .createTable(RegistrationStore.tenantQuotasTableName)
      .ifNotExists()
      .addColumn('did', 'text', (column) => column.primaryKey())
      .addColumn('maxMessages', 'integer', (column) => column.defaultTo(0))
      .addColumn('maxStorageBytes', 'bigint', (column) => column.defaultTo(0))
      .execute();
  }

  /**
   * Inserts or updates the tenant registration information.
   */
  public async insertOrUpdateTenantRegistration(registrationData: RegistrationData): Promise<void> {
    await this.db
      .insertInto(RegistrationStore.registeredTenantTableName)
      .values({ ...registrationData, suspended: 0 })
      .onConflict((oc) =>
        oc.column('did').doUpdateSet((eb) => ({
          termsOfServiceHash: eb.ref('excluded.termsOfServiceHash'),
        })),
      )
      // Executes the query. No error is thrown if the query doesn't affect any rows.
      .executeTakeFirst();
  }

  /**
   * Retrieves the tenant registration information.
   */
  public async getTenantRegistration(tenantDid: string): Promise<RegisteredTenantRow | undefined> {
    const result = await this.db
      .selectFrom(RegistrationStore.registeredTenantTableName)
      .select('did')
      .select('termsOfServiceHash')
      .select('suspended')
      .where('did', '=', tenantDid)
      .execute();

    if (result.length === 0) {
      return undefined;
    }

    return result[0];
  }

  // ---------------------------------------------------------------------------
  // Admin operations
  // ---------------------------------------------------------------------------

  /**
   * Returns a paginated list of registered tenants.
   */
  public async listTenants(options?: {
    cursor? : string;
    limit? : number;
  }): Promise<{ tenants: RegisteredTenantRow[]; cursor?: string }> {
    const limit = options?.limit ?? 20;

    let query = this.db
      .selectFrom(RegistrationStore.registeredTenantTableName)
      .select(['did', 'termsOfServiceHash', 'suspended'])
      .orderBy('did', 'asc')
      .limit(limit + 1); // fetch one extra to detect next page

    if (options?.cursor) {
      query = query.where('did', '>', options.cursor);
    }

    const results = await query.execute();

    let cursor: string | undefined;
    if (results.length > limit) {
      results.pop();
      cursor = results[results.length - 1].did;
    }

    return { tenants: results, cursor };
  }

  /**
   * Returns the total count of registered tenants.
   */
  public async getTenantCount(): Promise<number> {
    const result = await this.db
      .selectFrom(RegistrationStore.registeredTenantTableName)
      .select(sql<number>`count(*)`.as('count'))
      .executeTakeFirstOrThrow();

    return Number(result.count);
  }

  /**
   * Suspends a tenant. Returns `true` if the tenant was found and suspended.
   */
  public async suspendTenant(did: string): Promise<boolean> {
    const result = await this.db
      .updateTable(RegistrationStore.registeredTenantTableName)
      .set({ suspended: 1 })
      .where('did', '=', did)
      .executeTakeFirst();

    return Number(result.numUpdatedRows) > 0;
  }

  /**
   * Unsuspends a tenant. Returns `true` if the tenant was found and unsuspended.
   */
  public async unsuspendTenant(did: string): Promise<boolean> {
    const result = await this.db
      .updateTable(RegistrationStore.registeredTenantTableName)
      .set({ suspended: 0 })
      .where('did', '=', did)
      .executeTakeFirst();

    return Number(result.numUpdatedRows) > 0;
  }

  /**
   * Deletes a tenant registration. Returns `true` if the tenant was found and deleted.
   */
  public async deleteTenant(did: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom(RegistrationStore.registeredTenantTableName)
      .where('did', '=', did)
      .executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
  }

  /**
   * Returns the count of suspended tenants.
   */
  public async getSuspendedCount(): Promise<number> {
    const result = await this.db
      .selectFrom(RegistrationStore.registeredTenantTableName)
      .select(sql<number>`count(*)`.as('count'))
      .where('suspended', '=', 1)
      .executeTakeFirstOrThrow();

    return Number(result.count);
  }

  // ---------------------------------------------------------------------------
  // Tenant quota operations
  // ---------------------------------------------------------------------------

  /**
   * Returns the quota for a tenant, or `undefined` if no per-tenant quota is set.
   */
  public async getQuota(did: string): Promise<TenantQuota | undefined> {
    const result = await this.db
      .selectFrom(RegistrationStore.tenantQuotasTableName)
      .select(['did', 'maxMessages', 'maxStorageBytes'])
      .where('did', '=', did)
      .executeTakeFirst();

    if (result === undefined) {
      return undefined;
    }

    return {
      did             : result.did,
      maxMessages     : Number(result.maxMessages),
      maxStorageBytes : Number(result.maxStorageBytes),
    };
  }

  /**
   * Sets (inserts or updates) the quota for a tenant.
   */
  public async setQuota(quota: TenantQuota): Promise<void> {
    await this.db
      .insertInto(RegistrationStore.tenantQuotasTableName)
      .values({
        did             : quota.did,
        maxMessages     : quota.maxMessages,
        maxStorageBytes : quota.maxStorageBytes,
      })
      .onConflict((oc) =>
        oc.column('did').doUpdateSet({
          maxMessages     : quota.maxMessages,
          maxStorageBytes : quota.maxStorageBytes,
        }),
      )
      .executeTakeFirst();
  }

  /**
   * Deletes the per-tenant quota. Returns `true` if a quota existed and was deleted.
   */
  public async deleteQuota(did: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom(RegistrationStore.tenantQuotasTableName)
      .where('did', '=', did)
      .executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
  }
}

/**
 * A row in the `registeredTenants` table.
 */
export interface RegisteredTenantRow {
  did : string;
  termsOfServiceHash : string;
  suspended? : number;
}

interface RegisteredTenants {
  did : string;
  termsOfServiceHash : string;
  suspended : number;
}

interface TenantQuotasRow {
  did : string;
  maxMessages : number;
  maxStorageBytes : number;
}

interface RegistrationDatabase {
  registeredTenants : RegisteredTenants;
  tenantQuotas : TenantQuotasRow;
}
