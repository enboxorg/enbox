import { describe, expect, it } from 'bun:test';

import {
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  ENCRYPTION_CONTROL_DELIVERY_PATH,
  ENCRYPTION_CONTROL_PATHS,
  ENCRYPTION_CONTROL_ROOT_PATH,
  isEncryptionControlPath,
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
    });

    it('should reject undefined, root-only, and lookalike encryption control paths', () => {
      expect(isEncryptionControlPath(undefined)).toBe(false);
      expect(isEncryptionControlPath(ENCRYPTION_CONTROL_ROOT_PATH)).toBe(false);
      expect(isEncryptionControlPath('$encryptionx/audience')).toBe(false);
      expect(isEncryptionControlPath('$encryption/audience/child')).toBe(false);
      expect(isEncryptionControlPath('$encryption/delivery/child')).toBe(false);
    });
  });
});
