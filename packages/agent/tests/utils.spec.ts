import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import {
  getDwnServiceEndpointUrls,
  getPaginationCursor,
  getRecordAuthor,
  getRecordMessageCid,
  getRecordProtocolRole,
  isRecordsWrite,
  mapConcurrent,
  mapConcurrentSettled,
  pollWithTtl,
} from '../src/utils.js';

import { DateSort, DwnInterfaceName, DwnMethodName, Jws, Message, TestDataGenerator } from '@enbox/dwn-sdk-js';

describe('Utils', () => {
  beforeEach(() => {
    mock.restore();
  });

  afterAll(() => {
    mock.restore();
  });

  describe('getPaginationCursor', () => {
    it('should return a PaginationCursor object', async () => {
      // create a RecordWriteMessage object which is published
      const { message } = await TestDataGenerator.generateRecordsWrite({
        published: true,
      });

      const messageCid = await Message.getCid(message);

      // Published Ascending DateSort will get the datePublished as the cursor value
      const datePublishedAscendingCursor = await getPaginationCursor(message, DateSort.PublishedAscending);
      expect(datePublishedAscendingCursor).toEqual({
        value: message.descriptor.datePublished,
        messageCid,
      });

      // Published Descending DateSort will get the datePublished as the cursor value
      const datePublishedDescendingCursor = await getPaginationCursor(message, DateSort.PublishedDescending);
      expect(datePublishedDescendingCursor).toEqual({
        value: message.descriptor.datePublished,
        messageCid,
      });

      // Created Ascending DateSort will get the dateCreated as the cursor value
      const dateCreatedAscendingCursor = await getPaginationCursor(message, DateSort.CreatedAscending);
      expect(dateCreatedAscendingCursor).toEqual({
        value: message.descriptor.dateCreated,
        messageCid,
      });

      // Created Descending DateSort will get the dateCreated as the cursor value
      const dateCreatedDescendingCursor = await getPaginationCursor(message, DateSort.CreatedDescending);
      expect(dateCreatedDescendingCursor).toEqual({
        value: message.descriptor.dateCreated,
        messageCid,
      });
    });

    it('should fail for DateSort with PublishedAscending or PublishedDescending if the record is not published', async () => {
      // create a RecordWriteMessage object which is not published
      const { message } = await TestDataGenerator.generateRecordsWrite();

      // Published Ascending DateSort will get the datePublished as the cursor value
      try {
        await getPaginationCursor(message, DateSort.PublishedAscending);
        throw new Error('Expected getPaginationCursor to throw an error');
      } catch (error: any) {
        expect(error.message).toContain('The dateCreated or datePublished property is missing from the record descriptor.');
      }
    });
  });

  describe('getRecordMessageCid', () => {
    it('should get the CID of a RecordsWriteMessage', async () => {
      // create a RecordWriteMessage object
      const { message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);

      const messageCidFromFunction = await getRecordMessageCid(message);
      expect(messageCidFromFunction).toBe(messageCid);
    });
  });

  describe('getRecordAuthor', () => {
    it('should get the author of a RecordsWriteMessage', async () => {
      // create a RecordsWriteMessage object
      const { message: recordsWriteMessage, author: recordsWriteAuthor } = await TestDataGenerator.generateRecordsWrite();

      const writeAuthorFromFunction = getRecordAuthor(recordsWriteMessage);
      expect(writeAuthorFromFunction).toBeDefined();
      expect(writeAuthorFromFunction!).toBe(recordsWriteAuthor.did);

      // create a RecordsDeleteMessage
      const { message: recordsDeleteMessage, author: recordsDeleteAuthor } = await TestDataGenerator.generateRecordsDelete();

      const deleteAuthorFromFunction = getRecordAuthor(recordsDeleteMessage);
      expect(deleteAuthorFromFunction).toBeDefined();
      expect(deleteAuthorFromFunction!).toBe(recordsDeleteAuthor.did);
    });
  });

  describe('getRecordProtocolRole', () => {
    it('gets a protocol role from a RecordsWrite', async () => {
      const recordsWrite = await TestDataGenerator.generateRecordsWrite({ protocolRole: 'some-role' });
      const role = getRecordProtocolRole(recordsWrite.message);
      expect(role).toBe('some-role');
    });

    it('gets a protocol role from a RecordsDelete', async () => {
      const recordsDelete = await TestDataGenerator.generateRecordsDelete({ protocolRole: 'some-role' });
      const role = getRecordProtocolRole(recordsDelete.message);
      expect(role).toBe('some-role');
    });

    it('returns undefined if no role is defined', async () => {
      const recordsWrite = await TestDataGenerator.generateRecordsWrite();
      const writeRole = getRecordProtocolRole(recordsWrite.message);
      expect(writeRole).toBeUndefined();

      const recordsDelete = await TestDataGenerator.generateRecordsDelete();
      const deleteRole = getRecordProtocolRole(recordsDelete.message);
      expect(deleteRole).toBeUndefined();
    });

    it('returns undefined if decodedObject is undefined', async () => {
      spyOn(Jws, 'decodePlainObjectPayload').mockReturnValue(undefined);
      const recordsWrite = await TestDataGenerator.generateRecordsWrite();
      const writeRole = getRecordProtocolRole(recordsWrite.message);
      expect(writeRole).toBeUndefined();
    });
  });

  describe('isRecordsWrite', () => {
    it('should return true for a valid RecordsWrite object', () => {
      const obj = {
        message: {
          descriptor: {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Write,
          },
        },
      };
      expect(isRecordsWrite(obj)).toBe(true);
    });

    it('should return false for null', () => {
      expect(isRecordsWrite(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isRecordsWrite(undefined)).toBe(false);
    });

    it('should return false for a non-object', () => {
      expect(isRecordsWrite('string')).toBe(false);
      expect(isRecordsWrite(42)).toBe(false);
    });

    it('should return false for an object without message', () => {
      expect(isRecordsWrite({})).toBe(false);
    });

    it('should return false for an object with non-object message', () => {
      expect(isRecordsWrite({ message: 'not-object' })).toBe(false);
    });

    it('should return false for RecordsDelete', () => {
      const obj = {
        message: {
          descriptor: {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Delete,
          },
        },
      };
      expect(isRecordsWrite(obj)).toBe(false);
    });

    it('should return false for ProtocolsConfigure', () => {
      const obj = {
        message: {
          descriptor: {
            interface : DwnInterfaceName.Protocols,
            method    : DwnMethodName.Configure,
          },
        },
      };
      expect(isRecordsWrite(obj)).toBe(false);
    });
  });

  // `concatenateUrl` moved to `@enbox/common`; its tests now live in
  // `packages/common/tests/url.test.ts` (a superset of the cases that
  // were here).

  describe('pollWithTtl', () => {
    it('should resolve with response when fetch returns ok', async () => {
      const mockResponse = new Response('ok', { status: 200 });
      const fetchFn = mock(() => Promise.resolve(mockResponse));

      const result = await pollWithTtl(fetchFn, 100, 5000);
      expect(result).toBe(mockResponse);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('should resolve with null when TTL is reached', async () => {
      const mockResponse = new Response('not ok', { status: 404 });
      const fetchFn = mock(() => Promise.resolve(mockResponse));

      // Very short TTL so it expires quickly.
      const result = await pollWithTtl(fetchFn, 50, 1);
      expect(result).toBeNull();
    });

    it('should resolve with null when aborted', async () => {
      const mockResponse = new Response('not ok', { status: 404 });
      const fetchFn = mock(() => Promise.resolve(mockResponse));
      const abortController = new AbortController();

      // Abort immediately.
      setTimeout(() => abortController.abort(), 10);

      const result = await pollWithTtl(fetchFn, 100, 30000, abortController.signal);
      expect(result).toBeNull();
    });

    it('should reject when fetch function throws', async () => {
      const fetchFn = mock(() => Promise.reject(new Error('network error')));

      await expect(pollWithTtl(fetchFn, 100, 5000)).rejects.toThrow('network error');
    });
  });

  describe('getDwnServiceEndpointUrls', () => {
    it('should return service endpoint URLs from a DID document', async () => {
      const mockDereferencer = {
        dereference: mock(() => Promise.resolve({
          dereferencingMetadata : {},
          contentStream         : {
            id              : 'did:example:alice#dwn',
            type            : 'DecentralizedWebNode',
            serviceEndpoint : ['https://dwn.example.com'],
          },
        })),
      };

      const urls = await getDwnServiceEndpointUrls('did:example:alice', mockDereferencer as any);
      expect(urls).toEqual(['https://dwn.example.com']);
    });

    it('should normalize and deduplicate service endpoint URLs', async () => {
      const mockDereferencer = {
        dereference: mock(() => Promise.resolve({
          dereferencingMetadata : {},
          contentStream         : {
            id              : 'did:example:alice#dwn',
            type            : 'DecentralizedWebNode',
            serviceEndpoint : [
              'https://DWN.EXAMPLE.com/dwn/',
              'https://dwn.example.com/dwn',
              'https://dwn.example.com/DWN/',
              'https://dwn.example.com:443/root/',
              'https://dwn.example.com/root',
            ],
          },
        })),
      };

      const urls = await getDwnServiceEndpointUrls('did:example:alice', mockDereferencer as any);
      expect(urls).toEqual([
        'https://dwn.example.com/dwn',
        'https://dwn.example.com/DWN',
        'https://dwn.example.com/root',
      ]);
    });

    it('should return empty array when service endpoint is empty', async () => {
      const mockDereferencer = {
        dereference: mock(() => Promise.resolve({
          dereferencingMetadata : {},
          contentStream         : {
            id              : 'did:example:alice#dwn',
            type            : 'DecentralizedWebNode',
            serviceEndpoint : [],
          },
        })),
      };

      const urls = await getDwnServiceEndpointUrls('did:example:alice', mockDereferencer as any);
      expect(urls).toEqual([]);
    });

    it('should throw when dereferencing fails', async () => {
      const mockDereferencer = {
        dereference: mock(() => Promise.resolve({
          dereferencingMetadata : { error: 'notFound' },
          contentStream         : null,
        })),
      };

      await expect(
        getDwnServiceEndpointUrls('did:example:alice', mockDereferencer as any)
      ).rejects.toThrow('Failed to dereference');
    });

    it('should return empty array for non-DWN service', async () => {
      const mockDereferencer = {
        dereference: mock(() => Promise.resolve({
          dereferencingMetadata : {},
          contentStream         : {
            id              : 'did:example:alice#other',
            type            : 'OtherService',
            serviceEndpoint : 'https://other.example.com',
          },
        })),
      };

      const urls = await getDwnServiceEndpointUrls('did:example:alice', mockDereferencer as any);
      expect(urls).toEqual([]);
    });

    it('should handle string service endpoint', async () => {
      const mockDereferencer = {
        dereference: mock(() => Promise.resolve({
          dereferencingMetadata : {},
          contentStream         : {
            id              : 'did:example:alice#dwn',
            type            : 'DecentralizedWebNode',
            serviceEndpoint : 'https://dwn.example.com',
          },
        })),
      };

      const urls = await getDwnServiceEndpointUrls('did:example:alice', mockDereferencer as any);
      expect(urls).toEqual(['https://dwn.example.com']);
    });
  });

  describe('mapConcurrent', () => {
    it('should preserve input order in the output array', async () => {
      const input = [3, 1, 4, 1, 5, 9, 2, 6, 5];
      const output = await mapConcurrent(input, 3, async (n) => {
        // Stagger so that earlier-indexed items intentionally finish later.
        await new Promise((resolve) => setTimeout(resolve, n * 5));
        return n * 2;
      });
      expect(output).toEqual(input.map((n) => n * 2));
    });

    it('should return an empty array for empty input', async () => {
      const fn = mock(async (n: number) => n);
      const result = await mapConcurrent([], 4, fn);
      expect(result).toEqual([]);
      expect(fn).not.toHaveBeenCalled();
    });

    it('should never exceed the configured concurrency limit', async () => {
      const concurrency = 3;
      let inFlight = 0;
      let observedMax = 0;
      const items = Array.from({ length: 20 }, (_, i) => i);

      const result = await mapConcurrent(items, concurrency, async (n) => {
        inFlight++;
        if (inFlight > observedMax) {
          observedMax = inFlight;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight--;
        return n;
      });

      expect(result).toEqual(items);
      expect(observedMax).toBeLessThanOrEqual(concurrency);
      expect(observedMax).toBe(concurrency);
    });

    it('should reject on the first task rejection (Promise.all-like semantics)', async () => {
      const fn = mock(async (n: number) => {
        if (n === 1) {
          throw new Error('boom');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return n;
      });

      await expect(mapConcurrent([0, 1, 2, 3], 2, fn)).rejects.toThrow('boom');
    });

    it('should throw on non-positive-integer concurrency', async () => {
      await expect(mapConcurrent([1, 2], 0, async (n) => n)).rejects.toThrow(/concurrency/);
      await expect(mapConcurrent([1, 2], -1, async (n) => n)).rejects.toThrow(/concurrency/);
      await expect(mapConcurrent([1, 2], 1.5, async (n) => n)).rejects.toThrow(/concurrency/);
    });

    it('should pass the index as the second argument to the mapper', async () => {
      const seenIndices: number[] = [];
      await mapConcurrent(['a', 'b', 'c'], 2, async (_value, index) => {
        seenIndices.push(index);
        return index;
      });
      expect(seenIndices.sort()).toEqual([0, 1, 2]);
    });
  });

  describe('mapConcurrentSettled', () => {
    it('should never reject — capturing per-task outcomes', async () => {
      const items = [0, 1, 2, 3];
      const results = await mapConcurrentSettled(items, 2, async (n) => {
        if (n % 2 === 0) {
          return n * 10;
        }
        throw new Error(`odd-${n}`);
      });

      expect(results).toHaveLength(items.length);
      expect(results[0]).toEqual({ status: 'fulfilled', value: 0 });
      expect(results[1]).toMatchObject({ status: 'rejected' });
      expect((results[1] as PromiseRejectedResult).reason.message).toBe('odd-1');
      expect(results[2]).toEqual({ status: 'fulfilled', value: 20 });
      expect(results[3]).toMatchObject({ status: 'rejected' });
    });

    it('should respect the concurrency limit', async () => {
      const concurrency = 4;
      let inFlight = 0;
      let observedMax = 0;
      const items = Array.from({ length: 30 }, (_, i) => i);

      await mapConcurrentSettled(items, concurrency, async () => {
        inFlight++;
        if (inFlight > observedMax) {
          observedMax = inFlight;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
      });

      expect(observedMax).toBeLessThanOrEqual(concurrency);
      expect(observedMax).toBe(concurrency);
    });
  });
});
