import { Transaction } from 'kysely';

import type { DwnDatabaseType, KeyValues } from '../types.js';

import { Dialect } from '../dialect/dialect.js';
import { sanitizedValue } from './sanitize.js';

/**
 * Helper class to manage adding indexes for `RecordsWrite` messages which contain `tags`.
 */
export class TagTables {

  /**
   * @param dialect the target dialect, necessary for returning the `insertId`
   * @param table the DB Table in order to index the tags and values in the correct tables. Choice between `messageStoreMessages` and `eventLogMessages`
   */
  constructor(private dialect: Dialect, private table: 'messageStoreMessages' | 'eventLogMessages'){}

  /**
   * Inserts the given tags associated with the given foreign `insertId`.
   */
  async executeTagsInsert(
    foreignInsertId: number,
    tags: KeyValues,
    tx: Transaction<DwnDatabaseType>,
  ):Promise<void> {
    const tagTable = this.table === 'messageStoreMessages' ? 'messageStoreRecordsTags' : 'eventLogRecordsTags';
    const foreignKeyReference = tagTable === 'messageStoreRecordsTags' ? { messageInsertId: foreignInsertId } : { eventWatermark: foreignInsertId };

    for (const tag in tags) {
      const tagValues = tags[tag];
      const values = Array.isArray(tagValues) ? tagValues : [ tagValues ];

      for(const value of values) {
        const tagInsertValue = sanitizedValue(value);
        const insertValues = {
          tag,
          valueNumber : typeof tagInsertValue === 'number' ? tagInsertValue : null,
          valueString : typeof tagInsertValue === 'string' ? tagInsertValue : null,
          ...foreignKeyReference,
        };
        await this.dialect.insertThenReturnId(tx, tagTable, insertValues, 'id as insertId').executeTakeFirstOrThrow();
      }
    }
  }
}