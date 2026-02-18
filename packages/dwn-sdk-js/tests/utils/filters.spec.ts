import type { Filter } from '../../src/types/query-types.js';

import { TestDataGenerator } from './test-data-generator.js';
import { Time } from '../../src/utils/time.js';
import { FilterSelector, FilterUtility } from '../../src/utils/filter.js';

import { describe, expect, it } from 'bun:test';

describe('filters util', () => {
  describe('FilterUtility', () => {
    describe ('filter type', () => {
      const filter: Filter = {
        equal    : 'to',
        oneOf    : [ 'these', 'items' ],
        range    : { gte: 10, lte: 20 },
        rangeGT  : { gt: 10 },
        rangeGTE : { gte: 10 },
        rangeLT  : { lt: 20 },
        rangeLTE : { lte: 20 },
      };

      it('isEqualFilter', async () => {
        const { equal, oneOf, range } = filter;
        expect(FilterUtility.isEqualFilter(equal)).toBe(true);
        expect(FilterUtility.isEqualFilter(oneOf)).toBe(false);
        expect(FilterUtility.isEqualFilter(range)).toBe(false);
      });;

      it('isRangeFilter', async () => {
        const { equal, oneOf, range, rangeGT, rangeGTE, rangeLT, rangeLTE } = filter;
        expect(FilterUtility.isRangeFilter(range)).toBe(true);
        expect(FilterUtility.isRangeFilter(rangeGT)).toBe(true);
        expect(FilterUtility.isRangeFilter(rangeGTE)).toBe(true);
        expect(FilterUtility.isRangeFilter(rangeLT)).toBe(true);
        expect(FilterUtility.isRangeFilter(rangeLTE)).toBe(true);
        expect(FilterUtility.isRangeFilter(oneOf)).toBe(false);
        expect(FilterUtility.isRangeFilter(equal)).toBe(false);
      });

      it('isOneOfFilter', async () => {
        const { equal, oneOf, range } = filter;
        expect(FilterUtility.isOneOfFilter(oneOf)).toBe(true);
        expect(FilterUtility.isOneOfFilter(equal)).toBe(false);
        expect(FilterUtility.isOneOfFilter(range)).toBe(false);
      });
    });

    describe('matchFilter', () => {
      it('should match with EqualFilter', async () => {
        const filters = [{ foo: 'bar' }];
        expect(FilterUtility.matchAnyFilter({ foo: 'bar' }, filters)).toBe(true);
        expect(FilterUtility.matchAnyFilter({ foo: 'bar', bar: 'baz' }, filters)).toBe(true);
        expect(FilterUtility.matchAnyFilter({ bar: 'baz' }, filters)).toBe(false);
      });

      it('should not match partial values with an EqualFilter', async () => {
        const filters = [{ foo: 'bar' }];
        expect(FilterUtility.matchAnyFilter({ foo: 'barbaz' }, filters)).toBe(false);
      });

      it('should match with OneOfFilter', async () => {
        const filters = [{
          a: [ 'a', 'b' ]
        }];

        expect(FilterUtility.matchAnyFilter({ 'a': 'a' }, filters)).toBe(true);
        expect(FilterUtility.matchAnyFilter({ 'a': 'b' }, filters)).toBe(true);
        expect(FilterUtility.matchAnyFilter({ 'a': 'c' }, filters)).toBe(false);
      });

      it('should match string within a RangeFilter', async () => {
        const gteFilter = [{
          dateCreated: {
            gte: Time.createTimestamp({ year: 2023, month: 1, day: 15 })
          }
        }];

        // test the equal to the desired range.
        expect(FilterUtility.matchAnyFilter({
          dateCreated: Time.createTimestamp({ year: 2023, month: 1, day: 15 })
        }, gteFilter)).toBe(true);

        // test greater than the desired range.
        expect(FilterUtility.matchAnyFilter({
          dateCreated: Time.createTimestamp({ year: 2023, month: 1, day: 16 })
        }, gteFilter)).toBe(true);

        // test less than desired range.
        expect(FilterUtility.matchAnyFilter({
          dateCreated: Time.createTimestamp({ year: 2023, month: 1, day: 10 })
        }, gteFilter)).toBe(false);

        const gtFilter = [{
          dateCreated: {
            gt: Time.createTimestamp({ year: 2023, month: 1, day: 15 })
          }
        }];
        // test the equal to
        expect(FilterUtility.matchAnyFilter({
          dateCreated: Time.createTimestamp({ year: 2023, month: 1, day: 15 })
        }, gtFilter)).toBe(false);

        // test greater than.
        expect(FilterUtility.matchAnyFilter({
          dateCreated: Time.createTimestamp({ year: 2023, month: 1, day: 16 })
        }, gtFilter)).toBe(true);

        const lteFilter = [{
          dateCreated: {
            lte: Time.createTimestamp({ year: 2023, month: 1, day: 15 })
          }
        }];

        // test the equal to the desired range.
        expect(FilterUtility.matchAnyFilter({
          dateCreated: Time.createTimestamp({ year: 2023, month: 1, day: 15 })
        }, lteFilter)).toBe(true);

        // test less than desired range.
        expect(FilterUtility.matchAnyFilter({
          dateCreated: Time.createTimestamp({ year: 2023, month: 1, day: 13 })
        }, lteFilter)).toBe(true);

        // test greater than desired range.
        expect(FilterUtility.matchAnyFilter({
          dateCreated: Time.createTimestamp({ year: 2023, month: 1, day: 16 })
        }, lteFilter)).toBe(false);

        const ltFilter = [{
          dateCreated: {
            lt: Time.createTimestamp({ year: 2023, month: 1, day: 15 })
          }
        }];

        // checks less than
        expect(FilterUtility.matchAnyFilter({
          dateCreated: Time.createTimestamp({ year: 2023, month: 1, day: 14 })
        }, ltFilter)).toBe(true);

        // checks equal to
        expect(FilterUtility.matchAnyFilter({
          dateCreated: Time.createTimestamp({ year: 2023, month: 1, day: 15 })
        }, ltFilter)).toBe(false);
      });

      it('should match suffixed RangeFilter', async () => {
        const filters = [{
          foo: {
            lte: 'bar'
          }
        }];

        expect(FilterUtility.matchAnyFilter({ foo: 'bar' }, filters)).toBe(true);
        expect(FilterUtility.matchAnyFilter({ foo: 'barbaz' }, filters)).toBe(false);
      });

      it('should match multiple properties', async () => {
        const filters = [{
          foo : 'bar',
          bar : 'baz'
        }];
        expect(FilterUtility.matchAnyFilter({ foo: 'bar', bar: 'baz' }, filters)).toBe(true);
        expect(FilterUtility.matchAnyFilter({ foo: 'baz', bar: 'baz' }, filters)).toBe(false);
      });

      it('should match with multiple filters', async () => {
        const filters:Filter[] = [{
          foo : 'bar',
          bar : 'baz'
        },{
          foobar: 'baz'
        }];

        // match first filter
        expect(FilterUtility.matchAnyFilter({ foo: 'bar', bar: 'baz' }, filters)).toBe(true);
        // match second filter
        expect(FilterUtility.matchAnyFilter({ foobar: 'baz', foo: 'bar' }, filters)).toBe(true);
        // control no match
        expect(FilterUtility.matchAnyFilter({ foo: 'bar' }, filters)).toBe(false);
      });

      it('should match anything if an empty array or empty filters are provided', async () => {
        expect(FilterUtility.matchAnyFilter({ foo: 'bar', bar: 'baz' }, [])).toBe(true);
        expect(FilterUtility.matchAnyFilter({ foobar: 'baz', foo: 'bar' }, [{}])).toBe(true);
      });

      describe('booleans', () => {
        it('treats strings and boolean EqualFilter differently', async () => {

          const filters = [{
            foo: true
          }];

          expect(FilterUtility.matchAnyFilter({ foo: true }, filters)).toBe(true);
          expect(FilterUtility.matchAnyFilter({ foo: 'true' }, filters)).toBe(false);
        });

        it('should return records that match provided boolean equality filter', async () => {
          const boolTrueItem = {
            schema    : 'schema',
            published : true,
          };

          const boolFalseItem = {
            schema    : 'schema',
            published : false,
          };

          // control
          expect(FilterUtility.matchAnyFilter(boolTrueItem, [{ published: true }])).toBe(true);
          expect(FilterUtility.matchAnyFilter(boolTrueItem, [{ published: false }])).toBe(false);
          expect(FilterUtility.matchAnyFilter(boolFalseItem, [{ published: false }])).toBe(true);
          expect(FilterUtility.matchAnyFilter(boolFalseItem, [{ published: true }])).toBe(false);
        });
      });

      describe('numbers', () => {
      });

      describe('array value types', () => {
        it('strings', async () => {
          const taggedItem = {
            id   : TestDataGenerator.randomString(10),
            tags : ['tag1', 'tag2', 'tag3']
          };

          expect(FilterUtility.matchAnyFilter(taggedItem, [{ tags: 'tag2' }])).toBe(true);
          expect(FilterUtility.matchAnyFilter(taggedItem, [{ tags: 'tag4' }])).toBe(false);
        });

        it('number', async () => {
          const taggedItem = {
            id   : TestDataGenerator.randomString(10),
            tags : [ 1, 2, 3 ]
          };

          expect(FilterUtility.matchAnyFilter(taggedItem, [{ tags: 2 }])).toBe(true);
          expect(FilterUtility.matchAnyFilter(taggedItem, [{ tags: 4 }])).toBe(false);
        });
      });
    });

    describe('convertRangeCriterion',() => {
      it('converts `from` to `gte`', async () => {
        const inputFilter = {
          from: 'from-value',
        };
        expect(FilterUtility.convertRangeCriterion(inputFilter)).toEqual({ gte: 'from-value' });
      });

      it('converts `to` to `lt` ', async () => {
        const inputFilter = {
          to: 'to-value',
        };
        expect(FilterUtility.convertRangeCriterion(inputFilter)).toEqual({ lt: 'to-value' });
      });

      it('converts `from` and `to` to `gte` and `lt`, respectively', async () => {
        const inputFilter = {
          from : 'from-value',
          to   : 'to-value'
        };
        expect(FilterUtility.convertRangeCriterion(inputFilter)).toEqual({ gte: 'from-value', lt: 'to-value' });
      });
    });

    describe('constructPrefixFilterAsRangeFilter', () => {
      it('appends an ending delimiter to the lt value in a RangeFilter object', async () => {
        // This represents a last possible character when sorting in lexicographic order
        const delimiter = '\uffff';
        const prefix = 'someString';
        const filter = FilterUtility.constructPrefixFilterAsRangeFilter(prefix);
        const ltString = filter.lt! as string;
        expect(ltString.startsWith(prefix)).toBe(true);
        expect(ltString.endsWith(delimiter)).toBe(true);
      });

      it('should match prefixed RangeFilter', async () => {
        const prefixFilter = FilterUtility.constructPrefixFilterAsRangeFilter('foo');
        expect(FilterUtility.matchFilter({ value: 'foobar' }, { value: prefixFilter })).toBe(true);
      });
    });

    describe('reduceFilter', () => {
      it('returns incoming filter if it only has one or no properties', async () => {
        expect(FilterSelector.reduceFilter({ some: 'property' })).toEqual({ some: 'property' });
        expect(FilterSelector.reduceFilter({})).toEqual({});
      });

      it('prioritizes known properties', async () => {
        // recordId
        const inputFilter:Filter = {
          recordId     : 'some-record-id',
          attester     : 'some-attester',
          parentId     : 'some-parent-id',
          recipient    : 'some-recipient',
          contextId    : 'some-context-id',
          protocolPath : 'some-protocol-path',
          schema       : 'some-schema',
          protocol     : 'some-protocol',
          some         : 'property'
        };

        // go through in order of priority deleting the property after checking for it
        expect(FilterSelector.reduceFilter(inputFilter)).toEqual({ recordId: 'some-record-id' });
        delete inputFilter.recordId;

        expect(FilterSelector.reduceFilter(inputFilter)).toEqual({ attester: 'some-attester' });
        delete inputFilter.attester;

        expect(FilterSelector.reduceFilter(inputFilter)).toEqual({ parentId: 'some-parent-id' });
        delete inputFilter.parentId;

        expect(FilterSelector.reduceFilter(inputFilter)).toEqual({ recipient: 'some-recipient' });
        delete inputFilter.recipient;

        expect(FilterSelector.reduceFilter(inputFilter)).toEqual({ contextId: 'some-context-id' });
        delete inputFilter.contextId;

        expect(FilterSelector.reduceFilter(inputFilter)).toEqual({ protocolPath: 'some-protocol-path' });
        delete inputFilter.protocolPath;

        expect(FilterSelector.reduceFilter(inputFilter)).toEqual({ schema: 'some-schema' });
        delete inputFilter.schema;

        expect(FilterSelector.reduceFilter(inputFilter)).toEqual({ protocol: 'some-protocol' });
      });

      it('returns first filter if no known filters exist', async () => {
        const inputFilter = {
          foo : 'bar',
          bar : 'baz',
          baz : 'buzz'
        };

        expect(FilterSelector.reduceFilter(inputFilter)).toEqual({ foo: 'bar' });
      });
    });
  });
});