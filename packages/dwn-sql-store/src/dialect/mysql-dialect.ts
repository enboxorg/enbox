import type { Dialect } from './dialect.js';
import type {
  AnyColumn,
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
  MysqlDialect as KyselyMysqlDialect,
  sql,
} from 'kysely';

export class MysqlDialect extends KyselyMysqlDialect implements Dialect {
  name = 'MySQL';
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
    return builder.addColumn(columnName, 'integer', (col) => {
      col = col.autoIncrement();
      if (callback) {
        col = callback(col);
      }
      return col;
    });
  }

  addBlobColumn<TB extends string>(
    builder: CreateTableBuilder<TB>,
    columnName: string,
    callback?: ColumnBuilderCallback
  ): CreateTableBuilder<TB> {
    return builder.addColumn(columnName, 'blob', callback);
  }

  /**
   * In MySQL, the ForeignKey name it creates in `mysql` will be in the following format:
   * `${referenceTable}_${referenceColumnName}__${tableName}_${columnName}`
   * ex: if the reference table is `users` and the reference column is `id` and the table is `profiles` and the column is `userId`,
   * the resulting name for the foreign key is: `users_id__profiles_userId`
   */
  addReferencedColumn<TB extends string>(
    builder: CreateTableBuilder<TB & string>,
    tableName: TB,
    columnName: string,
    columnType: ColumnDataType,
    referenceTable: string,
    referenceColumnName: string,
    onDeleteAction: 'cascade' | 'no action' | 'restrict' | 'set null' | 'set default',
  ): CreateTableBuilder<TB & string> {
    return builder
      .addColumn(columnName, columnType, (col) => col.notNull())
      .addForeignKeyConstraint(
        `${referenceTable}_${referenceColumnName}__${tableName}_${columnName}`,
        [columnName],
        referenceTable,
        [referenceColumnName],
        (constraint) => constraint.onDelete(onDeleteAction)
      );
  }

  insertThenReturnId<DB, TB extends keyof DB = keyof DB, SE extends SelectExpression<DB, TB & string> = AnyColumn<DB, TB>>(
    db: Transaction<DB> | Kysely<DB>,
    table: TB & string,
    values: InsertObject<DB, TB & string>,
    _returning: SE & `${string} as insertId`,
  ): InsertQueryBuilder<DB, TB & string, Selection<DB, TB & string, SE & `${string} as insertId`>> {
    return db.insertInto(table).values(values);
  }

  async lockReplicationCounter<DB>(tx: Transaction<DB>, tenant: string): Promise<void> {
    await sql`
      INSERT INTO ${sql.table('replicationCounters')} (tenant, seq)
      VALUES (${tenant}, 0)
      ON DUPLICATE KEY UPDATE seq = seq
    `.execute(tx);
  }

  async incrementReplicationCounter<DB>(tx: Transaction<DB>, tenant: string): Promise<bigint> {
    await sql`
      UPDATE ${sql.table('replicationCounters')}
      SET seq = LAST_INSERT_ID(seq + 1)
      WHERE tenant = ${tenant}
    `.execute(tx);

    const result = await sql<{ seq: string }>`
      SELECT CAST(LAST_INSERT_ID() AS CHAR) AS seq
    `.execute(tx);

    return BigInt(String(result.rows[0].seq));
  }

  bigIntColumnAsText(columnReference: string): RawBuilder<string | null> {
    return sql<string | null>`CAST(${sql.ref(columnReference)} AS CHAR)`;
  }

  subtreePredicate(columnReference: string, subtree: string): RawBuilder<SqlBool> {
    const descendantPrefix = `${subtree}/`;
    return sql<SqlBool>`(
      CAST(${sql.ref(columnReference)} AS BINARY) = CAST(${subtree} AS BINARY)
      OR LOCATE(CAST(${descendantPrefix} AS BINARY), CAST(${sql.ref(columnReference)} AS BINARY)) = 1
    )`;
  }
}
