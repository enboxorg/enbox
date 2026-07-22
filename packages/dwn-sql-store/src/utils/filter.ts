import type { Dialect } from '../dialect/dialect.js';
import type { DwnDatabaseType } from '../types.js';
import type { DynamicReferenceBuilder, ExpressionBuilder, OperandExpression, RawBuilder, SelectQueryBuilder, SqlBool } from 'kysely';
import type { EqualFilter, Filter, RangeFilter, SubtreeFilter } from '@enbox/dwn-sdk-js';

import { DynamicModule, sql } from 'kysely';
import { sanitizedValue, sanitizeFiltersAndSeparateTags } from './sanitize.js';

const SQL_LIKE_ESCAPE = String.fromCodePoint(92);

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
  query: SelectQueryBuilder<DB, TB, O>,
  dialect: Dialect,
): SelectQueryBuilder<DB, TB, O> {
  const sanitizedFilters = sanitizeFiltersAndSeparateTags(filters);

  return query.where((eb) =>
    // evaluate the filters as an OR expression.
    eb.or(sanitizedFilters.map(({ filter, tags }) => {
      // evaluate each filter + tags tuple as an AND expression.
      const andOperands: OperandExpression<SqlBool>[] = [];

      processFilter(eb, andOperands, filter, dialect);
      processTags(andOperands, tags, dialect);

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
  filter: Filter,
  dialect: Dialect,
): void {
  for (const property in filter) {
    const value = filter[property];
    const column = new DynamicModule().ref(property);
    if (Array.isArray(value)) { // OneOfFilter
      andOperands.push(eb(column, 'in', value));
    } else if (isSubtreeFilter(value)) {
      processSubtreeFilterProperty(andOperands, property, value, dialect);
    } else if (typeof value === 'object') { // RangeFilter
      processRangeFilterProperty(eb, andOperands, property, column, value);
    } else { // EqualFilter
      andOperands.push(eb(column, '=', sanitizedValue(value)));
    }
  }
}

/**
 * Adds a segment-aware subtree predicate for one indexed string property.
 */
function processSubtreeFilterProperty(
  andOperands: OperandExpression<SqlBool>[],
  property: string,
  value: SubtreeFilter,
  dialect: Dialect,
): void {
  andOperands.push(dialect.subtreePredicate(property, value.subtree));
}

/**
 * Processes a single `RangeFilter` property (the `typeof value === 'object'` branch of
 * {@link processFilter}) and appends the corresponding AND operand(s) to `andOperands`.
 *
 * @param eb The ExpressionBuilder from the query.
 * @param andOperands The array of AND operands to append to.
 * @param property The filter property name.
 * @param column The dynamic column reference for `property`.
 * @param value The RangeFilter value to be evaluated.
 */
function processRangeFilterProperty<DB = DwnDatabaseType, TB extends keyof DB = keyof DB>(
  eb: ExpressionBuilder<DB, TB>,
  andOperands: OperandExpression<SqlBool>[],
  property: string,
  column: DynamicReferenceBuilder<never>,
  value: RangeFilter
): void {
  // Detect prefix-style range filters created by `constructPrefixFilterAsRangeFilter`
  // which uses `{ gte: prefix, lt: prefix + '\uffff' }`. The U+FFFF sentinel does not
  // sort correctly under ICU/libc collation rules (e.g. PostgreSQL's en_US.UTF-8),
  // so we convert these to a collation-safe SQL LIKE expression.
  const prefixRangeFilterPrefix = getPrefixRangeFilterPrefix(value);
  if (prefixRangeFilterPrefix !== undefined) {
    const prefix = escapeLikePattern(prefixRangeFilterPrefix);
    andOperands.push(sql`${sql.ref(property)} LIKE ${prefix + '%'} ESCAPE ${'\\'}`);
    return;
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
}

/**
 * Returns the prefix if the given RangeFilter matches the pattern produced by
 * `constructPrefixFilterAsRangeFilter`: `{ gte: <prefix>, lt: <prefix> + '\uffff' }`.
 */
function getPrefixRangeFilterPrefix(value: object): string | undefined {
  const range = value as Record<string, unknown>;

  if (typeof range.gte !== 'string' || typeof range.lt !== 'string') {
    return undefined;
  }
  // Only two keys: gte and lt (no gt, lte, or other properties)
  const keys = Object.keys(range);
  if (keys.length !== 2 || !keys.includes('gte') || !keys.includes('lt')) {
    return undefined;
  }
  return range.lt === range.gte + '\uffff' ? range.gte : undefined;
}

function isSubtreeFilter(value: unknown): value is SubtreeFilter {
  return typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as Partial<SubtreeFilter>).subtree === 'string';
}

/**
 * Escapes SQL LIKE meta-characters (`%`, `_`) in the given string so that
 * they are matched literally.
 */
function escapeLikePattern(input: string): string {
  return input
    .split(SQL_LIKE_ESCAPE).join(`${SQL_LIKE_ESCAPE}${SQL_LIKE_ESCAPE}`)
    .split('%').join(`${SQL_LIKE_ESCAPE}%`)
    .split('_').join(`${SQL_LIKE_ESCAPE}_`);
}

/**
 * Processes each property in the tags filter as an AND operand and adds it to the `andOperands` array.
 * If a property has an array of values it will treat it as a OneOf (IN) within the overall AND query.
 *
 * @param andOperands The array of AND operands to append to.
 * @param tag The tags filter to be evaluated.
 */
function processTags(
  andOperands: OperandExpression<SqlBool>[],
  tags: Filter,
  dialect: Dialect,
): void {

  for (const property in tags) {
    andOperands.push(sql<SqlBool>`exists (
      select 1
      from ${sql.table('messageStoreRecordsTags')}
      where ${sql.ref('messageStoreRecordsTags.messageInsertId')} = ${sql.ref('messageStoreMessages.id')}
        and ${sql.ref('messageStoreRecordsTags.tag')} = ${property}
        and ${tagValuePredicate(tags[property], dialect)}
    )`);
  }
}

function tagValuePredicate(value: Filter[string], dialect: Dialect): RawBuilder<SqlBool> {
  if (Array.isArray(value)) {
    return tagOneOfPredicate(value);
  }

  if (typeof value === 'object') {
    return tagObjectPredicate(value, dialect);
  }

  return tagEqualPredicate(value);
}

function tagOneOfPredicate(values: EqualFilter[]): RawBuilder<SqlBool> {
  const sanitizedValues = values.map((item) => sanitizedValue(item));
  const numberValues = sanitizedValues.filter((item): item is number => typeof item === 'number');
  const stringValues = sanitizedValues.filter((item): item is string => typeof item === 'string');
  const operands: RawBuilder<SqlBool>[] = [];

  if (numberValues.length > 0) {
    operands.push(sql<SqlBool>`${sql.ref('messageStoreRecordsTags.valueNumber')} in (${sql.join(numberValues)})`);
  }
  if (stringValues.length > 0) {
    operands.push(sql<SqlBool>`${sql.ref('messageStoreRecordsTags.valueString')} in (${sql.join(stringValues)})`);
  }

  return joinTagPredicates(operands, 'or', false);
}

function tagObjectPredicate(value: RangeFilter | SubtreeFilter, dialect: Dialect): RawBuilder<SqlBool> {
  if (isSubtreeFilter(value)) {
    return dialect.subtreePredicate('messageStoreRecordsTags.valueString', value.subtree);
  }

  const prefixRangeFilterPrefix = getPrefixRangeFilterPrefix(value);
  if (prefixRangeFilterPrefix !== undefined) {
    const prefix = escapeLikePattern(prefixRangeFilterPrefix);
    return sql<SqlBool>`${sql.ref('messageStoreRecordsTags.valueString')} LIKE ${prefix + '%'} ESCAPE ${'\\'}`;
  }

  const operands: RawBuilder<SqlBool>[] = [];
  addTagRangePredicate(operands, '>', value.gt);
  addTagRangePredicate(operands, '>=', value.gte);
  addTagRangePredicate(operands, '<', value.lt);
  addTagRangePredicate(operands, '<=', value.lte);

  return joinTagPredicates(operands, 'and', true);
}

function tagEqualPredicate(value: EqualFilter): RawBuilder<SqlBool> {
  const sanitized = sanitizedValue(value);
  return typeof sanitized === 'number'
    ? sql<SqlBool>`${sql.ref('messageStoreRecordsTags.valueNumber')} = ${sanitized}`
    : sql<SqlBool>`${sql.ref('messageStoreRecordsTags.valueString')} = ${sanitized}`;
}

function addTagRangePredicate(operands: RawBuilder<SqlBool>[], operator: '>' | '>=' | '<' | '<=', value?: string | number): void {
  if (value !== undefined) {
    operands.push(tagRangePredicate(operator, value));
  }
}

function tagRangePredicate(operator: '>' | '>=' | '<' | '<=', value: string | number): RawBuilder<SqlBool> {
  return typeof value === 'number'
    ? sql<SqlBool>`${sql.ref('messageStoreRecordsTags.valueNumber')} ${sql.raw(operator)} ${value}`
    : sql<SqlBool>`${sql.ref('messageStoreRecordsTags.valueString')} ${sql.raw(operator)} ${String(value)}`;
}

function joinTagPredicates(operands: RawBuilder<SqlBool>[], operator: 'and' | 'or', emptyResult: boolean): RawBuilder<SqlBool> {
  if (operands.length === 0) {
    return emptyResult ? sql<SqlBool>`true` : sql<SqlBool>`false`;
  }

  const separator = operator === 'and' ? sql.raw(' and ') : sql.raw(' or ');
  return sql<SqlBool>`(${sql.join(operands, separator)})`;
}
