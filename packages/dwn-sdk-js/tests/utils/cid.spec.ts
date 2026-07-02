import * as block from 'multiformats/block';
import * as cbor from '@ipld/dag-cbor';

import { describe, expect, it } from 'bun:test';

import { Cid } from '../../src/utils/cid.js';
import { DataStream } from '../../src/index.js';
import { sha256 } from 'multiformats/hashes/sha2';
import { TestDataGenerator } from '../utils/test-data-generator.js';

describe('CID', () => {
  it('should yield the same CID using either computeDagPbCidFromBytes() & computeDagPbCidFromStream()', async () => {
    const randomBytes = TestDataGenerator.randomBytes(500_000);
    const randomByteStream = await DataStream.fromBytes(randomBytes);

    const cid1 = await Cid.computeDagPbCidFromBytes(randomBytes);
    const cid2 = await Cid.computeDagPbCidFromStream(randomByteStream);
    expect(cid1).toBe(cid2);
  });

  it('should keep known DAG-PB UnixFS CIDs stable', async () => {
    const smallFixtureBytes = new TextEncoder().encode('Enbox CID stability fixture\n');
    const largeFixtureBytes = Uint8Array.from({ length: 300_000 }, (_value, index): number => index % 251);

    await expect(Cid.computeDagPbCidFromBytes(smallFixtureBytes)).resolves.toBe(
      'bafkreib733ql5jolkcezal2z66wtyosmhe22ic6ii2f5vgiyobwuiovpmi'
    );
    await expect(Cid.computeDagPbCidFromBytes(largeFixtureBytes)).resolves.toBe(
      'bafybeih7gz5kvvg2zafb7vue6izhy6c4tglvwpi3rgunwdag2fidn2y6eq'
    );
  });

  describe('computeCid', () => {
    it('throws an error if codec is not supported', async () => {
      const unsupportedCodec = 99999;
      const anyTestData = {
        a: TestDataGenerator.randomString(32),
      };
      const computeCidPromise = Cid.computeCid(anyTestData, 99999);
      await expect(computeCidPromise).rejects.toThrow(`codec [${unsupportedCodec}] not supported`);
    });

    it('throws an error if multihasher is not supported', async () => {
      const unsupportedHashAlgorithm = 99999;
      const anyTestData = {
        a: TestDataGenerator.randomString(32),
      };
      const computeCidPromise = Cid.computeCid(anyTestData, 113, 99999); // 113 = CBOR
      await expect(computeCidPromise).rejects.toThrow(`multihash code [${unsupportedHashAlgorithm}] not supported`);
    });

    it('should by default generate a CBOR SHA256 CID identical to IPFS block encoding algorithm', async () => {
      const anyTestData = {
        a : TestDataGenerator.randomString(32),
        b : TestDataGenerator.randomString(32),
        c : TestDataGenerator.randomString(32)
      };
      const generatedCid = await Cid.computeCid(anyTestData);
      const encodedBlock = await block.encode({ value: anyTestData, codec: cbor, hasher: sha256 });

      expect(generatedCid).toBe(encodedBlock.cid.toString());
    });

    it('should keep known DAG-CBOR SHA-256 CIDs stable', async () => {
      const fixtureData = {
        z    : 'last',
        a    : { b: 2 },
        list : [true, 'enbox', 17],
        nil  : null
      };

      await expect(Cid.computeCid(fixtureData)).resolves.toBe(
        'bafyreiejbjoyi4jirr7ikcms3l7no5wav52a2h6om3a6xacd4fceeh5asy'
      );
    });

    it('should canonicalize JSON input before hashing', async () => {
      const data1 = {
        a : 'a',
        b : 'b',
        c : 'c'
      };

      const data2 = {
        b : 'b',
        c : 'c',
        a : 'a'
      };
      const cid1 = await Cid.computeCid(data1);
      const cid2 = await Cid.computeCid(data2);

      expect(cid1).toBe(cid2);
    });
  });

  describe('parseCid', () => {
    it('throws an error if codec is not supported', async () => {
      expect(() => Cid.parseCid('bafybeihzdcfjv55kxiz7sxwxaxbnjgj7rm2amvrxpi67jpwkgygjzoh72y')).toThrow('codec [112] not supported'); // a DAG-PB CID
    });

    it('throws an error if multihasher is not supported', async () => {
      expect(() => Cid.parseCid('bafy2bzacec2qlo3cohxyaoulipd3hurlq6pspvmpvmnmqsxfg4vbumpq3ufag')).toThrow('multihash code [45600] not supported'); // 45600 = BLAKE2b-256 CID
    });
  });
});
