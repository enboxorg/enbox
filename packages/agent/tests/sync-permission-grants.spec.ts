import { DwnConstant } from '@enbox/dwn-sdk-js';
import { describe, expect, it } from 'bun:test';

import { toMessagesPermissionGrantIds } from '../src/sync-permission-grants.js';

describe('Sync permission grants', () => {
  it('enforces the Messages grant cardinality limit after deduplication', () => {
    const grantIds = Array.from(
      { length: DwnConstant.maxFilterValues },
      (_, index) => `grant-${index.toString().padStart(3, '0')}`,
    );

    expect(toMessagesPermissionGrantIds([...grantIds, grantIds[0]])).toEqual(grantIds);
    expect(() => toMessagesPermissionGrantIds([...grantIds, 'grant-extra']))
      .toThrow(`Messages requests support at most ${DwnConstant.maxFilterValues} permission grant IDs`);
  });
});
