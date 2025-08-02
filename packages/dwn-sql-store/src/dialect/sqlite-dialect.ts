import { Dialect } from './dialect.js';
import {
  ColumnBuilderCallback,
  ColumnDataType,
  CreateTableBuilder,
  Kysely,
  InsertObject,
  InsertQueryBuilder,
  SelectExpression,
  Selection,
  SqliteDialect as KyselySqliteDialect,
  Transaction,
} from 'kysely';

export class SqliteDialect extends KyselySqliteDialect implements Dialect {
  name = 'SQLite';
  isStreamingSupported = false;

  async hasTable(db: Kysely<any>, tableName: string): Promise<boolean> {
    const result = await db
      .selectFrom('sqlite_master')
      .select('name')
      .where('type', '=', 'table')
      .where('name', '=', tableName)
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

  addReferencedColumn<TB extends string>(
    builder: CreateTableBuilder<TB & string>,
    _tableName: TB,
    columnName: string,
    columnType: ColumnDataType,
    referenceTable: string,
    referenceColumnName: string,
    onDeleteAction: 'cascade' | 'no action' | 'restrict' | 'set null' | 'set default',
  ): CreateTableBuilder<TB & string> {
    return builder.addColumn(columnName, columnType, (col) => col.notNull().references(`${referenceTable}.${referenceColumnName}`).onDelete(onDeleteAction));
  }

  insertThenReturnId<DB, TB extends keyof DB = keyof DB, SE extends SelectExpression<DB, TB & string> = any>(
    db: Transaction<DB> | Kysely<DB>,
    table: TB & string,
    values: InsertObject<DB, TB & string>,
    returning: SE & `${string} as insertId`,
  ): InsertQueryBuilder<DB, TB & string, Selection<DB, TB & string, SE & `${string} as insertId`>> {
    return db.insertInto(table).values(values).returning(returning);
  }
}