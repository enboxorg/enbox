import type { DerivedPrivateJwk, RecordsWriteDescriptor, RecordsWriteMessage } from '../../src/index.js';

import { describe, expect, it } from 'bun:test';

import { DateSort } from '../../src/types/records-types.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { ed25519 } from '../../src/jose/algorithms/signing/ed25519.js';
import { SortDirection } from '../../src/types/query-types.js';
import { DwnInterfaceName, DwnMethodName, KeyDerivationScheme, Records } from '../../src/index.js';

describe('Records', () => {
  describe('deriveLeafPrivateKey()', () => {
    it('should throw if given private key is not supported', async () => {
      const derivedKey: DerivedPrivateJwk = {
        rootKeyId         : 'unused',
        derivationScheme  : KeyDerivationScheme.ProtocolPath,
        derivedPrivateKey : (await ed25519.generateKeyPair()).privateJwk
      };
      await expect(Records.derivePrivateKey(derivedKey, ['a'])).rejects.toThrow(DwnErrorCode.RecordsDerivePrivateKeyUnSupportedCurve);
    });
  });

  describe('constructKeyDerivationPathUsingProtocolPathScheme()', () => {
    it('should construct a valid key derivation path using protocol path scheme', async () => {
      const descriptor: RecordsWriteDescriptor = {
        interface        : DwnInterfaceName.Records,
        method           : DwnMethodName.Write,
        dataCid          : 'anyCid',
        dataFormat       : 'application/json',
        dataSize         : 123,
        dateCreated      : '2022-12-19T10:20:30.123456Z',
        messageTimestamp : '2022-12-19T10:20:30.123456Z',
        protocol         : 'http://test-protocol.xyz',
        protocolPath     : 'testRecord',
      };

      const path = Records.constructKeyDerivationPathUsingProtocolPathScheme(descriptor);
      expect(path).toEqual([KeyDerivationScheme.ProtocolPath, 'http://test-protocol.xyz', 'testRecord']);
    });

    it('should throw a scheme-specific error for unsupported derivation schemes', () => {
      const message = {
        descriptor: {
          interface        : DwnInterfaceName.Records,
          method           : DwnMethodName.Write,
          dataCid          : 'anyCid',
          dataFormat       : 'application/json',
          dataSize         : 123,
          dateCreated      : '2022-12-19T10:20:30.123456Z',
          messageTimestamp : '2022-12-19T10:20:30.123456Z',
          protocol         : 'http://test-protocol.xyz',
          protocolPath     : 'testRecord',
        },
      };

      expect(
        () => Records.constructKeyDerivationPath('unsupported' as KeyDerivationScheme, message as RecordsWriteMessage)
      ).toThrow(DwnErrorCode.RecordsDecryptUnsupportedKeyDerivationScheme);
    });
  });

  describe('convertDateSort()', () => {
    it('should return messageTimestamp descending when no dateSort is given', () => {
      const result = Records.convertDateSort(undefined);
      expect(result).toEqual({ messageTimestamp: SortDirection.Descending });
    });

    it('should map CreatedAscending to dateCreated ascending', () => {
      const result = Records.convertDateSort(DateSort.CreatedAscending);
      expect(result).toEqual({ dateCreated: SortDirection.Ascending });
    });

    it('should map CreatedDescending to dateCreated descending', () => {
      const result = Records.convertDateSort(DateSort.CreatedDescending);
      expect(result).toEqual({ dateCreated: SortDirection.Descending });
    });

    it('should map PublishedAscending to datePublished ascending', () => {
      const result = Records.convertDateSort(DateSort.PublishedAscending);
      expect(result).toEqual({ datePublished: SortDirection.Ascending });
    });

    it('should map PublishedDescending to datePublished descending', () => {
      const result = Records.convertDateSort(DateSort.PublishedDescending);
      expect(result).toEqual({ datePublished: SortDirection.Descending });
    });

    it('should map UpdatedAscending to messageTimestamp ascending', () => {
      const result = Records.convertDateSort(DateSort.UpdatedAscending);
      expect(result).toEqual({ messageTimestamp: SortDirection.Ascending });
    });

    it('should map UpdatedDescending to messageTimestamp descending', () => {
      const result = Records.convertDateSort(DateSort.UpdatedDescending);
      expect(result).toEqual({ messageTimestamp: SortDirection.Descending });
    });
  });

  describe('convertFilter()', () => {
    it('should lower contextId to a segment-aware subtree filter', () => {
      const result = Records.convertFilter({
        contextId    : 'root/branch',
        protocolPath : 'root/branch/leaf',
      });

      expect(result).toEqual({
        contextId    : { subtree: 'root/branch' },
        protocolPath : 'root/branch/leaf',
      });
    });
  });
});
