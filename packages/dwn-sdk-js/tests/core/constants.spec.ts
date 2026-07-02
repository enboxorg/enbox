import { describe, expect, it } from 'bun:test';

import {
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  ENCRYPTION_CONTROL_DELIVERY_PATH,
  ENCRYPTION_CONTROL_PATHS,
  ENCRYPTION_CONTROL_ROOT_PATH,
  ENCRYPTION_PROTOCOL_URI,
  EncryptionControlRecordType,
  getEncryptionControlRecordType,
  isEncryptionControlPath,
  isRecordsPrimaryProjectionExcludedProtocol,
  PERMISSIONS_PROTOCOL_URI,
} from '../../src/core/constants.js';

describe('core constants', () => {
  describe('encryption control paths', () => {
    it('should identify exact reserved encryption control paths', () => {
      expect(ENCRYPTION_CONTROL_ROOT_PATH).toBe('$encryption');
      expect(ENCRYPTION_CONTROL_AUDIENCE_PATH).toBe('$encryption/audience');
      expect(ENCRYPTION_CONTROL_DELIVERY_PATH).toBe('$encryption/delivery');
      expect(ENCRYPTION_CONTROL_PATHS).toEqual([
        ENCRYPTION_CONTROL_AUDIENCE_PATH,
        ENCRYPTION_CONTROL_DELIVERY_PATH,
      ]);

      expect(isEncryptionControlPath(ENCRYPTION_CONTROL_AUDIENCE_PATH)).toBe(true);
      expect(isEncryptionControlPath(ENCRYPTION_CONTROL_DELIVERY_PATH)).toBe(true);
      expect(getEncryptionControlRecordType(ENCRYPTION_CONTROL_AUDIENCE_PATH)).toBe(EncryptionControlRecordType.Audience);
      expect(getEncryptionControlRecordType(ENCRYPTION_CONTROL_DELIVERY_PATH)).toBe(EncryptionControlRecordType.Delivery);
    });

    it('should reject undefined, root-only, and lookalike encryption control paths', () => {
      expect(isEncryptionControlPath(undefined)).toBe(false);
      expect(isEncryptionControlPath(ENCRYPTION_CONTROL_ROOT_PATH)).toBe(false);
      expect(isEncryptionControlPath('$encryptionx/audience')).toBe(false);
      expect(isEncryptionControlPath('$encryption/audience/child')).toBe(false);
      expect(isEncryptionControlPath('$encryption/delivery/child')).toBe(false);
    });
  });

  describe('primary projection exclusions', () => {
    it('should exclude only infrastructure protocols from primary record projections', () => {
      expect(isRecordsPrimaryProjectionExcludedProtocol(ENCRYPTION_PROTOCOL_URI)).toBe(true);
      expect(isRecordsPrimaryProjectionExcludedProtocol(PERMISSIONS_PROTOCOL_URI)).toBe(true);
      expect(isRecordsPrimaryProjectionExcludedProtocol(undefined)).toBe(false);
      expect(isRecordsPrimaryProjectionExcludedProtocol('https://example.com/protocol')).toBe(false);
    });
  });
});
