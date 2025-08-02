import { Filter } from '@tbd54566975/dwn-sdk-js';
import { DynamicModule, ExpressionBuilder, OperandExpression, SelectQueryBuilder, SqlBool } from 'kysely';
import { sanitizeFiltersAndSeparateTags, sanitizedValue } from './sanitize.js';
import { DwnDatabaseType } from '../types.js';

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
  for (let property in filter) {
    const value = filter[property];
    const column = new DynamicModule().ref(property);
    if (Array.isArray(value)) { // OneOfFilter
      andOperands.push(eb(column, 'in', value));
    } else if (typeof value === 'object') { // RangeFilter
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
 * Processes each property in the tags filter as an AND operand and adds it to the `andOperands` array.
 * If a property has an array of values it will treat it as a OneOf (IN) within the overall AND query.
 *
 * @param eb The ExpressionBuilder from the query.
 * @param andOperands The array of AND operands to append to.
 * @param tag The tags filter to be evaluated.
 */
function processTags<DB = DwnDatabaseType, TB extends keyof DB = keyof DB>(
  eb: ExpressionBuilder<DB, TB>,
  andOperands: OperandExpression<SqlBool>[],
  tags: Filter
): void {

  const tagColumn = new DynamicModule().ref('tag');
  const valueNumber = new DynamicModule().ref('valueNumber');
  const valueString = new DynamicModule().ref('valueString');

  // process each tag and add it to the andOperands from the rest of the filters
  for (let property in tags) {
    andOperands.push(eb(tagColumn, '=', property));
    const value = tags[property];
    if (Array.isArray(value)) { // OneOfFilter
      if (value.some(val => typeof val === 'number')) {
        andOperands.push(eb(valueNumber, 'in', value));
      } else {
        andOperands.push(eb(valueString, 'in', value.map(v => String(v))));
      }
    } else if (typeof value === 'object') { // RangeFilter
      if (value.gt) {
        if (typeof value.gt === 'number') {
          andOperands.push(eb(valueNumber, '>', value.gt));
        } else {
          andOperands.push(eb(valueString, '>', String(value.gt)));
        }
      }
      if (value.gte) {
        if (typeof value.gte === 'number') {
          andOperands.push(eb(valueNumber, '>=', value.gte));
        } else {
          andOperands.push(eb(valueString, '>=', String(value.gte)));
        }
      }
      if (value.lt) {
        if (typeof value.lt === 'number') {
          andOperands.push(eb(valueNumber, '<', value.lt));
        } else {
          andOperands.push(eb(valueString, '<', String(value.lt)));
        }
      }
      if (value.lte) {
        if (typeof value.lte === 'number') {
          andOperands.push(eb(valueNumber, '<=', value.lte));
        } else {
          andOperands.push(eb(valueString, '<=', String(value.lte)));
        }
      }
    } else { // EqualFilter
      if (typeof value === 'number') {
        andOperands.push(eb(valueNumber, '=', value));
      } else {
        andOperands.push(eb(valueString, '=', String(value)));
      }
    }
  }
}