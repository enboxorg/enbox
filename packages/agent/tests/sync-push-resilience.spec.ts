import { describe, expect, test } from 'bun:test';

import { isPermanentPushFailure } from '../src/sync-messages.js';
import type { UnionMessageReply } from '@enbox/dwn-sdk-js';

describe('isPermanentPushFailure', () => {
  test('401 is permanent', () => {
    expect(isPermanentPushFailure({ status: { code: 401, detail: 'Unauthorized' } } as UnionMessageReply)).toBe(true);
  });

  test('403 is permanent', () => {
    expect(isPermanentPushFailure({ status: { code: 403, detail: 'Forbidden' } } as UnionMessageReply)).toBe(true);
  });

  test('400 with generic detail is permanent', () => {
    expect(isPermanentPushFailure({ status: { code: 400, detail: 'RecordLimitExceeded' } } as UnionMessageReply)).toBe(true);
  });

  test('400 with ComposedProtocolNotInstalled is transient', () => {
    const reply = {
      status: {
        code   : 400,
        detail : 'ProtocolsConfigureComposedProtocolNotInstalled: composed protocol \'social-graph\' not installed',
      },
    } as UnionMessageReply;
    expect(isPermanentPushFailure(reply)).toBe(false);
  });

  test('400 with ProtocolNotFound is transient', () => {
    const reply = {
      status: {
        code   : 400,
        detail : 'ProtocolAuthorizationProtocolNotFound: unable to find protocol definition for https://identity.foundation/protocols/profile',
      },
    } as UnionMessageReply;
    expect(isPermanentPushFailure(reply)).toBe(false);
  });

  test('500 is transient (not permanent)', () => {
    expect(isPermanentPushFailure({ status: { code: 500, detail: 'Internal Server Error' } } as UnionMessageReply)).toBe(false);
  });

  test('200 is not permanent', () => {
    expect(isPermanentPushFailure({ status: { code: 200, detail: 'OK' } } as UnionMessageReply)).toBe(false);
  });

  test('400 with no detail is permanent', () => {
    expect(isPermanentPushFailure({ status: { code: 400 } } as UnionMessageReply)).toBe(true);
  });
});
