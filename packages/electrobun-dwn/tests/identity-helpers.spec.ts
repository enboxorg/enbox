import { describe, expect, it } from 'bun:test';

import {
  createResolutionErrorResult,
  errorMessage,
  normalizeEndpointList,
  normalizeOptionalString,
} from '../src/mainview/utils/identity-helpers.js';

describe('identity-helpers', () => {
  describe('normalizeEndpointList', () => {
    it('should return an empty array when called with undefined', () => {
      expect(normalizeEndpointList(undefined)).toEqual([]);
    });

    it('should return an empty array when called with a non-array value', () => {
      expect(normalizeEndpointList(null as unknown as string[])).toEqual([]);
      expect(normalizeEndpointList('not-an-array' as unknown as string[])).toEqual([]);
    });

    it('should return an empty array when all entries are whitespace', () => {
      expect(normalizeEndpointList(['  ', '\t', ''])).toEqual([]);
    });

    it('should trim entries and filter empties', () => {
      expect(normalizeEndpointList(['  http://a  ', '', '  http://b '])).toEqual([
        'http://a',
        'http://b',
      ]);
    });

    it('should deduplicate entries after trimming', () => {
      expect(normalizeEndpointList([
        'http://a',
        '  http://a  ',
        'http://b',
        'http://b',
      ])).toEqual(['http://a', 'http://b']);
    });

    it('should preserve order of first occurrence', () => {
      expect(normalizeEndpointList([
        'http://c',
        'http://a',
        'http://b',
        'http://a',
      ])).toEqual(['http://c', 'http://a', 'http://b']);
    });
  });

  describe('normalizeOptionalString', () => {
    it('should return undefined for undefined', () => {
      expect(normalizeOptionalString(undefined)).toBeUndefined();
    });

    it('should return undefined for null', () => {
      expect(normalizeOptionalString(null)).toBeUndefined();
    });

    it('should return undefined for empty string', () => {
      expect(normalizeOptionalString('')).toBeUndefined();
    });

    it('should return undefined for whitespace-only string', () => {
      expect(normalizeOptionalString('   ')).toBeUndefined();
    });

    it('should return undefined for non-string values', () => {
      expect(normalizeOptionalString(42)).toBeUndefined();
      expect(normalizeOptionalString(true)).toBeUndefined();
      expect(normalizeOptionalString({})).toBeUndefined();
    });

    it('should return trimmed string for valid input', () => {
      expect(normalizeOptionalString('  hello  ')).toBe('hello');
    });

    it('should return the string as-is when already trimmed', () => {
      expect(normalizeOptionalString('hello')).toBe('hello');
    });
  });

  describe('errorMessage', () => {
    it('should return the message property of an Error', () => {
      expect(errorMessage(new Error('test failure'))).toBe('test failure');
    });

    it('should return the message of an Error subclass', () => {
      expect(errorMessage(new TypeError('type mismatch'))).toBe('type mismatch');
    });

    it('should stringify a non-Error string', () => {
      expect(errorMessage('raw string')).toBe('raw string');
    });

    it('should stringify a number', () => {
      expect(errorMessage(404)).toBe('404');
    });

    it('should stringify null', () => {
      expect(errorMessage(null)).toBe('null');
    });

    it('should stringify undefined', () => {
      expect(errorMessage(undefined)).toBe('undefined');
    });
  });

  describe('createResolutionErrorResult', () => {
    it('should return a result with null didDocument', () => {
      const result = createResolutionErrorResult('some error');
      expect(result.didDocument).toBeNull();
    });

    it('should return empty didDocumentMetadata', () => {
      const result = createResolutionErrorResult('some error');
      expect(result.didDocumentMetadata).toEqual({});
    });

    it('should include error code and message in didResolutionMetadata', () => {
      const result = createResolutionErrorResult('could not resolve');
      expect(result.didResolutionMetadata).toEqual({
        error   : 'resolutionError',
        message : 'could not resolve',
      });
    });
  });
});
