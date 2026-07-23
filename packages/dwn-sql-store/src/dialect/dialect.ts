import type {
  ColumnBuilderCallback,
  ColumnDataType,
  CreateTableBuilder,
  InsertObject,
  InsertQueryBuilder,
  Kysely,
  Dialect as KyselyDialect,
  RawBuilder,
  SelectExpression,
  Selection,
  Transaction,
} from 'kysely';

export interface Dialect extends KyselyDialect {
  readonly name: string;
  readonly isStreamingSupported: boolean;

  hasTable(db: Kysely<any>, tableName: string): Promise<boolean>;

  addAutoIncrementingColumn<TB extends string>(
    builder: CreateTableBuilder<TB>,
    columnName: string,
    callback?: ColumnBuilderCallback
  ): CreateTableBuilder<TB>;

  addBlobColumn<TB extends string>(
    builder: CreateTableBuilder<TB>,
    columnName: string,
    callback?: ColumnBuilderCallback
  ): CreateTableBuilder<TB>;

  /**
   * This is a helper method to add a column with foreign key constraints.
   * This is primarily useful because the `mySQL` dialect adds the constraints in a different way than `sqlite` and `postgres`.
   *
   * @param builder the CreateTableBuilder to add the column to.
   * @param tableName the name of the table to add the column to.
   * @param columnName the name of the column to add.
   * @param columnType the type of the column to add.
   * @param referenceTable the foreign table to reference.
   * @param referenceColumnName the foreign column to reference.
   * @param onDeleteAction the action to take when the referenced row is deleted.
   *
   * @returns {CreateTableBuilder} the CreateTableBuilder with the added column.
   */
  addReferencedColumn<TB extends string>(
    builder: CreateTableBuilder<TB & string>,
    tableName: TB,
    columnName: string,
    columnType: ColumnDataType,
    referenceTable: string,
    referenceColumnName: string,
    onDeleteAction: 'cascade' | 'no action' | 'restrict' | 'set null' | 'set default',
  ): CreateTableBuilder<TB & string>;

  /**
   * This is a helper method to return an `insertId` across all dialects after inserting values.
   * `postgres` and `sqlite` both support the `returning` clause, however `mysql` does not and instead returns the last inserted id.
   *
   * @param db the Kysely DB object or a DB Transaction.
   * @param table the table to insert into.
   * @param values the values to insert.
   * @param returning a string representing the generated key you'd like returned as an insertId.
   *
   *  NOTE: the `returning` value must be formatted to return an insertId value.
   *  ex. if the generated key is `id` the string should be `id as insertId`.
   *
   * @returns {InsertQueryBuilder} object to further modify the query or execute it.
   */
  insertThenReturnId<DB, TB extends keyof DB = keyof DB, SE extends SelectExpression<DB, TB & string> = any>(
    db: Transaction<DB> | Kysely<DB>,
    table: TB & string,
    values: InsertObject<DB, TB & string>,
    returning: SE & `${string} as insertId`,
  ): InsertQueryBuilder<DB, TB & string, Selection<DB, TB & string, SE & `${string} as insertId`>>;

  /**
   * Ensures a replication counter row exists and takes the dialect-specific write lock for that
   * tenant on the transaction connection. Call before reading or mutating tenant log/fingerprint
   * state so same-tenant mutations are serialized in commit order.
   */
  lockReplicationCounter<DB>(tx: Transaction<DB>, tenant: string): Promise<void>;

  /**
   * Advances the locked tenant replication counter by one and returns the assigned position.
   */
  incrementReplicationCounter<DB>(tx: Transaction<DB>, tenant: string): Promise<bigint>;

  /**
   * Casts a bigint/integer column to text so database drivers cannot narrow
   * replication positions to JavaScript numbers when reading rows.
   */
  bigIntColumnAsText(columnReference: string): RawBuilder<string | null>;

  /** Applies byte-stable comparison semantics to a text column. */
  byteStableText(columnReference: string): RawBuilder<string | null>;

}
