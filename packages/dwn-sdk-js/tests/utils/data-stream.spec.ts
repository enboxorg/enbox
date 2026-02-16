import chaiAsPromised from 'chai-as-promised';
import chai, { expect } from 'chai';

import { TestDataGenerator } from './test-data-generator.js';
import { DataStream, Encoder } from '../../src/index.js';

// extends chai to test promises
chai.use(chaiAsPromised);

describe('DataStream', () => {
  describe('fromObject() and toBytes()', () => {
    it('should round-trip an object through stream', async () => {
      const originalObject = {
        a: TestDataGenerator.randomString(32)
      };

      const stream = DataStream.fromObject(originalObject);
      const readBytes = await DataStream.toBytes(stream);
      const readObject = JSON.parse(Encoder.bytesToString(readBytes));
      expect(readObject.a).to.equal(originalObject.a);
    });
  });

  describe('toBytes()', () => {
    it('should return an empty Uint8Array for an empty stream', async () => {
      const stream = new ReadableStream({
        start(controller): void {
          controller.close();
        }
      });

      const result = await DataStream.toBytes(stream);
      expect(result).to.be.instanceOf(Uint8Array);
      expect(result.length).to.equal(0);
    });

    it('should handle a stream with many small chunks', async () => {
      const chunks = Array.from({ length: 100 }, (_, i) => new Uint8Array([i % 256]));
      let index = 0;
      const stream = new ReadableStream({
        pull(controller): void {
          if (index >= chunks.length) {
            controller.close();
            return;
          }
          controller.enqueue(chunks[index]);
          index++;
        }
      });

      const result = await DataStream.toBytes(stream);
      expect(result.length).to.equal(100);
      for (let i = 0; i < 100; i++) {
        expect(result[i]).to.equal(i % 256);
      }
    });

    it('should propagate errors from an errored stream', async () => {
      const stream = new ReadableStream({
        start(controller): void {
          controller.error(new Error('test error'));
        }
      });

      try {
        await DataStream.toBytes(stream);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).to.equal('test error');
      }
    });
  });

  describe('toObject()', () => {
    it('should parse a valid JSON stream into an object', async () => {
      const obj = { key: 'value', num: 42 };
      const stream = DataStream.fromObject(obj);
      const result = await DataStream.toObject(stream);
      expect(result).to.deep.equal(obj);
    });

    it('should throw for a stream containing invalid JSON', async () => {
      const invalidJson = new TextEncoder().encode('not valid json');
      const stream = DataStream.fromBytes(invalidJson);

      try {
        await DataStream.toObject(stream);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(Error);
      }
    });
  });

  describe('fromBytes()', () => {
    it('should produce multiple chunks for data larger than 100KB', async () => {
      const largeData = TestDataGenerator.randomBytes(250_000);
      const stream = DataStream.fromBytes(largeData);

      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }
        chunks.push(value);
      }

      // 250KB / 100KB chunks = 3 chunks (100K, 100K, 50K)
      expect(chunks.length).to.equal(3);
      expect(chunks[0].length).to.equal(100_000);
      expect(chunks[1].length).to.equal(100_000);
      expect(chunks[2].length).to.equal(50_000);
    });

    it('should produce a single chunk for data smaller than 100KB', async () => {
      const smallData = TestDataGenerator.randomBytes(50_000);
      const stream = DataStream.fromBytes(smallData);

      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }
        chunks.push(value);
      }

      expect(chunks.length).to.equal(1);
      expect(chunks[0].length).to.equal(50_000);
    });

    it('should handle an empty Uint8Array', async () => {
      const stream = DataStream.fromBytes(new Uint8Array(0));
      const result = await DataStream.toBytes(stream);
      expect(result.length).to.equal(0);
    });
  });

  describe('duplicateDataStream()', () => {
    it('should return an empty array when count is 0', () => {
      const stream = DataStream.fromBytes(new Uint8Array([1, 2, 3]));
      const result = DataStream.duplicateDataStream(stream, 0);
      expect(result).to.be.an('array');
      expect(result.length).to.equal(0);
    });

    it('should return the original stream when count is 1', () => {
      const stream = DataStream.fromBytes(new Uint8Array([1, 2, 3]));
      const result = DataStream.duplicateDataStream(stream, 1);
      expect(result.length).to.equal(1);
      expect(result[0]).to.equal(stream);
    });

    it('should return two independently consumable streams when count is 2', async () => {
      const data = TestDataGenerator.randomBytes(1000);
      const stream = DataStream.fromBytes(data);
      const [copy1, copy2] = DataStream.duplicateDataStream(stream, 2);

      const bytes1 = await DataStream.toBytes(copy1);
      const bytes2 = await DataStream.toBytes(copy2);

      expect(bytes1).to.deep.equal(data);
      expect(bytes2).to.deep.equal(data);
    });

    it('should return N independently consumable streams when count > 2', async () => {
      const data = TestDataGenerator.randomBytes(5000);
      const stream = DataStream.fromBytes(data);
      const copies = DataStream.duplicateDataStream(stream, 4);

      expect(copies.length).to.equal(4);

      for (const copy of copies) {
        const bytes = await DataStream.toBytes(copy);
        expect(bytes).to.deep.equal(data);
      }
    });

    it('should handle an empty source stream', async () => {
      const stream = DataStream.fromBytes(new Uint8Array(0));
      const [copy1, copy2] = DataStream.duplicateDataStream(stream, 2);

      const bytes1 = await DataStream.toBytes(copy1);
      const bytes2 = await DataStream.toBytes(copy2);

      expect(bytes1.length).to.equal(0);
      expect(bytes2.length).to.equal(0);
    });

    it('should handle large data with count = 3', async () => {
      const data = TestDataGenerator.randomBytes(500_000);
      const stream = DataStream.fromBytes(data);
      const copies = DataStream.duplicateDataStream(stream, 3);

      expect(copies.length).to.equal(3);

      for (const copy of copies) {
        const bytes = await DataStream.toBytes(copy);
        expect(bytes).to.deep.equal(data);
      }
    });
  });
});
