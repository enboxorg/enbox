import type { DwnDatabaseType } from '../types.js';
import type { Filter } from '@enbox/dwn-sdk-js';
import type { ExpressionBuilder, OperandExpression, RawBuilder, SelectQueryBuilder, SqlBool } from 'kysely';

import { DynamicModule, sql } from 'kysely';
import { sanitizedValue, sanitizeFiltersAndSeparateTags } from './sanitize.js';

/**
 * Takes multiple Filters and returns a single query.
 * Each filter is evaluated as an OR operation.
 *
 * @param filters Array of filters to be evaluated as OR operations
 * @param query the incoming QueryBuilder.
 * @returns The modified QueryBuilder respecting the provided filters.
 */
export function filterSelectQuery<DB = DwnDatabaseType, TB extends keyof DB = keyof DB, O = unknown>(
  filters: Filter[],
  query: SelectQueryBuilder<DB, TB, O>
): SelectQueryBuilder<DB, TB, O> {
  const sanitizedFilters = sanitizeFiltersAndSeparateTags(filters);

  return query.where((eb) =>
    // evaluate the filters as an OR expression.
    eb.or(sanitizedFilters.map(({ filter, tags }) => {
      // evaluate each filter + tags tuple as an AND expression.
      const andOperands: OperandExpression<SqlBool>[] = [];

      processFilter(eb, andOperands, filter);
      processTags(eb, andOperands, tags);

      return eb.and(andOperands);
    }))
  );
}

/**
 * Processes each property in the non-tags filter as an AND operand and adds it to the `andOperands` array.
 * If a property has an array of values it will treat it as a OneOf (IN) within the overall AND query.
 *
 * @param eb The ExpressionBuilder from the query.
 * @param andOperands The array of AND operands to append to.
 * @param filter The filter to be evaluated.
 */
function processFilter<DB = DwnDatabaseType, TB extends keyof DB = keyof DB>(
  eb: ExpressionBuilder<DB, TB>,
  andOperands: OperandExpression<SqlBool>[],
  filter: Filter
): void {
  for (const property in filter) {
    const value = filter[property];
    const column = new DynamicModule().ref(property);
    if (Array.isArray(value)) { // OneOfFilter
      andOperands.push(eb(column, 'in', value));
    } else if (typeof value === 'object') { // RangeFilter
      // Detect prefix-style range filters created by `constructPrefixFilterAsRangeFilter`
      // which uses `{ gte: prefix, lt: prefix + '\uffff' }`. The U+FFFF sentinel does not
      // sort correctly under ICU/libc collation rules (e.g. PostgreSQL's en_US.UTF-8),
      // so we convert these to a collation-safe SQL LIKE expression.
      if (isPrefixRangeFilter(value)) {
        const prefix = escapeLikePattern(value.gte as string);
        andOperands.push(sql`${sql.ref(property)} LIKE ${prefix + '%'}`);
        continue;
      }

      if (value.gt) {
        andOperands.push(eb(column, '>', sanitizedValue(value.gt)));
      }
      if (value.gte) {
        andOperands.push(eb(column, '>=', sanitizedValue(value.gte)));
      }
      if (value.lt) {
        andOperands.push(eb(column, '<', sanitizedValue(value.lt)));
      }
      if (value.lte) {
        andOperands.push(eb(column, '<=', sanitizedValue(value.lte)));
      }
    } else { // EqualFilter
      andOperands.push(eb(column, '=', sanitizedValue(value)));
    }
  }
}

/**
 * Returns `true` if the given RangeFilter matches the pattern produced by
 * `constructPrefixFilterAsRangeFilter`: `{ gte: <prefix>, lt: <prefix> + '\uffff' }`.
 */
function isPrefixRangeFilter(value: Record<string, unknown>): boolean {
  if (typeof value.gte !== 'string' || typeof value.lt !== 'string') {
    return false;
  }
  // Only two keys: gte and lt (no gt, lte, or other properties)
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('gte') || !keys.includes('lt')) {
    return false;
  }
  return value.lt === value.gte + '\uffff';
}

/**
 * Escapes SQL LIKE meta-characters (`%`, `_`) in the given string so that
 * they are matched literally.
 */
function escapeLikePattern(input: string): string {
  return input.replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Processes each property in the tags filter as an AND operand and adds it to the `andOperands` array.
 * If a property has an array of values it will treat it as a OneOf (IN) within the overall AND query.
 *
 * @param eb The ExpressionBuilder from the query.
 * @param andOperands The array of AND operands to append to.
 * @param tag The tags filter to be evaluated.
 */
function processTags<DB = DwnDatabaseType, TB extends keyof DB = keyof DB>(
  _eb: ExpressionBuilder<DB, TB>,
  andOperands: OperandExpression<SqlBool>[],
  tags: Filter
): void {

  for (const property in tags) {
    andOperands.push(sql<SqlBool>`exists (
      select 1
      from ${sql.table('messageStoreRecordsTags')}
      where ${sql.ref('messageStoreRecordsTags.messageInsertId')} = ${sql.ref('messageStoreMessages.id')}
        and ${sql.ref('messageStoreRecordsTags.tag')} = ${property}
        and ${tagValuePredicate(tags[property])}
    )`);
  }
}

function tagValuePredicate(value: Filter[string]): RawBuilder<SqlBool> {
  if (Array.isArray(value)) {
    const sanitizedValues = value.map((item) => sanitizedValue(item));
    const numberValues = sanitizedValues.filter((item): item is number => typeof item === 'number');
    const stringValues = sanitizedValues.filter((item): item is string => typeof item === 'string');
    const operands: RawBuilder<SqlBool>[] = [];

    if (numberValues.length > 0) {
      operands.push(sql<SqlBool>`${sql.ref('messageStoreRecordsTags.valueNumber')} in (${sql.join(numberValues)})`);
    }
    if (stringValues.length > 0) {
      operands.push(sql<SqlBool>`${sql.ref('messageStoreRecordsTags.valueString')} in (${sql.join(stringValues)})`);
    }

    return operands.length === 0 ? sql<SqlBool>`false` : sql<SqlBool>`(${sql.join(operands, sql` or `)})`;
  }

  if (typeof value === 'object') {
    if (isPrefixRangeFilter(value)) {
      const prefix = escapeLikePattern(value.gte as string);
      return sql<SqlBool>`${sql.ref('messageStoreRecordsTags.valueString')} LIKE ${prefix + '%'}`;
    }

    const operands: RawBuilder<SqlBool>[] = [];
    if (value.gt) {
      operands.push(tagRangePredicate('>', value.gt));
    }
    if (value.gte) {
      operands.push(tagRangePredicate('>=', value.gte));
    }
    if (value.lt) {
      operands.push(tagRangePredicate('<', value.lt));
    }
    if (value.lte) {
      operands.push(tagRangePredicate('<=', value.lte));
    }

    return operands.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`(${sql.join(operands, sql` and `)})`;
  }

  const sanitized = sanitizedValue(value);
  return typeof sanitized === 'number'
    ? sql<SqlBool>`${sql.ref('messageStoreRecordsTags.valueNumber')} = ${sanitized}`
    : sql<SqlBool>`${sql.ref('messageStoreRecordsTags.valueString')} = ${sanitized}`;
}

function tagRangePredicate(operator: '>' | '>=' | '<' | '<=', value: string | number): RawBuilder<SqlBool> {
  return typeof value === 'number'
    ? sql<SqlBool>`${sql.ref('messageStoreRecordsTags.valueNumber')} ${sql.raw(operator)} ${value}`
    : sql<SqlBool>`${sql.ref('messageStoreRecordsTags.valueString')} ${sql.raw(operator)} ${String(value)}`;
}
