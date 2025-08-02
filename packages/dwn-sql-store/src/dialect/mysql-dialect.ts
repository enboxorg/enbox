import { Dialect } from './dialect.js';
import {
  AnyColumn,
  ColumnDataType,
  CreateTableBuilder,
  ColumnBuilderCallback,
  InsertObject,
  InsertQueryBuilder,
  SelectExpression,
  Selection,
  Transaction,
  MysqlDialect as KyselyMysqlDialect,
  Kysely,
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
}