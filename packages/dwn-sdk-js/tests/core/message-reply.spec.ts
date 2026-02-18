import type { GenericMessageReply } from '../../src/types/message-types.js';

import { messageReplyFromError } from '../../src/core/message-reply.js';
import { describe, expect, it } from 'bun:test';

describe('Message Reply', () => {
  it('handles non-Errors being thrown', () => {
    let response: GenericMessageReply;
    try {
      throw 'Some error message';
    } catch (e: unknown) {
      response = messageReplyFromError(e, 500);
    }
    expect(response.status.code).toBe(500);
    expect(response.status.detail).toBe('Error');
  });
});
