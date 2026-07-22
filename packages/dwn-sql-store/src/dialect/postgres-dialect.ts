import type { Dialect } from './dialect.js';
import type {
  ColumnBuilderCallback,
  ColumnDataType,
  CreateTableBuilder,
  InsertObject,
  InsertQueryBuilder,
  Kysely,
  RawBuilder,
  SelectExpression,
  Selection,
  SqlBool,
  Transaction } from 'kysely';

import {
  PostgresDialect as KyselyPostgresDialect,
  sql,
} from 'kysely';

export class PostgresDialect extends KyselyPostgresDialect implements Dialect {
  name = 'PostgreSQL';
  isStreamingSupported = true;

  async hasTable(db: Kysely<any>, tableName: string): Promise<boolean> {
    const result = await db
      .selectFrom('information_schema.tables')
      .select('table_name')
      .where('table_name', '=', tableName)
      .execute();

    return result.length > 0;
  }

  addAutoIncrementingColumn<TB extends string>(
    builder: CreateTableBuilder<TB>,
    columnName: string,
    callback?: ColumnBuilderCallback
  ): CreateTableBuilder<TB> {
    return builder.addColumn(columnName, 'serial', callback);
  }

  addBlobColumn<TB extends string>(
    builder: CreateTableBuilder<TB>,
    columnName: string,
    callback?: ColumnBuilderCallback
  ): CreateTableBuilder<TB> {
    return builder.addColumn(columnName, 'bytea', callback);
  }

  addReferencedColumn<TB extends string>(
    builder: CreateTableBuilder<TB & string>,
    _tableName: TB,
    columnName: string,
    columnType: ColumnDataType,
    referenceTable: string,
    referenceColumnName: string,
    onDeleteAction: 'cascade' | 'no action' | 'restrict' | 'set null' | 'set default',
  ): CreateTableBuilder<TB & string> {
    return builder.addColumn(
      columnName, columnType,
      (col) => col.notNull().references(`${referenceTable}.${referenceColumnName}`).onDelete(onDeleteAction),
    );
  }

  insertThenReturnId<DB, TB extends keyof DB = keyof DB, SE extends SelectExpression<DB, TB & string> = any>(
    db: Transaction<DB> | Kysely<DB>,
    table: TB & string,
    values: InsertObject<DB, TB & string>,
    returning: SE & `${string} as insertId`,
  ): InsertQueryBuilder<DB, TB & string, Selection<DB, TB & string, SE & `${string} as insertId`>> {
    return db.insertInto(table).values(values).returning(returning);
  }

  async lockReplicationCounter<DB>(tx: Transaction<DB>, tenant: string): Promise<void> {
    await sql`
      INSERT INTO ${sql.table('replicationCounters')} (tenant, seq)
      VALUES (${tenant}, 0)
      ON CONFLICT (tenant) DO UPDATE SET seq = ${sql.ref('replicationCounters.seq')}
    `.execute(tx);
  }

  async incrementReplicationCounter<DB>(tx: Transaction<DB>, tenant: string): Promise<bigint> {
    const result = await sql<{ seq: string }>`
      UPDATE ${sql.table('replicationCounters')}
      SET seq = seq + 1
      WHERE tenant = ${tenant}
      RETURNING CAST(seq AS TEXT) AS seq
    `.execute(tx);

    return BigInt(String(result.rows[0].seq));
  }

  bigIntColumnAsText(columnReference: string): RawBuilder<string | null> {
    return sql<string | null>`CAST(${sql.ref(columnReference)} AS TEXT)`;
  }

  subtreePredicate(columnReference: string, subtree: string): RawBuilder<SqlBool> {
    const descendantPrefix = `${subtree}/`;
    return sql<SqlBool>`(
      convert_to(${sql.ref(columnReference)}, 'UTF8') = convert_to(${subtree}, 'UTF8')
      OR position(convert_to(${descendantPrefix}, 'UTF8') in convert_to(${sql.ref(columnReference)}, 'UTF8')) = 1
    )`;
  }

}
