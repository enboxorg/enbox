import { DwnDatabaseType } from './types.js';
import { Dialect } from './dialect/dialect.js';
import { executeWithRetryIfDatabaseIsLocked } from './utils/transaction.js';
import { Kysely } from 'kysely';
import { Cid, ManagedResumableTask, ResumableTaskStore } from '@tbd54566975/dwn-sdk-js';

export class ResumableTaskStoreSql implements ResumableTaskStore {
  private static readonly taskTimeoutInSeconds = 60;

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
    const tableName = 'resumableTasks';
    const tableExists = await this.#dialect.hasTable(this.#db, tableName);
    if (tableExists) {
      return;
    }

    // else create the table and corresponding indexes

    let table = this.#db.schema
      .createTable(tableName)
      .ifNotExists() // kept to show supported by all dialects in contrast to ifNotExists() below, though not needed due to hasTable() check above
      .addColumn('id', 'varchar(255)', (col) => col.primaryKey())
      .addColumn('task', 'text')
      .addColumn('timeout', 'bigint')
      .addColumn('retryCount', 'integer');

    await table.execute();

    await this.#db.schema
      .createIndex('index_timeout')
      // .ifNotExists() // intentionally kept commented out code to show that it is not supported by all dialects (ie. MySQL)
      .on('resumableTasks')
      .column('timeout')
      .execute();
  }

  async close(): Promise<void> {
    await this.#db?.destroy();
    this.#db = null;
  }

  async register(task: any, timeoutInSeconds: number): Promise<ManagedResumableTask> {
    if (!this.#db) {
      throw new Error('Connection to database not open. Call `open` before using `register`.');
    }

    const id = await Cid.computeCid(task);
    const timeout = Date.now() + timeoutInSeconds * 1000;
    const taskString = JSON.stringify(task);
    const retryCount = 0;
    const taskEntryInDatabase: ManagedResumableTask = { id, task: taskString, timeout, retryCount };
    await this.#db.insertInto('resumableTasks').values(taskEntryInDatabase).execute();

    return {
      id,
      task,
      retryCount,
      timeout,
    };
  }

  async grab(count: number): Promise<ManagedResumableTask[]> {
    if (!this.#db) {
      throw new Error('Connection to database not open. Call `open` before using `grab`.');
    }

    const now = Date.now();
    const newTimeout = now + (ResumableTaskStoreSql.taskTimeoutInSeconds * 1000);

    let tasks: DwnDatabaseType['resumableTasks'][] = [];

    const operation = async (transaction) => {
      tasks = await transaction
        .selectFrom('resumableTasks')
        .selectAll()
        .where('timeout', '<=', now)
        .limit(count)
        .execute();

      if (tasks.length > 0) {
        const ids = tasks.map((task) => task.id);
        await transaction
          .updateTable('resumableTasks')
          .set({ timeout: newTimeout })
          .where((eb) => eb('id', 'in', ids))
          .execute();
      }
    };

    await executeWithRetryIfDatabaseIsLocked(this.#db, operation);

    const tasksToReturn = tasks.map((task) => {
      return {
        id         : task.id,
        task       : JSON.parse(task.task),
        retryCount : task.retryCount,
        timeout    : task.timeout,
      };
    });

    return tasksToReturn;
  }

  async read(taskId: string): Promise<ManagedResumableTask | undefined> {
    if (!this.#db) {
      throw new Error('Connection to database not open. Call `open` before using `read`.');
    }

    const task = await this.#db
      .selectFrom('resumableTasks')
      .selectAll()
      .where('id', '=', taskId)
      .executeTakeFirst();

    if (task !== undefined) {
      // NOTE: special handling ONLY for PostgreSQL:
      // Even though PostgreSQL stores `bigint` as a 64 bit number, the `pg` library we depend on returns it as a string, hence the conversion.
      if (typeof task.timeout !== 'number') {
        task.timeout = parseInt(task.timeout, 10);
      }
    }

    return task;
  }

  async extend(taskId: string, timeoutInSeconds: number): Promise<void> {
    if (!this.#db) {
      throw new Error('Connection to database not open. Call `open` before using `extend`.');
    }

    const timeout = Date.now() + (timeoutInSeconds * 1000);

    await this.#db
      .updateTable('resumableTasks')
      .set({ timeout })
      .where('id', '=', taskId)
      .execute();
  }

  async delete(taskId: string): Promise<void> {
    if (!this.#db) {
      throw new Error('Connection to database not open. Call `open` before using `delete`.');
    }

    await this.#db
      .deleteFrom('resumableTasks')
      .where('id', '=', taskId)
      .execute();
  }

  async clear(): Promise<void> {
    if (!this.#db) {
      throw new Error('Connection to database not open. Call `open` before using `clear`.');
    }

    await this.#db
      .deleteFrom('resumableTasks')
      .execute();
  }
}
