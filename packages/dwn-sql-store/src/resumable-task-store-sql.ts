import type { Dialect } from './dialect/dialect.js';
import type { DwnDatabaseType } from './types.js';
import type { ManagedResumableTask, ResumableTaskStore } from '@enbox/dwn-sdk-js';

import { Cid } from '@enbox/dwn-sdk-js';
import { executeWithTransaction } from './utils/transaction.js';
import { Kysely, sql } from 'kysely';

export class ResumableTaskStoreSql implements ResumableTaskStore {
  private static readonly taskTimeoutInSeconds = 60;

  readonly #dialect: Dialect;
  #db: Kysely<DwnDatabaseType> | null = null;

  constructor(dialect: Dialect) {
    this.#dialect = dialect;
  }

  async open(): Promise<void> {
    if (this.#db) {
      return;
    }

    this.#db = new Kysely<DwnDatabaseType>({ dialect: this.#dialect });

    // Fail fast if migrations have not been run — tables must already exist.
    await this.#assertTablesExist();
  }

  /**
   * Verifies that the required tables exist by executing a zero-row SELECT.
   * Throws a clear error directing the caller to run migrations first.
   */
  async #assertTablesExist(): Promise<void> {
    try {
      await sql`SELECT 1 FROM ${sql.table('resumableTasks')} LIMIT 0`.execute(this.#db!);
    } catch {
      throw new Error(
        'ResumableTaskStoreSql: table \'resumableTasks\' does not exist. Run DWN store migrations before opening stores.'
      );
    }
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

    const operation = async (transaction): Promise<void> => {
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

    await executeWithTransaction(this.#db, operation);

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
        task.timeout = Number.parseInt(task.timeout, 10);
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
