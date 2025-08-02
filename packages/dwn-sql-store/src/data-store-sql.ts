import { DataStore, DataStream, DataStoreGetResult, DataStorePutResult } from '@tbd54566975/dwn-sdk-js';
import { Kysely } from 'kysely';
import { Readable } from 'readable-stream';
import { DwnDatabaseType } from './types.js';
import { Dialect } from './dialect/dialect.js';

export class DataStoreSql implements DataStore {
  #dialect: Dialect;
  #db: Kysely<DwnDatabaseType> | null = null;

  constructor(dialect: Dialect) {
    this.#dialect = dialect;
  }

  async open(): Promise<void> {
    if (this.#db) {
      return;
    }

    this.#db = new Kysely<DwnDatabaseType>({ dialect: this.#dialect });

    // if table already exists, there is no more things todo
    const tableName = 'dataStore';
    const tableExists = await this.#dialect.hasTable(this.#db, tableName);
    if (tableExists) {
      return;
    }

    // else create the table and corresponding indexes

    let table = this.#db.schema
      .createTable(tableName)
      .ifNotExists()// kept to show supported by all dialects in contrast to ifNotExists() below, though not needed due to hasTable() check above
      .addColumn('tenant', 'varchar(255)', (col) => col.notNull())
      .addColumn('recordId', 'varchar(60)', (col) => col.notNull())
      .addColumn('dataCid', 'varchar(60)', (col) => col.notNull());

    // Add columns that have dialect-specific constraints
    table = this.#dialect.addAutoIncrementingColumn(table, 'id', (col) => col.primaryKey());
    table = this.#dialect.addBlobColumn(table, 'data', (col) => col.notNull());
    await table.execute();

    // Add index for efficient lookups.
    await this.#db.schema
      .createIndex('tenant_recordId_dataCid')
      // .ifNotExists() // intentionally kept commented out code to show that it is not supported by all dialects (ie. MySQL)
      .on(tableName)
      .columns(['tenant', 'recordId', 'dataCid'])
      .unique()
      .execute();
  }

  async close(): Promise<void> {
    await this.#db?.destroy();
    this.#db = null;
  }

  async get(
    tenant: string,
    recordId: string,
    dataCid: string
  ): Promise<DataStoreGetResult | undefined> {
    if (!this.#db) {
      throw new Error(
        'Connection to database not open. Call `open` before using `get`.'
      );
    }

    const result = await this.#db
      .selectFrom('dataStore')
      .selectAll()
      .where('tenant', '=', tenant)
      .where('recordId', '=', recordId)
      .where('dataCid', '=', dataCid)
      .executeTakeFirst();

    if (!result) {
      return undefined;
    }

    return {
      dataSize   : result.data.length,
      dataStream : new Readable({
        read() {
          this.push(Buffer.from(result.data));
          this.push(null);
        }
      }),
    };
  }

  async put(
    tenant: string,
    recordId: string,
    dataCid: string,
    dataStream: Readable
  ): Promise<DataStorePutResult> {
    if (!this.#db) {
      throw new Error(
        'Connection to database not open. Call `open` before using `put`.'
      );
    }

    const bytes = await DataStream.toBytes(dataStream);
    const data = Buffer.from(bytes);

    await this.#db
      .insertInto('dataStore')
      .values({ tenant, recordId, dataCid, data })
      .executeTakeFirstOrThrow();

    return {
      dataSize: bytes.length
    };
  }

  async delete(
    tenant: string,
    recordId: string,
    dataCid: string
  ): Promise<void> {
    if (!this.#db) {
      throw new Error(
        'Connection to database not open. Call `open` before using `delete`.'
      );
    }

    await this.#db
      .deleteFrom('dataStore')
      .where('tenant', '=', tenant)
      .where('recordId', '=', recordId)
      .where('dataCid', '=', dataCid)
      .execute();
  }

  async clear(): Promise<void> {
    if (!this.#db) {
      throw new Error(
        'Connection to database not open. Call `open` before using `clear`.'
      );
    }

    await this.#db
      .deleteFrom('dataStore')
      .execute();
  }

}